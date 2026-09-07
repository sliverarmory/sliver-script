import { once } from "node:events";
import net, { type Socket } from "node:net";

import { SliverClient } from "../client";
import type { ForwardConnectionEvent, LocalForwardState, PortForward } from "../forwarding";
import type { PortForwardTunnelTransport } from "../internal/portForward";
import { TUNNEL_STREAM_MAX_PAYLOAD_BYTES } from "../messageBudget";
import type { DeepPartial } from "../pb/rpcpb/services";
import type { TunnelData } from "../pb/sliverpb/sliver";

const activeForwards = new Set<PortForward>();
const activeSockets = new Set<Socket>();

afterEach(async () => {
  for (const socket of activeSockets) socket.destroy();
  activeSockets.clear();
  await Promise.allSettled([...activeForwards].map((forward) => forward.close()));
  activeForwards.clear();
});

describe("stateful port forwarding", () => {
  test("waits for the exact tunnel bind acknowledgement before setup and relays both directions", async () => {
    const bind = deferred<void>();
    const transport = new FakeTunnelTransport();
    transport.bindGate = bind.promise;
    const rpc = rpcHarness();
    const client = clientWithForwarding(rpc, transport);
    const forward = await client.startPortForward("  session-1  ", {
      bind: { host: "127.0.0.1", port: 0 },
      target: { host: "target.internal", port: 8443 },
    });
    activeForwards.add(forward);
    const events: ForwardConnectionEvent[] = [];
    forward.connection$.subscribe((event) => events.push(event));

    const socket = await connect(forward);
    socket.write("early-client-data");
    await waitFor(() => transport.bindCalls.length === 1);
    expect(rpc.portfwd).not.toHaveBeenCalled();
    expect(transport.sent).toEqual([]);

    bind.resolve();
    await waitFor(() => rpc.portfwd.mock.calls.length === 1);
    expect(rpc.createTunnel).toHaveBeenCalledWith(
      { SessionID: "session-1" },
      { signal: expect.any(AbortSignal) },
    );
    expect(transport.bindCalls).toEqual([{ tunnelId: "tunnel-1", sessionId: "session-1" }]);
    expect(rpc.portfwd).toHaveBeenCalledWith({
      Host: "target.internal",
      Port: 8443,
      Protocol: 1,
      KeepAlive: 30,
      TunnelID: "tunnel-1",
      Request: { Async: false, Timeout: "29999999999", BeaconID: "", SessionID: "session-1" },
    }, { signal: expect.any(AbortSignal) });
    await waitFor(() => Buffer.concat(transport.sent.map((frame) => frame.data)).toString() === "early-client-data");

    const received = once(socket, "data");
    transport.receive("tunnel-1", Buffer.from("target-data"));
    expect(Buffer.from((await received)[0] as Buffer).toString()).toBe("target-data");
    await waitFor(() => events.some((event) => event.status === "open"));
    expect(forward.bind.port).toBeGreaterThan(0);
    expect(forward.state.bytesToTarget).toBe(Buffer.byteLength("early-client-data"));
    expect(forward.state.bytesFromTarget).toBe(Buffer.byteLength("target-data"));
  });

  test("chunks payloads, serializes transport backpressure, and clears operation-owned bytes", async () => {
    const transport = new FakeTunnelTransport();
    const firstSend = deferred<void>();
    transport.firstDataGate = firstSend.promise;
    const client = clientWithForwarding(rpcHarness(), transport);
    const forward = await client.startPortForward("session-chunks", {
      bind: { host: "127.0.0.1", port: 0 },
      target: { host: "127.0.0.1", port: 9000 },
    });
    activeForwards.add(forward);
    const socket = await connect(forward);
    await waitFor(() => forward.state.activeConnections === 1);

    const payload = Buffer.alloc((TUNNEL_STREAM_MAX_PAYLOAD_BYTES * 2) + 17, 0x5a);
    socket.write(payload);
    payload.fill(0);
    await waitFor(() => transport.pendingDataSend !== undefined);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.data.length).toBeLessThanOrEqual(TUNNEL_STREAM_MAX_PAYLOAD_BYTES);
    expect(transport.pendingDataSend!.every((byte) => byte === 0x5a)).toBe(true);

    firstSend.resolve();
    await waitFor(() => transport.sent.reduce((total, frame) => total + frame.data.length, 0)
      === (TUNNEL_STREAM_MAX_PAYLOAD_BYTES * 2) + 17);
    expect(transport.sent.every((frame) => frame.data.length <= TUNNEL_STREAM_MAX_PAYLOAD_BYTES)).toBe(true);
    await waitFor(() => transport.pendingDataSend!.every((byte) => byte === 0));
  });

  test("bounds concurrent accepted connections and closes idempotently", async () => {
    const createGate = deferred<void>();
    let tunnelSequence = 0;
    const rpc = rpcHarness({
      createTunnel: jest.fn(async (_request: unknown, options: { signal: AbortSignal }) => {
        await Promise.race([createGate.promise, aborted(options.signal)]);
        tunnelSequence += 1;
        return { TunnelID: `capacity-${tunnelSequence}`, SessionID: "session-capacity" };
      }),
    });
    const transport = new FakeTunnelTransport();
    const client = clientWithForwarding(rpc, transport);
    const forward = await client.startPortForward("session-capacity", {
      bind: { host: "127.0.0.1", port: 0 },
      target: { host: "127.0.0.1", port: 9001 },
      maxConnections: 2,
    });
    activeForwards.add(forward);
    const events: ForwardConnectionEvent[] = [];
    forward.connection$.subscribe((event) => events.push(event));

    const sockets = await Promise.all([connect(forward), connect(forward), connect(forward)]);
    await waitFor(() => events.some((event) => event.status === "rejected"));
    expect(forward.state.activeConnections).toBe(2);
    expect(forward.state.totalConnections).toBe(3);
    expect(events.find((event) => event.status === "rejected")?.reason).toBe("capacity");

    createGate.resolve();
    await waitFor(() => events.filter((event) => event.status === "open").length === 2);
    const firstClose = forward.close();
    const secondClose = forward.close();
    expect(firstClose).toBe(secondClose);
    await firstClose;
    expect(forward.state).toMatchObject({ status: "closed", activeConnections: 0, reason: "requested" });
    await waitFor(() => sockets.every((socket) => socket.destroyed));
    for (const socket of sockets) expect(socket.destroyed).toBe(true);
  });

  test("latches close before a synchronous state subscriber can reenter teardown", async () => {
    const client = clientWithForwarding(rpcHarness(), new FakeTunnelTransport());
    const forward = await client.startPortForward("session-reentrant-close", {
      bind: { host: "127.0.0.1", port: 0 },
      target: { host: "127.0.0.1", port: 8080 },
    });
    activeForwards.add(forward);
    const server = (forward as unknown as { server: net.Server }).server;
    const closeServer = jest.spyOn(server, "close");
    const statuses: LocalForwardState["status"][] = [];
    let reentrantClose: Promise<void> | undefined;
    let completions = 0;

    forward.state$.subscribe({
      next: (state) => {
        statuses.push(state.status);
        if (state.status === "closing" && !reentrantClose) reentrantClose = forward.close();
      },
      complete: () => { completions += 1; },
    });

    const close = forward.close();
    expect(reentrantClose).toBe(close);
    await close;

    expect(closeServer).toHaveBeenCalledTimes(1);
    expect(statuses.filter((status) => status === "closed")).toHaveLength(1);
    expect(completions).toBe(1);

    let lateValues = 0;
    let lateCompletions = 0;
    forward.state$.subscribe({
      next: () => { lateValues += 1; },
      complete: () => { lateCompletions += 1; },
    });
    expect(lateValues).toBe(0);
    expect(lateCompletions).toBe(1);
  });

  test("does not retire a live tunnel when later create responses duplicate its id or session", async () => {
    let createCalls = 0;
    const rpc = rpcHarness({
      createTunnel: jest.fn(async () => {
        createCalls += 1;
        return {
          TunnelID: "shared-tunnel",
          SessionID: createCalls === 3 ? "wrong-session" : "session-owned",
        };
      }),
    });
    const transport = new FakeTunnelTransport();
    const client = clientWithForwarding(rpc, transport);
    const forward = await client.startPortForward("session-owned", {
      bind: { host: "127.0.0.1", port: 0 },
      target: { host: "127.0.0.1", port: 8080 },
    });
    activeForwards.add(forward);
    const events: ForwardConnectionEvent[] = [];
    forward.connection$.subscribe((event) => events.push(event));

    const owner = await connect(forward);
    await waitFor(() => events.filter((event) => event.status === "open").length === 1);

    const duplicate = await connect(forward);
    await waitFor(() => events.filter((event) => event.status === "failed").length === 1);
    await waitFor(() => duplicate.destroyed);
    expect(transport.cancelCalls).toEqual([]);
    expect(rpc.closeTunnel).not.toHaveBeenCalled();

    const duplicateSurvived = once(owner, "data");
    transport.receive("shared-tunnel", Buffer.from("after-duplicate"));
    expect(Buffer.from((await duplicateSurvived)[0] as Buffer).toString()).toBe("after-duplicate");

    const wrongSession = await connect(forward);
    await waitFor(() => events.filter((event) => event.status === "failed").length === 2);
    await waitFor(() => wrongSession.destroyed);
    expect(transport.cancelCalls).toEqual([]);
    expect(rpc.closeTunnel).not.toHaveBeenCalled();

    const wrongSessionSurvived = once(owner, "data");
    transport.receive("shared-tunnel", Buffer.from("after-wrong-session"));
    expect(Buffer.from((await wrongSessionSurvived)[0] as Buffer).toString()).toBe("after-wrong-session");
  });

  test.each([
    ["host", { Host: "other.internal" }],
    ["port", { Port: 9_999 }],
  ])("contains a successful portfwd response with a mismatched %s", async (_field, mismatch) => {
    const rpc = rpcHarness({
      portfwd: jest.fn(async (request: { TunnelID: string; Host: string; Port: number; Protocol: number }) => ({
        TunnelID: request.TunnelID,
        Host: request.Host,
        Port: request.Port,
        Protocol: request.Protocol,
        ...mismatch,
      })),
    });
    const transport = new FakeTunnelTransport();
    const client = clientWithForwarding(rpc, transport);
    const forward = await client.startPortForward(`session-response-${_field}`, {
      bind: { host: "127.0.0.1", port: 0 },
      target: { host: "target.internal", port: 8443 },
    });
    activeForwards.add(forward);
    const events: ForwardConnectionEvent[] = [];
    forward.connection$.subscribe((event) => events.push(event));

    const socket = await connect(forward);
    await waitFor(() => events.some((event) => event.status === "failed"));
    await waitFor(() => socket.destroyed);

    expect(events.some((event) => event.status === "open")).toBe(false);
    expect(transport.cancelCalls).toEqual(["tunnel-1"]);
    expect(rpc.closeTunnel).toHaveBeenCalledTimes(1);
    expect(rpc.closeTunnel).toHaveBeenCalledWith(
      { TunnelID: "tunnel-1", SessionID: `session-response-${_field}` },
      { signal: expect.any(AbortSignal) },
    );
  });

  test("publishes one terminal failure only after active cleanup finishes", async () => {
    const closeGate = deferred<void>();
    const rpc = rpcHarness({
      closeTunnel: jest.fn(async () => closeGate.promise),
    });
    const transport = new FakeTunnelTransport();
    const client = clientWithForwarding(rpc, transport);
    const forward = await client.startPortForward("session-failure-lifecycle", {
      bind: { host: "127.0.0.1", port: 0 },
      target: { host: "127.0.0.1", port: 8080 },
    });
    activeForwards.add(forward);
    const states: LocalForwardState[] = [];
    forward.state$.subscribe((state) => states.push(state));
    await connect(forward);
    await waitFor(() => forward.state.activeConnections === 1 && rpc.portfwd.mock.calls.length === 1);

    transport.failTransport();
    expect(forward.state).toMatchObject({
      status: "closing",
      activeConnections: 1,
      reason: "transport-disconnected",
    });
    expect(states.filter((state) => state.status === "failed")).toHaveLength(0);

    await waitFor(() => rpc.closeTunnel.mock.calls.length === 1);
    expect(forward.state).toMatchObject({
      status: "closing",
      activeConnections: 1,
      reason: "transport-disconnected",
    });
    expect(states.filter((state) => state.status === "failed")).toHaveLength(0);

    closeGate.resolve();
    await waitFor(() => forward.state.status === "failed");
    const lifecycle = states.filter((state) => state.status === "closing" || state.status === "failed");
    expect(lifecycle.map((state) => [state.status, state.activeConnections, state.reason])).toEqual([
      ["closing", 1, "transport-disconnected"],
      ["closing", 0, "transport-disconnected"],
      ["failed", 0, "transport-disconnected"],
    ]);
    expect(states.filter((state) => state.status === "failed")).toHaveLength(1);
    expect(client.listPortForwards()).toEqual([]);
  });

  test("uses full tunnel close when portfwd responds after the local socket FIN", async () => {
    const responseGate = deferred<void>();
    const rpc = rpcHarness({
      portfwd: jest.fn(async (request: { TunnelID: string; Host: string; Port: number; Protocol: number }) => {
        await responseGate.promise;
        return {
          TunnelID: request.TunnelID,
          Host: request.Host,
          Port: request.Port,
          Protocol: request.Protocol,
        };
      }),
    });
    const transport = new FakeTunnelTransport();
    const send = jest.spyOn(transport, "send");
    const client = clientWithForwarding(rpc, transport);
    const forward = await client.startPortForward("session-local-fin", {
      bind: { host: "127.0.0.1", port: 0 },
      target: { host: "127.0.0.1", port: 8080 },
    });
    activeForwards.add(forward);
    const socket = await connect(forward);
    await waitFor(() => rpc.portfwd.mock.calls.length === 1);

    const finished = once(socket, "finish");
    socket.end();
    await finished;
    expect(rpc.closeTunnel).not.toHaveBeenCalled();

    responseGate.resolve();
    await waitFor(() => rpc.closeTunnel.mock.calls.length === 1);
    await waitFor(() => forward.state.activeConnections === 0);

    expect(send.mock.calls.some(([message]) => message.Closed === true)).toBe(false);
    expect(transport.cancelCalls).toEqual(["tunnel-1"]);
    expect(rpc.closeTunnel).toHaveBeenCalledWith(
      { TunnelID: "tunnel-1", SessionID: "session-local-fin" },
      { signal: expect.any(AbortSignal) },
    );
  });

  test("does not deliver a target response delayed until after local FIN", async () => {
    const transport = new FakeTunnelTransport();
    const rpc = rpcHarness();
    const client = clientWithForwarding(rpc, transport);
    const forward = await client.startPortForward("session-delayed-response", {
      bind: { host: "127.0.0.1", port: 0 },
      target: { host: "127.0.0.1", port: 8080 },
    });
    activeForwards.add(forward);
    const socket = await connect(forward);
    await waitFor(() => rpc.portfwd.mock.calls.length === 1);
    socket.write("request-before-fin");
    await waitFor(() => transport.sent.some((frame) => frame.data.toString() === "request-before-fin"));
    const received: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => received.push(Buffer.from(chunk)));

    const closed = once(socket, "close");
    socket.end();
    await closed;
    await waitFor(() => forward.state.activeConnections === 0);
    transport.receive("tunnel-1", Buffer.from("delayed-response"));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(Buffer.concat(received)).toEqual(Buffer.alloc(0));
    expect(transport.cancelCalls).toEqual(["tunnel-1"]);
    expect(rpc.closeTunnel).toHaveBeenCalledTimes(1);
  });

  test("lists and stops client-owned forwards by id with immutable snapshots", async () => {
    const client = clientWithForwarding(rpcHarness(), new FakeTunnelTransport());
    const forward = await client.startPortForward("session-registry", {
      bind: { host: "127.0.0.1", port: 0 },
      target: { host: "127.0.0.1", port: 8081 },
    });
    activeForwards.add(forward);

    const snapshot = client.listPortForwards();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot).toEqual([forward]);

    await client.stopPortForward(`  ${forward.id}  `);
    expect(forward.state).toMatchObject({ status: "closed", reason: "requested" });
    expect(client.listPortForwards()).toEqual([]);
    await expect(client.stopPortForward(forward.id)).resolves.toBeUndefined();
  });

  test("honors startup abort and client disconnect closes active local forwarding state", async () => {
    const abortedStart = new AbortController();
    abortedStart.abort();
    const abortedClient = clientWithForwarding(rpcHarness(), new FakeTunnelTransport());
    await expect(abortedClient.startPortForward("session-abort", {
      bind: { host: "127.0.0.1", port: 0 },
      target: { host: "127.0.0.1", port: 80 },
    }, { signal: abortedStart.signal })).rejects.toThrow();

    const transport = new FakeTunnelTransport();
    const rpc = rpcHarness();
    const client = clientWithForwarding(rpc, transport);
    const forward = await client.startPortForward("session-disconnect", {
      bind: { host: "127.0.0.1", port: 0 },
      target: { host: "127.0.0.1", port: 8080 },
    });
    activeForwards.add(forward);
    const socket = await connect(forward);
    await waitFor(() => forward.state.activeConnections === 1 && rpc.portfwd.mock.calls.length === 1);

    await client.disconnect();
    await waitFor(() => socket.destroyed);
    expect(transport.stop).toHaveBeenCalledTimes(1);
    expect(forward.state).toMatchObject({ status: "closed", activeConnections: 0, reason: "client-disconnected" });
    expect(socket.destroyed).toBe(true);
    expect(rpc.closeTunnel).toHaveBeenCalledWith(
      { TunnelID: "tunnel-1", SessionID: "session-disconnect" },
      { signal: expect.any(AbortSignal) },
    );
  });

  test("shared tunnel transport failure terminally retires even an idle listener", async () => {
    const transport = new FakeTunnelTransport();
    const client = clientWithForwarding(rpcHarness(), transport);
    const forward = await client.startPortForward("session-transport", {
      bind: { host: "127.0.0.1", port: 0 },
      target: { host: "127.0.0.1", port: 8080 },
    });
    activeForwards.add(forward);

    transport.failTransport();
    await waitFor(() => forward.state.status === "failed" && client.listPortForwards().length === 0);

    expect(forward.state).toMatchObject({
      status: "failed",
      activeConnections: 0,
      totalConnections: 0,
      reason: "transport-disconnected",
    });
    expect(client.listPortForwards()).toEqual([]);
    await expect(connect(forward)).rejects.toThrow();
  });

  test("does not return a listener when the shared tunnel transport already failed", async () => {
    const transport = new FakeTunnelTransport();
    transport.failTransport();
    const client = clientWithForwarding(rpcHarness(), transport);

    await expect(client.startPortForward("session-dead-transport", {
      bind: { host: "127.0.0.1", port: 0 },
      target: { host: "127.0.0.1", port: 8080 },
    })).rejects.toThrow("Unable to start port forward listener");
    expect(client.listPortForwards()).toEqual([]);
  });
});

class FakeTunnelTransport implements PortForwardTunnelTransport {
  readonly bindCalls: Array<{ tunnelId: string; sessionId: string }> = [];
  readonly cancelCalls: string[] = [];
  readonly sent: Array<{ tunnelId: string; data: Buffer }> = [];
  readonly stop = jest.fn(async () => undefined);
  bindGate: Promise<void> = Promise.resolve();
  firstDataGate: Promise<void> = Promise.resolve();
  pendingDataSend?: Uint8Array;
  private transportFailed = false;

  private readonly outputs = new Map<string, PushAsyncIterable<Uint8Array>>();
  private readonly transportFailureListeners = new Set<() => void>();

  onTransportFailure(listener: () => void): () => void {
    if (this.transportFailed) {
      listener();
      return () => undefined;
    }
    this.transportFailureListeners.add(listener);
    return () => this.transportFailureListeners.delete(listener);
  }

  openOutput(tunnelId: string): AsyncIterable<Uint8Array> {
    if (this.outputs.has(tunnelId)) throw new Error("Tunnel output is already registered");
    const output = new PushAsyncIterable<Uint8Array>();
    this.outputs.set(tunnelId, output);
    return output;
  }

  async bind(tunnelId: string, sessionId: string, signal?: AbortSignal): Promise<void> {
    this.bindCalls.push({ tunnelId, sessionId });
    await Promise.race([this.bindGate, aborted(signal)]);
  }

  async send(message: DeepPartial<TunnelData>): Promise<void> {
    const owned = message.Data;
    if (!owned || owned.length === 0) return;
    this.pendingDataSend ??= owned;
    const copy = Buffer.from(owned);
    this.sent.push({ tunnelId: message.TunnelID ?? "", data: copy });
    if (this.sent.length === 1) await this.firstDataGate;
  }

  cancelTunnel(tunnelId: string): void {
    this.cancelCalls.push(tunnelId);
    this.outputs.get(tunnelId)?.close();
    this.outputs.delete(tunnelId);
  }

  receive(tunnelId: string, data: Buffer): void {
    this.outputs.get(tunnelId)?.push(Uint8Array.from(data));
  }

  failTransport(): void {
    this.transportFailed = true;
    for (const listener of [...this.transportFailureListeners]) listener();
  }
}

class PushAsyncIterable<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private waiter: ((result: IteratorResult<T>) => void) | undefined;
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter({ value, done: false });
    } else {
      this.values.push(value);
    }
  }

  close(): void {
    this.closed = true;
    this.waiter?.({ value: undefined as never, done: true });
    this.waiter = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) return { value, done: false };
        if (this.closed) return { value: undefined as never, done: true };
        return new Promise((resolve) => { this.waiter = resolve; });
      },
    };
  }
}

function rpcHarness(overrides: Record<string, unknown> = {}) {
  let tunnelSequence = 0;
  return {
    createTunnel: jest.fn(async (request: { SessionID: string }) => {
      tunnelSequence += 1;
      return { TunnelID: `tunnel-${tunnelSequence}`, SessionID: request.SessionID };
    }),
    portfwd: jest.fn(async (request: { TunnelID: string; Host: string; Port: number; Protocol: number }) => ({
      TunnelID: request.TunnelID,
      Host: request.Host,
      Port: request.Port,
      Protocol: request.Protocol,
    })),
    closeTunnel: jest.fn(async () => ({})),
    ...overrides,
  } as {
    createTunnel: jest.Mock;
    portfwd: jest.Mock;
    closeTunnel: jest.Mock;
  };
}

function clientWithForwarding(rpc: object, transport: FakeTunnelTransport): SliverClient {
  const client = new SliverClient({
    operator: "forward-test",
    token: "token",
    lhost: "127.0.0.1",
    lport: 31_337,
    ca_certificate: "ca",
    certificate: "certificate",
    private_key: "private-key",
  });
  const internals = client as unknown as {
    rpcClients: Record<string, object>;
    tunnels: FakeTunnelTransport;
  };
  internals.rpcClients.control = rpc;
  internals.rpcClients["tunnel-stream"] = rpc;
  internals.tunnels = transport;
  return client;
}

async function connect(forward: PortForward): Promise<Socket> {
  const socket = net.createConnection({ host: forward.bind.host, port: forward.bind.port });
  activeSockets.add(socket);
  socket.once("close", () => activeSockets.delete(socket));
  await once(socket, "connect");
  return socket;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function aborted(signal?: AbortSignal): Promise<never> {
  if (!signal) return new Promise(() => undefined);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function waitFor(predicate: () => boolean, timeoutMilliseconds = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for forwarding state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
