import { SliverClient } from "../client";
import type { ReversePortForward } from "../forwarding";

describe("stateful reverse port forwarding", () => {
  test("starts with server-owned authorization metadata and closes idempotently", async () => {
    const rpc = reverseRpc({
      startRportFwdListener: jest.fn(async () => ({
        ID: 17,
        BindAddress: "0.0.0.0:3389",
        ForwardAddress: "[2001:db8::10]:13389",
        AuthorizationID: "server-secret-capability",
        Response: { Err: "" },
      })),
    });
    const client = clientWithControl(rpc);
    const forward = await client.startReversePortForward("  session-rport  ", {
      bind: { host: "0.0.0.0", port: 3389 },
      target: { host: "2001:db8::10", port: 13389 },
      keepAliveSeconds: 45,
    });

    expect(rpc.startRportFwdListener).toHaveBeenCalledWith({
      BindAddress: "0.0.0.0:3389",
      BindPort: 0,
      ForwardPort: 0,
      ForwardAddress: "[2001:db8::10]:13389",
      KeepAlive: 45,
      AuthorizationID: "",
      Request: { Async: false, Timeout: "29999999999", BeaconID: "", SessionID: "session-rport" },
    }, { signal: expect.any(AbortSignal) });
    expect(forward).toMatchObject({
      id: 17,
      sessionId: "session-rport",
      bind: { host: "0.0.0.0", port: 3389 },
      target: { host: "2001:db8::10", port: 13389 },
      state: { status: "listening" },
    });
    expect(Object.prototype.hasOwnProperty.call(forward, "authorizationId")).toBe(false);

    const reentrantCloses: Promise<void>[] = [];
    const completed = jest.fn();
    const subscription = forward.state$.subscribe({
      next: (state) => {
        if (state.status === "stopping") reentrantCloses.push(forward.close());
      },
      complete: completed,
    });
    const firstClose = forward.close();
    const secondClose = forward.close();
    expect(firstClose).toBe(secondClose);
    expect(reentrantCloses).toHaveLength(1);
    expect(reentrantCloses[0]).toBe(firstClose);
    await firstClose;
    expect(rpc.stopRportFwdListener).toHaveBeenCalledTimes(1);
    expect(forward.state).toEqual({ status: "stopped", reason: "requested" });
    expect(forward.close()).toBe(firstClose);
    expect(completed).toHaveBeenCalledTimes(1);
    const lateNext = jest.fn();
    const lateComplete = jest.fn();
    forward.state$.subscribe({ next: lateNext, complete: lateComplete });
    expect(lateNext).not.toHaveBeenCalled();
    expect(lateComplete).toHaveBeenCalledTimes(1);
    subscription.unsubscribe();
  });

  test("rejects mismatched response metadata without stopping its unowned listener id", async () => {
    const startRportFwdListener = jest.fn()
      .mockResolvedValueOnce({
        ...listener(24),
        BindAddress: "0.0.0.0:4444",
      })
      .mockResolvedValueOnce({
        ...listener(25),
        ForwardAddress: "127.0.0.1:9090",
      });
    const rpc = reverseRpc({ startRportFwdListener });
    const client = clientWithControl(rpc);
    const options = {
      bind: { host: "127.0.0.1", port: 4444 },
      target: { host: "127.0.0.1", port: 8080 },
    } as const;

    await expect(client.startReversePortForward("session-response-bind", options))
      .rejects.toThrow("Invalid reverse port forward response");
    await expect(client.startReversePortForward("session-response-target", options))
      .rejects.toThrow("Invalid reverse port forward response");
    expect(rpc.stopRportFwdListener).not.toHaveBeenCalled();
    expect(managedReverseCount(client)).toBe(0);
  });

  test("preserves the lifetime-abort reason while stopping exactly once", async () => {
    const lifetime = new AbortController();
    const rpc = reverseRpc({ startRportFwdListener: jest.fn(async () => listener(18)) });
    const client = clientWithControl(rpc);
    const forward = await client.startReversePortForward("session-lifetime", {
      bind: { host: "127.0.0.1", port: 4444 },
      target: { host: "127.0.0.1", port: 8080 },
      lifetimeSignal: lifetime.signal,
    });

    lifetime.abort();
    await waitFor(() => forward.state.status === "stopped");
    expect(forward.state).toEqual({ status: "stopped", reason: "aborted" });
    expect(rpc.stopRportFwdListener).toHaveBeenCalledTimes(1);
    expect(managedReverseCount(client)).toBe(0);
  });

  test("composes lifetime cancellation into a pending start RPC", async () => {
    const lifetime = new AbortController();
    let rpcSignal: AbortSignal | undefined;
    const startRportFwdListener = jest.fn(
      async (_request: unknown, call: { signal: AbortSignal }) => new Promise<never>((_resolve, reject) => {
        rpcSignal = call.signal;
        const cancel = () => reject(new Error("cancelled"));
        call.signal.addEventListener("abort", cancel, { once: true });
      }),
    );
    const client = clientWithControl(reverseRpc({ startRportFwdListener }));
    const starting = client.startReversePortForward("session-pending-lifetime", {
      bind: { host: "127.0.0.1", port: 4444 },
      target: { host: "127.0.0.1", port: 8080 },
      lifetimeSignal: lifetime.signal,
    }, { timeoutSeconds: 0 });
    await waitFor(() => rpcSignal !== undefined);

    lifetime.abort();
    await expect(starting).rejects.toThrow("lifetime was aborted during startup");
    expect(rpcSignal?.aborted).toBe(true);
    await expect(client.disconnect()).resolves.toBeUndefined();
  });

  test("retires a late successful start response after lifetime cancellation", async () => {
    const lifetime = new AbortController();
    const pending = deferred<ReturnType<typeof listener>>();
    let rpcSignal: AbortSignal | undefined;
    const rpc = reverseRpc({
      startRportFwdListener: jest.fn(async (_request: unknown, call: { signal: AbortSignal }) => {
        rpcSignal = call.signal;
        return pending.promise;
      }),
    });
    const client = clientWithControl(rpc);
    const starting = client.startReversePortForward("session-late-lifetime", {
      bind: { host: "127.0.0.1", port: 4444 },
      target: { host: "127.0.0.1", port: 8080 },
      lifetimeSignal: lifetime.signal,
    }, { timeoutSeconds: 0 });
    await waitFor(() => rpcSignal !== undefined);

    lifetime.abort();
    expect(rpcSignal?.aborted).toBe(true);
    pending.resolve(listener(29));
    await expect(starting).rejects.toThrow("lifetime was aborted during startup");
    expect(rpc.stopRportFwdListener).toHaveBeenCalledWith({
      ID: 29,
      Request: { Async: false, Timeout: "4999999999", BeaconID: "", SessionID: "session-late-lifetime" },
    }, { signal: expect.any(AbortSignal) });
    expect(managedReverseCount(client)).toBe(0);
  });

  test("retires a late successful start response after operation cancellation", async () => {
    const operation = new AbortController();
    const pending = deferred<ReturnType<typeof listener>>();
    let rpcSignal: AbortSignal | undefined;
    const rpc = reverseRpc({
      startRportFwdListener: jest.fn(async (_request: unknown, call: { signal: AbortSignal }) => {
        rpcSignal = call.signal;
        return pending.promise;
      }),
    });
    const client = clientWithControl(rpc);
    const starting = client.startReversePortForward("session-late-operation", {
      bind: { host: "127.0.0.1", port: 4444 },
      target: { host: "127.0.0.1", port: 8080 },
    }, { timeoutSeconds: 0, signal: operation.signal });
    await waitFor(() => rpcSignal !== undefined);

    operation.abort();
    expect(rpcSignal?.aborted).toBe(true);
    pending.resolve(listener(30));
    await expect(starting).rejects.toThrow("Forwarding operation was aborted");
    expect(rpc.stopRportFwdListener).toHaveBeenCalledWith({
      ID: 30,
      Request: { Async: false, Timeout: "4999999999", BeaconID: "", SessionID: "session-late-operation" },
    }, { signal: expect.any(AbortSignal) });
    expect(managedReverseCount(client)).toBe(0);
  });

  test("does not stop an unowned late response after operation cancellation", async () => {
    const operation = new AbortController();
    const pending = deferred<ReturnType<typeof listener>>();
    const rpc = reverseRpc({
      startRportFwdListener: jest.fn(async () => pending.promise),
    });
    const client = clientWithControl(rpc);
    const starting = client.startReversePortForward("session-late-mismatch", {
      bind: { host: "127.0.0.1", port: 4444 },
      target: { host: "127.0.0.1", port: 8080 },
    }, { timeoutSeconds: 0, signal: operation.signal });
    await waitFor(() => rpc.startRportFwdListener.mock.calls.length === 1);

    operation.abort();
    pending.resolve({ ...listener(30), BindAddress: "127.0.0.1:5555" });
    await expect(starting).rejects.toThrow("Forwarding operation was aborted");
    expect(rpc.stopRportFwdListener).not.toHaveBeenCalled();
    expect(managedReverseCount(client)).toBe(0);
  });

  test("does not stop an existing managed generation on a late exact response", async () => {
    const operation = new AbortController();
    const pending = deferred<ReturnType<typeof listener>>();
    const startRportFwdListener = jest.fn()
      .mockResolvedValueOnce(listener(34))
      .mockImplementationOnce(async () => pending.promise);
    const rpc = reverseRpc({ startRportFwdListener });
    const client = clientWithControl(rpc);
    const options = {
      bind: { host: "127.0.0.1", port: 4444 },
      target: { host: "127.0.0.1", port: 8080 },
    } as const;
    const owner = await client.startReversePortForward("session-late-owner", options);
    const duplicate = client.startReversePortForward(
      "session-late-owner",
      options,
      { timeoutSeconds: 0, signal: operation.signal },
    );
    await waitFor(() => startRportFwdListener.mock.calls.length === 2);

    operation.abort();
    pending.resolve(listener(34));
    await expect(duplicate).rejects.toThrow("Forwarding operation was aborted");
    expect(rpc.stopRportFwdListener).not.toHaveBeenCalled();
    expect(owner.state).toEqual({ status: "listening" });
    expect(managedReverseHandle(client, "session-late-owner", 34)).toBe(owner);

    await owner.close();
    expect(rpc.stopRportFwdListener).toHaveBeenCalledTimes(1);
    expect(managedReverseCount(client)).toBe(0);
  });

  test("returns to detached after a failed stop and permits a clean retry", async () => {
    const stopRportFwdListener = jest.fn()
      .mockRejectedValueOnce(new Error("TOP-SECRET-CONTROL-DETAIL"))
      .mockResolvedValueOnce({ ID: 19, Response: { Err: "" } });
    const rpc = reverseRpc({
      startRportFwdListener: jest.fn(async () => listener(19)),
      stopRportFwdListener,
    });
    const client = clientWithControl(rpc);
    const forward = await client.startReversePortForward("session-retry", {
      bind: { host: "127.0.0.1", port: 4444 },
      target: { host: "127.0.0.1", port: 8080 },
    });

    await expect(forward.close()).rejects.toThrow("Unable to stop reverse port forward");
    expect(forward.state).toEqual({ status: "detached", reason: "control-error" });
    await expect(forward.close()).resolves.toBeUndefined();
    expect(forward.state).toEqual({ status: "stopped", reason: "requested" });
    expect(stopRportFwdListener).toHaveBeenCalledTimes(2);
  });

  test("maps authoritative and compatibility-only inventory and makes stop idempotent", async () => {
    const getRportFwdListeners = jest.fn()
      .mockResolvedValueOnce({
        Listeners: [
          { ID: 9, BindAddress: "", ForwardAddress: "", Response: { Err: "" } },
          { ID: 3, BindAddress: "127.0.0.1:8080", ForwardAddress: "target.example:80", Response: { Err: "" } },
          { ID: 0, BindAddress: "127.0.0.1:1", ForwardAddress: "target.example:1", Response: { Err: "" } },
        ],
        Response: { Err: "" },
      })
      .mockResolvedValueOnce({ Listeners: [], Response: { Err: "" } });
    const rpc = reverseRpc({
      getRportFwdListeners,
      stopRportFwdListener: jest.fn(async () => ({ ID: 9, Response: { Err: "Invalid ID\n" } })),
    });
    const client = clientWithControl(rpc);

    await expect(client.listReversePortForwards("  session-list  ", { timeoutSeconds: 7 })).resolves.toEqual([
      {
        id: 3,
        sessionId: "session-list",
        bind: { host: "127.0.0.1", port: 8080 },
        target: { host: "target.example", port: 80 },
      },
      { id: 9, sessionId: "session-list", bind: null, target: null },
    ]);
    await expect(client.stopReversePortForward("  session-list  ", 9, { timeoutSeconds: 7 })).resolves.toBeUndefined();
    expect(rpc.stopRportFwdListener).toHaveBeenCalledWith({
      ID: 9,
      Request: { Async: false, Timeout: "6999999999", BeaconID: "", SessionID: "session-list" },
    }, { signal: expect.any(AbortSignal) });
  });

  test("detaches without stopping on operator disconnect, then reconciles or reports loss", async () => {
    const rpc = reverseRpc({
      startRportFwdListener: jest.fn(async () => listener(21)),
      getRportFwdListeners: jest.fn(async () => ({ Listeners: [listener(21)], Response: { Err: "" } })),
    });
    const client = clientWithControl(rpc);
    const forward = await client.startReversePortForward("session-reconnect", {
      bind: { host: "127.0.0.1", port: 4444 },
      target: { host: "127.0.0.1", port: 8080 },
    });

    await client.disconnect();
    expect(forward.state).toEqual({ status: "detached", reason: "client-disconnected" });
    expect(rpc.stopRportFwdListener).not.toHaveBeenCalled();

    reconnectInternals(client, rpc);
    await reconcileInternals(client);
    expect(forward.state).toEqual({ status: "listening" });

    rpc.getRportFwdListeners.mockResolvedValueOnce({ Listeners: [], Response: { Err: "" } });
    await expect(forward.refresh()).resolves.toEqual({ status: "lost", reason: "remote-missing" });
    expect(forward.state).toEqual({ status: "lost", reason: "remote-missing" });
  });

  test("a stale terminal callback cannot delete a replacement handle generation", async () => {
    const rpc = reverseRpc({
      startRportFwdListener: jest.fn(async () => listener(33)),
    });
    const client = clientWithControl(rpc);
    const options = {
      bind: { host: "127.0.0.1", port: 4444 },
      target: { host: "127.0.0.1", port: 8080 },
    } as const;
    const stale = await client.startReversePortForward("session-generation", options);
    const replacement = await client.startReversePortForward("session-generation", options);

    expect(managedReverseHandle(client, "session-generation", 33)).toBe(replacement);
    await stale.close();
    expect(stale.state).toEqual({ status: "stopped", reason: "requested" });
    expect(rpc.stopRportFwdListener).not.toHaveBeenCalled();
    expect(managedReverseHandle(client, "session-generation", 33)).toBe(replacement);
    expect(managedReverseCount(client)).toBe(1);

    await replacement.close();
    expect(rpc.stopRportFwdListener).toHaveBeenCalledTimes(1);
    expect(managedReverseCount(client)).toBe(0);
  });

  test("publishes one authoritative exact-match refresh snapshot", async () => {
    const rpc = reverseRpc({
      startRportFwdListener: jest.fn(async () => listener(22)),
      getRportFwdListeners: jest.fn(async () => ({ Listeners: [listener(22)], Response: { Err: "" } })),
    });
    const client = clientWithControl(rpc);
    const forward = await client.startReversePortForward("session-refresh-once", {
      bind: { host: "127.0.0.1", port: 4444 },
      target: { host: "127.0.0.1", port: 8080 },
    });
    const statuses: string[] = [];
    forward.state$.subscribe((state) => statuses.push(state.status));

    await expect(forward.refresh()).resolves.toEqual({ status: "listening" });
    expect(statuses).toEqual(["listening", "listening"]);
  });

  test.each([
    {
      label: "different bind",
      replacement: { ID: 7, BindAddress: "127.0.0.1:5555", ForwardAddress: "127.0.0.1:8080", Response: { Err: "" } },
    },
    {
      label: "different target",
      replacement: { ID: 7, BindAddress: "127.0.0.1:4444", ForwardAddress: "127.0.0.1:9090", Response: { Err: "" } },
    },
    {
      label: "unverifiable legacy metadata",
      replacement: { ID: 7, BindAddress: "", ForwardAddress: "", Response: { Err: "" } },
    },
  ])("does not attach a stale handle to $label under a reused listener id", async ({ replacement }) => {
    const rpc = reverseRpc({
      startRportFwdListener: jest.fn(async () => listener(7)),
      getRportFwdListeners: jest.fn(async () => ({ Listeners: [replacement], Response: { Err: "" } })),
    });
    const client = clientWithControl(rpc);
    const forward = await client.startReversePortForward("session-reused", {
      bind: { host: "127.0.0.1", port: 4444 },
      target: { host: "127.0.0.1", port: 8080 },
    });

    await expect(forward.refresh()).resolves.toEqual({ status: "lost", reason: "identity-mismatch" });
    await expect(forward.close()).resolves.toBeUndefined();
    expect(rpc.stopRportFwdListener).not.toHaveBeenCalled();
    expect(managedReverseCount(client)).toBe(0);
  });

  test.each([
    {
      label: "replacement metadata",
      replacement: { ID: 31, BindAddress: "127.0.0.1:4444", ForwardAddress: "127.0.0.1:9090", Response: { Err: "" } },
    },
    {
      label: "legacy null metadata",
      replacement: { ID: 31, BindAddress: "", ForwardAddress: "", Response: { Err: "" } },
    },
  ])("does not stop $label when refresh and close overlap", async ({ replacement }) => {
    const inventory = deferred<{ Listeners: Array<typeof replacement>; Response: { Err: string } }>();
    const rpc = reverseRpc({
      startRportFwdListener: jest.fn(async () => listener(31)),
      getRportFwdListeners: jest.fn(async () => inventory.promise),
    });
    const client = clientWithControl(rpc);
    const forward = await client.startReversePortForward("session-overlap", {
      bind: { host: "127.0.0.1", port: 4444 },
      target: { host: "127.0.0.1", port: 8080 },
    });
    const statuses: string[] = [];
    forward.state$.subscribe((state) => statuses.push(state.status));

    const refresh = forward.refresh();
    await waitFor(() => rpc.getRportFwdListeners.mock.calls.length === 1);
    const close = forward.close();
    inventory.resolve({ Listeners: [replacement], Response: { Err: "" } });

    await expect(refresh).resolves.toEqual({ status: "lost", reason: "identity-mismatch" });
    await expect(close).resolves.toBeUndefined();
    expect(forward.state).toEqual({ status: "lost", reason: "identity-mismatch" });
    expect(rpc.stopRportFwdListener).not.toHaveBeenCalled();
    expect(statuses).toEqual(["listening", "stopping", "lost"]);
  });

  test("does not publish listening between an exact-match refresh and its queued stop", async () => {
    const inventory = deferred<{ Listeners: ReturnType<typeof listener>[]; Response: { Err: string } }>();
    const rpc = reverseRpc({
      startRportFwdListener: jest.fn(async () => listener(32)),
      getRportFwdListeners: jest.fn(async () => inventory.promise),
    });
    const client = clientWithControl(rpc);
    const forward = await client.startReversePortForward("session-overlap-exact", {
      bind: { host: "127.0.0.1", port: 4444 },
      target: { host: "127.0.0.1", port: 8080 },
    });
    const statuses: string[] = [];
    forward.state$.subscribe((state) => statuses.push(state.status));

    const refresh = forward.refresh();
    await waitFor(() => rpc.getRportFwdListeners.mock.calls.length === 1);
    const close = forward.close();
    inventory.resolve({ Listeners: [listener(32)], Response: { Err: "" } });

    await expect(refresh).resolves.toEqual({ status: "stopping", reason: "requested" });
    await expect(close).resolves.toBeUndefined();
    expect(forward.state).toEqual({ status: "stopped", reason: "requested" });
    expect(statuses).toEqual(["listening", "stopping", "stopped"]);
  });

  test("does not stop an unowned id whose response cannot produce a safe handle", async () => {
    const rpc = reverseRpc({
      startRportFwdListener: jest.fn(async () => ({
        ID: 23,
        BindAddress: "malformed-address",
        ForwardAddress: "127.0.0.1:8080",
        Response: { Err: "" },
      })),
    });
    const client = clientWithControl(rpc);

    await expect(client.startReversePortForward("session-invalid-response", {
      bind: { host: "127.0.0.1", port: 4444 },
      target: { host: "127.0.0.1", port: 8080 },
    })).rejects.toThrow("Invalid reverse port forward response");
    expect(rpc.stopRportFwdListener).not.toHaveBeenCalled();
  });

  test("validates before dispatch, honors abort, and never reflects target response details", async () => {
    const startRportFwdListener = jest.fn(async () => listener(1));
    const client = clientWithControl(reverseRpc({ startRportFwdListener }));
    await expect(client.startReversePortForward("session-invalid", {
      bind: { host: "127.0.0.1", port: 0 },
      target: { host: "127.0.0.1", port: 80 },
    })).rejects.toBeInstanceOf(RangeError);
    expect(startRportFwdListener).not.toHaveBeenCalled();

    const controller = new AbortController();
    controller.abort();
    await expect(client.startReversePortForward("session-abort", {
      bind: { host: "127.0.0.1", port: 4444 },
      target: { host: "127.0.0.1", port: 80 },
    }, { signal: controller.signal })).rejects.toThrow("Forwarding operation was aborted");
    expect(startRportFwdListener).not.toHaveBeenCalled();

    await expect(client.startReversePortForward("session-lifetime-abort", {
      bind: { host: "127.0.0.1", port: 4444 },
      target: { host: "127.0.0.1", port: 80 },
      lifetimeSignal: controller.signal,
    })).rejects.toThrow("Reverse port forward lifetime was already aborted");
    expect(startRportFwdListener).not.toHaveBeenCalled();

    startRportFwdListener.mockResolvedValueOnce({
      ID: 0,
      BindAddress: "",
      ForwardAddress: "",
      AuthorizationID: "TOP-SECRET-AUTHORIZATION",
      Response: { Err: "TOP-SECRET-TARGET-DETAIL" },
    });
    const rejected = client.startReversePortForward("session-reject", {
      bind: { host: "127.0.0.1", port: 4444 },
      target: { host: "127.0.0.1", port: 80 },
    });
    await expect(rejected).rejects.toThrow("Reverse port forward was rejected by the target");
    await expect(rejected).rejects.not.toThrow(/TOP-SECRET/u);
  });
});

function listener(id: number) {
  return {
    ID: id,
    BindAddress: "127.0.0.1:4444",
    ForwardAddress: "127.0.0.1:8080",
    AuthorizationID: "opaque-server-value",
    Response: { Err: "" },
  };
}

function reverseRpc(overrides: Record<string, unknown> = {}) {
  return {
    startRportFwdListener: jest.fn(async () => listener(1)),
    getRportFwdListeners: jest.fn(async () => ({ Listeners: [listener(1)], Response: { Err: "" } })),
    stopRportFwdListener: jest.fn(async (request: { ID: number }) => ({ ...listener(request.ID), Response: { Err: "" } })),
    ...overrides,
  } as {
    startRportFwdListener: jest.Mock;
    getRportFwdListeners: jest.Mock;
    stopRportFwdListener: jest.Mock;
  };
}

function clientWithControl(rpc: object): SliverClient {
  const client = new SliverClient({
    operator: "reverse-forward-test",
    token: "token",
    lhost: "127.0.0.1",
    lport: 31_337,
    ca_certificate: "ca",
    certificate: "certificate",
    private_key: "private-key",
  });
  reconnectInternals(client, rpc);
  return client;
}

function reconnectInternals(client: SliverClient, rpc: object): void {
  const internals = client as unknown as { rpcClients: Record<string, object> };
  internals.rpcClients.control = rpc;
}

function reconcileInternals(client: SliverClient): Promise<void> {
  return (client as unknown as { reconcileManagedReversePortForwards(): Promise<void> })
    .reconcileManagedReversePortForwards();
}

function managedReverseCount(client: SliverClient): number {
  return (client as unknown as { managedReversePortForwards: Map<string, unknown> })
    .managedReversePortForwards.size;
}

function managedReverseHandle(client: SliverClient, sessionId: string, listenerId: number): unknown {
  return (client as unknown as { managedReversePortForwards: Map<string, unknown> })
    .managedReversePortForwards.get(`${sessionId}\u0000${listenerId}`);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for reverse port-forward state");
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}
