import type { SliverRPCClient, DeepPartial } from "../pb/rpcpb/services";
import { TunnelData } from "../pb/sliverpb/sliver";
import {
  TUNNEL_MANAGER_MAX_LIFETIME_TUNNELS,
  TunnelManager,
  type TunnelTransportState,
} from "../internal/tunnelManager";

const managers = new Set<TunnelManager>();
afterEach(async () => {
  await Promise.all([...managers].map((manager) => manager.stop()));
  managers.clear();
});

test("fails old output and queued writes, then lazily binds a fresh tunnel without replay", async () => {
  const { manager, streams } = harness();
  const states: TunnelTransportState[] = [];
  manager.transportState$.subscribe((state) => states.push(state));
  const oldFailure = jest.fn();
  const oldOutput = manager.openOutput("old", { maxBufferedBytes: 64, onFailure: oldFailure });
  const oldRead = oldOutput[Symbol.asyncIterator]().next().catch((error: Error) => error.message);
  const oldWrite = manager.send(frame("old", "queued-secret")).catch((error: Error) => error.message);

  streams[0]!.incoming.fail();
  await flush();
  expect(await oldRead).toBe("Tunnel transport disconnected");
  expect(await oldWrite).toBe("Tunnel transport disconnected");
  expect(oldFailure).toHaveBeenCalledWith("transport");
  expect(manager.stats()).toEqual({ activeTunnels: 0, queuedFrames: 0, queuedBytes: 0 });
  expect(manager.transportState).toEqual({ status: "failed", generation: 1 });
  await flush();
  expect(streams).toHaveLength(1);

  const output = manager.openOutput("new", { maxBufferedBytes: 64 });
  const binding = manager.bind("new", "session");
  expect(streams).toHaveLength(2);
  const first = await streams[1]!.outgoing.next();
  expect(first.value).toMatchObject({ TunnelID: "new", SessionID: "session", Data: Buffer.alloc(0) });
  const successor = streams[1]!.outgoing.next().catch(() => ({ done: true }));
  streams[1]!.incoming.push(frame("new"));
  await binding;
  streams[1]!.incoming.push(frame("new", "fresh"));
  await expect(output[Symbol.asyncIterator]().next()).resolves.toEqual({ value: Uint8Array.from(Buffer.from("fresh")), done: false });
  expect(states.map(({ status, generation }) => `${generation}:${status}`)).toEqual([
    "0:idle", "1:connecting", "1:failed", "2:connecting", "2:connected",
  ]);
  expect(states.every(Object.isFrozen)).toBe(true);
  await manager.stop();
  await successor;
});

test("retires old listeners while allowing new owners to await the next generation", async () => {
  const { manager, streams } = harness();
  const oldListener = jest.fn();
  manager.onTransportFailure(oldListener);
  manager.openOutput("first", { maxBufferedBytes: 64 });
  streams[0]!.incoming.fail();
  await flush();
  expect(oldListener).toHaveBeenCalledTimes(1);
  const lateListener = jest.fn();
  manager.onTransportFailure(lateListener);
  expect(lateListener).toHaveBeenCalledTimes(1);

  const newListener = jest.fn();
  manager.onTransportFailure(newListener, { nextGeneration: true });
  expect(newListener).not.toHaveBeenCalled();
  expect(streams).toHaveLength(1);
  manager.openOutput("second", { maxBufferedBytes: 64 });
  streams[1]!.incoming.fail();
  await flush();
  expect(newListener).toHaveBeenCalledTimes(1);
  expect(oldListener).toHaveBeenCalledTimes(1);
  expect(lateListener).toHaveBeenCalledTimes(1);
  manager.openOutput("third", { maxBufferedBytes: 64 });
  expect(manager.transportState).toEqual({ status: "connecting", generation: 3 });
  expect(streams).toHaveLength(3);
});

test("stale identities and old consumer cleanup cannot restart or affect a new generation", async () => {
  const { manager, streams } = harness();
  const oldFailure = jest.fn();
  const old = manager.openOutput("old", { maxBufferedBytes: 64, onFailure: oldFailure });
  const iterator = old[Symbol.asyncIterator]();
  streams[0]!.incoming.fail();
  await flush();
  expect(() => manager.openOutput("old", { maxBufferedBytes: 64 })).toThrow("retired");
  await expect(manager.bind("old", "session")).rejects.toThrow("retired");
  await expect(manager.send(frame("old", "late"))).rejects.toThrow("Tunnel is closed");
  expect(streams).toHaveLength(1);

  const current = manager.openOutput("new", { maxBufferedBytes: 64 });
  manager.cancelTunnel("old");
  await iterator.return?.();
  expect(oldFailure).toHaveBeenCalledTimes(1);
  const read = current[Symbol.asyncIterator]().next();
  // The failed stream retains its own iterator and cannot route into its replacement.
  streams[0]!.incoming.push(frame("new", "stale", true));
  streams[1]!.incoming.push(frame("new", "current"));
  await expect(read).resolves.toEqual({ value: Uint8Array.from(Buffer.from("current")), done: false });
  expect(manager.stats().activeTunnels).toBe(1);
});

test("reentrant failure callbacks can open a replacement without old cleanup retiring it", async () => {
  const { manager, streams } = harness();
  let replacement: AsyncIterable<Uint8Array> | undefined;
  manager.openOutput("old", {
    maxBufferedBytes: 64,
    onFailure: () => { replacement = manager.openOutput("replacement", { maxBufferedBytes: 64 }); },
  });
  manager.onTransportFailure(() => manager.cancelTunnel("old"));
  streams[0]!.incoming.fail();
  await flush();
  expect(streams).toHaveLength(2);
  expect(manager.transportState).toEqual({ status: "connecting", generation: 2 });
  streams[1]!.incoming.push(frame("replacement", "ready"));
  await expect(replacement![Symbol.asyncIterator]().next()).resolves.toMatchObject({ done: false });
});

test("cancelled binds do not recover automatically and stop permanently prevents restart", async () => {
  const { manager, streams } = harness();
  manager.openOutput("cancel", { maxBufferedBytes: 64 });
  const controller = new AbortController();
  const binding = manager.bind("cancel", "session", controller.signal);
  controller.abort();
  await expect(binding).rejects.toThrow("cancelled");
  manager.cancelTunnel("cancel");
  await flush();
  expect(streams).toHaveLength(1);
  await manager.stop();
  expect(manager.transportState).toEqual({ status: "stopped", generation: 1 });
  expect(() => manager.openOutput("after-stop", { maxBufferedBytes: 64 })).toThrow("not connected");
  expect(() => manager.start({} as SliverRPCClient)).toThrow("stopped");
  await expect(manager.send(frame("cancel"))).rejects.toThrow("closed");
  expect(streams).toHaveLength(1);
});

test("synchronous transport startup failure reaches the initiating output and can recover", async () => {
  const manager = new TunnelManager();
  managers.add(manager);
  const incoming = new Incoming();
  const tunnelData = jest.fn()
    .mockImplementationOnce(() => { throw new Error("private transport detail"); })
    .mockImplementation((_outgoing, options: { signal: AbortSignal }) => {
      options.signal.addEventListener("abort", () => incoming.close(), { once: true });
      return incoming;
    });
  manager.start({ tunnelData } as unknown as SliverRPCClient);
  const first = manager.openOutput("first", { maxBufferedBytes: 64 });
  await expect(first[Symbol.asyncIterator]().next()).rejects.toThrow("Tunnel transport disconnected");
  const second = manager.openOutput("second", { maxBufferedBytes: 64 });
  incoming.push(frame("second", "ok"));
  await expect(second[Symbol.asyncIterator]().next()).resolves.toMatchObject({ done: false });
  expect(tunnelData).toHaveBeenCalledTimes(2);
});

test("bounds retired identity storage and requests reconnect when its lifetime budget is exhausted", () => {
  const { manager, streams } = harness();
  for (let index = 0; index < TUNNEL_MANAGER_MAX_LIFETIME_TUNNELS; index += 1) {
    const id = `retired-${index}`;
    manager.subscribe(id);
    manager.cancelTunnel(id);
  }
  expect(manager.stats()).toEqual({ activeTunnels: 0, queuedFrames: 0, queuedBytes: 0 });
  expect(() => manager.openOutput("over-budget", { maxBufferedBytes: 64 })).toThrow("reconnect the client");
  expect(streams).toHaveLength(1);
});

test("exclusive legacy subscriptions reject collisions without changing the original owner", async () => {
  const { manager, streams } = harness();
  const original: string[] = [];
  const originalClosed = jest.fn();
  const originalFailed = jest.fn();
  manager.subscribe("owned", { exclusive: true }).subscribe({
    next: (message) => original.push(message.Data.toString()),
    complete: originalClosed,
    error: originalFailed,
  });
  expect(() => manager.subscribe(" owned ", { exclusive: true })).toThrow("already registered");
  const observer: string[] = [];
  manager.subscribe("owned").subscribe({
    next: (message) => observer.push(message.Data.toString()),
    error: () => undefined,
  });
  const independent: string[] = [];
  manager.subscribe("new", { exclusive: true }).subscribe({
    next: (message) => independent.push(message.Data.toString()),
    error: () => undefined,
  });
  streams[0]!.incoming.push(frame("owned", "original-still-live"));
  streams[0]!.incoming.push(frame("new", "new-owner"));
  await flush();
  expect(original).toEqual(["original-still-live"]);
  expect(observer).toEqual(original);
  expect(independent).toEqual(["new-owner"]);
  expect(originalClosed).not.toHaveBeenCalled();
  expect(originalFailed).not.toHaveBeenCalled();
  expect(manager.stats().activeTunnels).toBe(2);
  expect(streams).toHaveLength(1);
});

function harness() {
  const manager = new TunnelManager();
  managers.add(manager);
  const streams: Array<{ incoming: Incoming; outgoing: AsyncIterator<DeepPartial<TunnelData>> }> = [];
  manager.start({
    tunnelData: (outgoing: AsyncIterable<DeepPartial<TunnelData>>, options: { signal: AbortSignal }) => {
      const incoming = new Incoming();
      options.signal.addEventListener("abort", () => incoming.close(), { once: true });
      streams.push({ incoming, outgoing: outgoing[Symbol.asyncIterator]() });
      return incoming;
    },
  } as unknown as SliverRPCClient);
  return { manager, streams };
}

class Incoming implements AsyncIterable<TunnelData> {
  private queued: TunnelData[] = [];
  private waiter?: { resolve: (result: IteratorResult<TunnelData>) => void; reject: (error: Error) => void };
  private stopped = false;
  push(value: TunnelData): void {
    if (this.stopped) return;
    const waiter = this.waiter;
    this.waiter = undefined;
    if (waiter) waiter.resolve({ value, done: false });
    else this.queued.push(value);
  }
  fail(): void {
    this.stopped = true;
    this.waiter?.reject(new Error("private transport detail"));
    this.waiter = undefined;
  }
  close(): void {
    this.stopped = true;
    this.waiter?.resolve({ value: undefined as never, done: true });
    this.waiter = undefined;
  }
  [Symbol.asyncIterator](): AsyncIterator<TunnelData> {
    return { next: () => {
      const value = this.queued.shift();
      if (value) return Promise.resolve({ value, done: false });
      if (this.stopped) return Promise.resolve({ value: undefined as never, done: true });
      return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
    } };
  }
}

function frame(id: string, data = "", closed = false): TunnelData {
  return TunnelData.create({ TunnelID: id, SessionID: "session", Data: Buffer.from(data), Closed: closed });
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
