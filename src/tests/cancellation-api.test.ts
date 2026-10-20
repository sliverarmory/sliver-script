import { EMPTY } from "rxjs";

import { SliverClient, type ShellSessionOptions } from "../client";
import type { SliverClientConfig } from "../config";
import { OperationAbortedError, OperationTimeoutError } from "../internal/timeout";
import type { TunnelManager } from "../internal/tunnelManager";
import type { Request } from "../pb/commonpb/common";

const shellOptions: ShellSessionOptions = { path: "/bin/sh", pty: false, rows: 24, cols: 80 };

function clientWithRpc(clients: Record<string, object>, tunnels?: object): SliverClient {
  const config: SliverClientConfig = {
    operator: "cancellation-test", token: "token", lhost: "localhost", lport: 31337,
    ca_certificate: "", certificate: "", private_key: "",
  };
  const client = new SliverClient(config);
  const internals = client as unknown as { rpcClients: Record<string, object>; tunnels: TunnelManager };
  Object.assign(internals.rpcClients, clients);
  if (tunnels) internals.tunnels = tunnels as TunnelManager;
  return client;
}

afterEach(() => jest.useRealTimers());

test.each([
  ["method default", 60, "59999999999"],
  ["derived dump default", 90, "89999999999"],
] as const)("signal-only options preserve the %s deadline", async (kind, seconds, wireTimeout) => {
  jest.useFakeTimers();
  let sentRequest: Request | undefined;
  const pending = jest.fn((request: { Request?: Request }) => {
    sentRequest = request.Request;
    return new Promise<never>(() => undefined);
  });
  const client = clientWithRpc({
    control: { currentTokenOwner: pending },
    "workbench-artifact": { processDump: pending },
  });
  const options = { signal: new AbortController().signal };
  const operation = kind === "method default"
    ? client.currentTokenOwnerSession("session", options)
    : client.processDumpSession("session", 42, 60, options);
  let settled = false;
  const result = operation.catch((error: unknown) => { settled = true; return error; });
  expect(sentRequest?.Timeout).toBe(wireTimeout);
  await jest.advanceTimersByTimeAsync((seconds - 1) * 1_000);
  expect(settled).toBe(false);
  await jest.advanceTimersByTimeAsync(1_000);
  expect(await result).toBeInstanceOf(OperationTimeoutError);
  expect(jest.getTimerCount()).toBe(0);
});

test("pre-aborted public operations dispatch no RPC", async () => {
  const ping = jest.fn();
  const createTunnel = jest.fn();
  const client = clientWithRpc({ control: { ping, createTunnel } });
  const controller = new AbortController();
  controller.abort();
  const options = { signal: controller.signal };
  await expect(client.pingSession("session", 1, options)).rejects.toBeInstanceOf(OperationAbortedError);
  await expect(client.startShellSession("session", shellOptions, options)).rejects.toBeInstanceOf(OperationAbortedError);
  expect(ping).not.toHaveBeenCalled();
  expect(createTunnel).not.toHaveBeenCalled();
});

test("canceling one public request leaves another request and its channel usable", async () => {
  const signals: AbortSignal[] = [];
  let resolveRetained!: (response: { Nonce: number }) => void;
  const ping = jest.fn((request: { Nonce: number }, options: { signal: AbortSignal }) => {
    signals.push(options.signal);
    if (request.Nonce === 2) return new Promise<{ Nonce: number }>((resolve) => { resolveRetained = resolve; });
    return new Promise<never>(() => undefined);
  });
  const client = clientWithRpc({ control: { ping } });
  const controller = new AbortController();
  const abandoned = client.pingSession("session", 1, { signal: controller.signal });
  const rejected = expect(abandoned).rejects.toBeInstanceOf(OperationAbortedError);
  const retained = client.pingSession("session", 2, 0);
  controller.abort();
  await rejected;
  expect(signals[0]?.aborted).toBe(true);
  expect(signals[1]?.aborted).toBe(false);
  expect(client.isConnected).toBe(true);
  resolveRetained({ Nonce: 2 });
  await expect(retained).resolves.toEqual({ Nonce: 2 });
});

test.each(["managed", "legacy"] as const)("closes a late CreateTunnel result after %s startup was canceled", async (kind) => {
  jest.useFakeTimers();
  let resolveCreate!: (response: { TunnelID: string }) => void;
  const createTunnel = jest.fn(() => new Promise<{ TunnelID: string }>((resolve) => { resolveCreate = resolve; }));
  const closeTunnel = jest.fn(async () => ({}));
  const shell = jest.fn();
  const tunnels = {
    openOutput: jest.fn(() => EMPTY),
    subscribe: jest.fn(() => EMPTY),
    bind: jest.fn(async (_id: string, _session: string, signal?: AbortSignal) => signal?.throwIfAborted()),
    send: jest.fn(async () => undefined),
    cancelTunnel: jest.fn(),
  };
  const client = clientWithRpc({ control: { createTunnel, closeTunnel, shell }, artifact: {} }, tunnels);
  const controller = new AbortController();
  const options = { timeoutSeconds: 0, signal: controller.signal };
  const opening = kind === "managed"
    ? client.startShellSession("session", shellOptions, options)
    : client.interactSession("session").shell("/bin/sh", false, options);
  const rejected = expect(opening).rejects.toBeInstanceOf(OperationAbortedError);
  controller.abort();
  await rejected;
  expect(closeTunnel).not.toHaveBeenCalled();

  resolveCreate({ TunnelID: `late-${kind}` });
  await jest.advanceTimersByTimeAsync(2_100);
  expect(shell).not.toHaveBeenCalled();
  expect(tunnels.cancelTunnel).toHaveBeenCalledWith(`late-${kind}`);
  expect(closeTunnel).toHaveBeenCalledTimes(1);
  expect(closeTunnel).toHaveBeenCalledWith(
    { TunnelID: `late-${kind}`, SessionID: "session" }, { signal: expect.any(AbortSignal) },
  );
  expect(jest.getTimerCount()).toBe(0);
});

test.each(["managed", "legacy"] as const)("disposes a %s shell whose startup result races caller cancellation", async (kind) => {
  jest.useFakeTimers({ doNotFake: ["queueMicrotask"] });
  const controller = new AbortController();
  const tunnelId = `handoff-${kind}`;
  const closeTunnel = jest.fn(async () => ({}));
  const shell = jest.fn(() => new Promise((resolve) => {
    resolve({ TunnelID: tunnelId, Pid: 42, Response: { Err: "" } });
    // The RPC fulfills first; abort while its continuations are handing the
    // successful shell handle back to the outer startup operation.
    queueMicrotask(() => queueMicrotask(() => controller.abort()));
  }));
  const tunnels = {
    openOutput: jest.fn(() => EMPTY), subscribe: jest.fn(() => EMPTY),
    bind: jest.fn(async () => undefined), send: jest.fn(async () => undefined),
    cancelTunnel: jest.fn(),
  };
  const client = clientWithRpc({
    control: { createTunnel: jest.fn(async () => ({ TunnelID: tunnelId })), closeTunnel, shell },
    artifact: {},
  }, tunnels);
  const options = { timeoutSeconds: 0, signal: controller.signal };
  const opening = kind === "managed"
    ? client.startShellSession("session", shellOptions, options)
    : client.interactSession("session").shell("/bin/sh", false, options);
  await expect(opening).rejects.toBeInstanceOf(OperationAbortedError);
  await jest.advanceTimersByTimeAsync(2_100);
  expect(shell).toHaveBeenCalledTimes(1);
  expect(tunnels.cancelTunnel).toHaveBeenCalledWith(tunnelId);
  expect(closeTunnel).toHaveBeenCalledTimes(1);
  expect(closeTunnel).toHaveBeenCalledWith(
    { TunnelID: tunnelId, SessionID: "session" }, { signal: expect.any(AbortSignal) },
  );
  expect(jest.getTimerCount()).toBe(0);
});
