import net, { type Server, type Socket } from "node:net";
import { inspect } from "node:util";

import { SliverClient } from "../client";
import type { ForwardConnectionEvent, LocalForwardState, Socks5Proxy, Socks5ProxyOptions } from "../forwarding";
import { TUNNEL_STREAM_MAX_PAYLOAD_BYTES } from "../messageBudget";
import type { DeepPartial } from "../pb/rpcpb/services";
import type { SocksData } from "../pb/sliverpb/sliver";
import {
  SOCKS5_TEST_CONSTANTS,
  startSocks5Proxy,
  type ManagedSocks5Proxy,
} from "../internal/socks5Proxy";

const liveProxies = new Set<Socks5Proxy>();
const liveSockets = new Set<Socket>();

afterEach(async () => {
  for (const socket of liveSockets) socket.destroy();
  liveSockets.clear();
  await Promise.all([...liveProxies].map((proxy) => proxy.close()));
  liveProxies.clear();
});

describe("stateful SOCKS5 proxy transport", () => {
  test("negotiates current flow control, binds before payload, and relays binary data", async () => {
    const harness = new SocksStreamHarness({ echo: true, acknowledge: true });
    const proxy = await startProxy(harness, {
      authentication: { username: "range-user", password: "correct horse battery staple" },
    });
    const runtimeOptions = Reflect.get(proxy as object, "options") as Record<string, unknown>;
    expect(runtimeOptions).not.toHaveProperty("username");
    expect(runtimeOptions).not.toHaveProperty("password");
    expect(Object.keys(proxy)).not.toContain("#password");
    expect(inspect(proxy)).not.toContain("correct horse battery staple");
    const states: LocalForwardState[] = [];
    const events: ForwardConnectionEvent[] = [];
    proxy.state$.subscribe((state) => states.push(state));
    proxy.connection$.subscribe((event) => events.push(event));

    const socket = await connect(proxy);
    const payload = Buffer.from([0x05, 0x01, 0x00, 0x00, 0xff, 0x41]);
    const echoed = readExactly(socket, payload.length);
    await write(socket, payload);
    expect(await echoed).toEqual(payload);

    const marker = await harness.waitForFrame((frame) => frame.Sequence === SOCKS5_TEST_CONSTANTS.lifecycleBindSequence);
    expect(marker).toMatchObject({
      TunnelID: "100",
      Sequence: "18446744073709551615",
      Capabilities: "4",
      Username: "range-user",
      Password: "correct horse battery staple",
      Request: { SessionID: "session-1" },
    });
    expect(marker.Data?.length ?? 0).toBe(0);

    const firstData = await harness.waitForFrame((frame) => (frame.Data?.length ?? 0) > 0);
    expect(firstData).toMatchObject({
      TunnelID: "100",
      Sequence: "0",
      Username: "range-user",
      Password: "correct horse battery staple",
      Request: { SessionID: "session-1" },
    });
    expect(firstData.Data).toEqual(payload);
    expect(harness.rpc.createSocks).toHaveBeenCalledWith(
      { SessionID: "session-1", Capabilities: "4" },
      { signal: expect.any(AbortSignal) },
    );

    socket.end();
    await harness.waitForFrame((frame) => frame.CloseConn === true);
    await waitFor(() => events.some((event) => event.status === "closed"));
    expect(proxy.state).toMatchObject({
      status: "listening",
      activeConnections: 0,
      totalConnections: 1,
      bytesToTarget: payload.length,
      bytesFromTarget: payload.length,
    });
    expect(events.map((event) => event.status)).toEqual(["opening", "open", "closed"]);
    expect(JSON.stringify({ states, events, state: proxy.state })).not.toContain("correct horse");

    const firstClose = proxy.close();
    const secondClose = proxy.close();
    expect(firstClose).toBe(secondClose);
    await firstClose;
    expect(proxy.state).toMatchObject({ status: "closed", reason: "requested", activeConnections: 0 });
  });

  test("latches shutdown before a closing subscriber can re-enter close", async () => {
    const harness = new SocksStreamHarness();
    const proxy = await startProxy(harness);
    const server = Reflect.get(proxy as object, "server") as Server;
    const closeServer = jest.spyOn(server, "close");
    const reentrantCloses: Promise<void>[] = [];
    const statuses: string[] = [];
    const completed = jest.fn();
    proxy.state$.subscribe({
      next: (state) => {
        statuses.push(state.status);
        if (state.status === "closing") reentrantCloses.push(proxy.close());
      },
      complete: completed,
    });

    const closing = proxy.close();
    expect(reentrantCloses).toHaveLength(1);
    expect(reentrantCloses[0]).toBe(closing);
    await closing;

    expect(closeServer).toHaveBeenCalledTimes(1);
    expect(statuses.filter((status) => status === "closing")).toHaveLength(1);
    expect(statuses.filter((status) => status === "closed")).toHaveLength(1);
    expect(completed).toHaveBeenCalledTimes(1);
    const lateNext = jest.fn();
    const lateComplete = jest.fn();
    proxy.state$.subscribe({ next: lateNext, complete: lateComplete });
    expect(lateNext).not.toHaveBeenCalled();
    expect(lateComplete).toHaveBeenCalledTimes(1);
  });

  test("keeps yielded frames intact until a deferred gRPC serializer owns them", async () => {
    const harness = new SocksStreamHarness({
      echo: true,
      acknowledge: true,
      deferSerializationUntilSuccessorPull: true,
    });
    const proxy = await startProxy(harness, {
      authentication: { username: "deferred-user", password: "deferred-password" },
    });
    const socket = await connect(proxy);
    const payload = Buffer.from([0x05, 0x01, 0x02]);
    const echoed = readExactly(socket, payload.length);
    await write(socket, payload);

    expect(await echoed).toEqual(payload);
    const marker = await harness.waitForFrame(isLifecycleMarker);
    expect(marker).toMatchObject({
      Username: "deferred-user",
      Password: "deferred-password",
    });
    const firstData = await harness.waitForFrame((frame) => (frame.Data?.length ?? 0) > 0);
    expect(firstData.Data).toEqual(payload);
    expect(firstData).toMatchObject({
      Username: "deferred-user",
      Password: "deferred-password",
    });

    socket.end();
    await waitFor(() => proxy.state.activeConnections === 0);
  });

  test("multiplexes independent connections and rejects only excess capacity", async () => {
    const harness = new SocksStreamHarness({ echo: true, acknowledge: true });
    const proxy = await startProxy(harness, { maxConnections: 2 });
    const events: ForwardConnectionEvent[] = [];
    proxy.connection$.subscribe((event) => events.push(event));

    const first = await connect(proxy);
    const second = await connect(proxy);
    const third = await connect(proxy);
    await waitFor(() => events.some((event) => event.status === "rejected"));
    await waitFor(() => harness.frames.filter(isLifecycleMarker).length === 2);

    const firstPayload = Buffer.from("first\0connection");
    const secondPayload = Buffer.from("second\xffconnection");
    const firstRead = readExactly(first, firstPayload.length);
    const secondRead = readExactly(second, secondPayload.length);
    await Promise.all([write(first, firstPayload), write(second, secondPayload)]);
    expect(await firstRead).toEqual(firstPayload);
    expect(await secondRead).toEqual(secondPayload);
    expect(new Set(harness.frames.filter(isLifecycleMarker).map((frame) => frame.TunnelID))).toEqual(
      new Set(["100", "101"]),
    );
    expect(events.find((event) => event.status === "rejected")?.reason).toBe("capacity");
    expect(proxy.state).toMatchObject({ activeConnections: 2, totalConnections: 3 });

    third.destroy();
    first.end();
    second.end();
    await waitFor(() => proxy.state.activeConnections === 0);
  });

  test("stops reading at the 64-frame negotiated window until a cumulative acknowledgement", async () => {
    const harness = new SocksStreamHarness();
    const proxy = await startProxy(harness);
    const socket = await connect(proxy);
    await harness.waitForFrame(isLifecycleMarker);

    const payload = Buffer.alloc(TUNNEL_STREAM_MAX_PAYLOAD_BYTES * 65, 0x5a);
    socket.write(payload);
    await waitFor(() => harness.dataFrames("100").length === 64);
    await delay(30);
    expect(harness.dataFrames("100")).toHaveLength(64);
    expect(harness.dataFrames("100").map((frame) => frame.Sequence)).toEqual(
      Array.from({ length: 64 }, (_value, index) => String(index)),
    );

    harness.push(ackFrame("100", "64"));
    await waitFor(() => harness.dataFrames("100").length >= 65);
    expect(harness.dataFrames("100")[64]?.Sequence).toBe("64");
    payload.fill(0);
  });

  test("acknowledges fully written inbound batches and isolates receive overflow", async () => {
    const harness = new SocksStreamHarness({ acknowledge: true });
    const proxy = await startProxy(harness, { maxBufferedBytesPerConnection: 1 });
    const events: ForwardConnectionEvent[] = [];
    proxy.connection$.subscribe((event) => events.push(event));
    const socket = await connect(proxy);
    await write(socket, Buffer.from([0x05]));
    await harness.waitForFrame((frame) => (frame.Data?.length ?? 0) === 1);

    harness.push(dataFrame("100", "0", Buffer.from([0x01, 0x02])));
    await waitFor(() => events.some((event) => event.status === "failed"));
    expect(events.find((event) => event.status === "failed")).toMatchObject({
      tunnelId: "100",
      reason: "buffer-overflow",
    });
    expect(harness.rpc.closeSocks).toHaveBeenCalledWith(
      { TunnelID: "100", SessionID: "session-1" },
      { signal: expect.any(AbortSignal) },
    );
    expect(proxy.state.status).toBe("listening");

    const second = await connect(proxy);
    await write(second, Buffer.from([0x05]));
    await harness.waitForFrame((frame) => frame.TunnelID === "101" && (frame.Data?.length ?? 0) === 1);
    second.destroy();
  });

  test.each([
    {
      label: "acknowledgement",
      frame: () => ackFrame("100", "2"),
    },
    {
      label: "response metadata",
      frame: () => fullFrame({ TunnelID: "100", Capabilities: "1" }),
    },
    {
      label: "receive sequence",
      frame: () => dataFrame("100", "1", Buffer.from([0x42])),
    },
  ])("contains a malformed $label as a connection-local protocol error", async ({ frame }) => {
    const harness = new SocksStreamHarness();
    const proxy = await startProxy(harness);
    const events: ForwardConnectionEvent[] = [];
    proxy.connection$.subscribe((event) => events.push(event));
    const socket = await connect(proxy);
    await harness.waitForFrame(isLifecycleMarker);
    await write(socket, Buffer.from([0x05]));
    await harness.waitForFrame((candidate) => candidate.TunnelID === "100" && (candidate.Data?.length ?? 0) > 0);

    harness.push(frame());
    await waitForSocketClose(socket);
    await waitFor(() => events.some((event) => event.status === "failed"));

    expect(events.find((event) => event.status === "failed")).toMatchObject({
      tunnelId: "100",
      reason: "protocol-error",
    });
    expect(proxy.state.status).toBe("listening");
    expect(harness.rpc.closeSocks).toHaveBeenCalledTimes(1);
  });

  test("enforces the proxy-wide receive budget without failing the shared listener", async () => {
    const harness = new SocksStreamHarness({ acknowledge: true });
    const proxy = await startProxy(
      harness,
      { maxBufferedBytesPerConnection: 4 },
      { maxTotalIncomingBytes: 1 },
    );
    const events: ForwardConnectionEvent[] = [];
    proxy.connection$.subscribe((event) => events.push(event));
    const socket = await connect(proxy);
    await write(socket, Buffer.from([0x05]));
    await harness.waitForFrame((frame) => frame.TunnelID === "100" && (frame.Data?.length ?? 0) === 1);

    harness.push(dataFrame("100", "0", Buffer.from([0x01, 0x02])));
    await waitFor(() => events.some((event) => event.status === "failed"));
    expect(events.find((event) => event.status === "failed")).toMatchObject({
      tunnelId: "100",
      reason: "buffer-overflow",
    });
    expect(proxy.state.status).toBe("listening");
  });

  test("emits cumulative acknowledgements only after complete local writes", async () => {
    const harness = new SocksStreamHarness({ acknowledge: true });
    const proxy = await startProxy(harness);
    const socket = await connect(proxy);
    const received = readExactly(socket, 16);
    await write(socket, Buffer.from([0x05]));
    await harness.waitForFrame((frame) => frame.TunnelID === "100" && (frame.Data?.length ?? 0) === 1);

    for (let sequence = 0; sequence < 16; sequence += 1) {
      harness.push(dataFrame("100", String(sequence), Buffer.from([sequence])));
    }
    expect(await received).toEqual(Buffer.from(Array.from({ length: 16 }, (_value, index) => index)));
    const ack = await harness.waitForFrame((frame) => frame.Ack === "16");
    expect(ack).toMatchObject({
      TunnelID: "100",
      Ack: "16",
      Request: { SessionID: "session-1" },
    });
    expect(ack.Data?.length ?? 0).toBe(0);
    expect(ack.CloseConn ?? false).toBe(false);

    harness.push(terminalFrame("100", "16"));
    await waitForSocketClose(socket);
  });

  test("bounds the first-payload lease and retires an unproductive remote tunnel", async () => {
    const harness = new SocksStreamHarness();
    const proxy = await startProxy(harness, {}, { firstPayloadTimeoutMilliseconds: 20 });
    const events: ForwardConnectionEvent[] = [];
    proxy.connection$.subscribe((event) => events.push(event));
    const socket = await connect(proxy);
    await harness.waitForFrame(isLifecycleMarker);

    await waitForSocketClose(socket);
    await waitFor(() => harness.rpc.closeSocks.mock.calls.length === 1);
    await waitFor(() => events.some((event) => event.status === "failed"));
    expect(events.find((event) => event.status === "failed")).toMatchObject({
      tunnelId: "100",
      reason: "setup-failed",
    });
  });

  test("turns an unexpected shared-stream failure into a safe terminal state", async () => {
    const harness = new SocksStreamHarness();
    const proxy = await startProxy(harness);
    const socket = await connect(proxy);
    await harness.waitForFrame(isLifecycleMarker);
    const states: LocalForwardState[] = [];
    proxy.state$.subscribe((state) => states.push(state));

    harness.incoming.fail(new Error("TOP-SECRET-REMOTE-DETAIL"));
    await proxy.closed;
    expect(proxy.state).toMatchObject({
      status: "failed",
      reason: "transport-disconnected",
      activeConnections: 0,
    });
    expect(JSON.stringify(states)).not.toContain("TOP-SECRET");
    await waitForSocketClose(socket);
  });

  test("publishes terminal failure once only after gated active cleanup", async () => {
    const cleanup = deferred<void>();
    const harness = new SocksStreamHarness();
    harness.rpc.closeSocks.mockImplementation(async () => {
      await cleanup.promise;
      return {};
    });
    const proxy = await startProxy(harness);
    const socket = await connect(proxy);
    await harness.waitForFrame(isLifecycleMarker);
    const states: LocalForwardState[] = [];
    proxy.state$.subscribe((state) => states.push(state));

    harness.incoming.fail(new Error("TOP-SECRET-REMOTE-DETAIL"));
    await waitFor(() => proxy.state.status === "closing" && harness.rpc.closeSocks.mock.calls.length === 1);
    expect(proxy.state).toMatchObject({
      status: "closing",
      reason: "transport-disconnected",
      activeConnections: 1,
    });
    expect(states.filter((state) => state.status === "failed")).toEqual([]);

    cleanup.resolve(undefined);
    await proxy.closed;
    expect(states.filter((state) => state.status === "failed")).toEqual([
      expect.objectContaining({
        status: "failed",
        reason: "transport-disconnected",
        activeConnections: 0,
      }),
    ]);
    await waitForSocketClose(socket);
  });

  test("uses full-close semantics for a response delayed until after local FIN", async () => {
    const harness = new SocksStreamHarness();
    const proxy = await startProxy(harness);
    const received: Buffer[] = [];
    const socket = await connect(proxy);
    socket.on("data", (chunk: Buffer) => received.push(Buffer.from(chunk)));
    await harness.waitForFrame(isLifecycleMarker);
    await write(socket, Buffer.from("request-before-fin"));
    await harness.waitForFrame((frame) => (frame.Data?.length ?? 0) > 0);

    socket.end();
    await harness.waitForFrame((frame) => frame.TunnelID === "100" && frame.CloseConn === true);
    await delay(10);
    harness.push(dataFrame("100", "0", Buffer.from("delayed-response")));
    await waitForSocketClose(socket);
    await delay(10);

    expect(Buffer.concat(received)).toEqual(Buffer.alloc(0));
    expect(proxy.state.status).toBe("listening");
  });

  test.each([
    { label: "lifecycle marker", stallAfterFrames: 1, sendPayload: false },
    { label: "data frame", stallAfterFrames: 2, sendPayload: true },
  ])("retires a connection closed during a stalled $label send", async ({ stallAfterFrames, sendPayload }) => {
    const harness = new SocksStreamHarness({ stallAfterFrames });
    const proxy = await startProxy(harness);
    const socket = await connect(proxy);
    await harness.waitForFrame(isLifecycleMarker);
    if (sendPayload) {
      await write(socket, Buffer.from([0x05]));
      await harness.waitForFrame((frame) => (frame.Data?.length ?? 0) === 1);
    }

    socket.destroy();
    await waitFor(() => proxy.state.activeConnections === 0);
    expect(harness.rpc.closeSocks).toHaveBeenCalledWith(
      { TunnelID: "100", SessionID: "session-1" },
      { signal: expect.any(AbortSignal) },
    );
    expect(proxy.state.status).toBe("listening");
  });

  test("bounds an idle peer while lifecycle-marker delivery is stalled", async () => {
    const harness = new SocksStreamHarness({ stallAfterFrames: 1 });
    const proxy = await startProxy(harness, {}, { firstPayloadTimeoutMilliseconds: 20 });
    const socket = await connect(proxy);
    await harness.waitForFrame(isLifecycleMarker);

    await waitForSocketClose(socket);
    await waitFor(() => proxy.state.activeConnections === 0);
    expect(harness.rpc.closeSocks).toHaveBeenCalledTimes(1);
    expect(proxy.state.status).toBe("listening");
  });

  test("retires a connection closed during a stalled acknowledgement send", async () => {
    const harness = new SocksStreamHarness({ stallAfterFrames: 3 });
    const proxy = await startProxy(harness);
    const socket = await connect(proxy);
    await harness.waitForFrame(isLifecycleMarker);
    await write(socket, Buffer.from([0x05]));
    await harness.waitForFrame((frame) => (frame.Data?.length ?? 0) === 1);

    const received = readExactly(socket, 16);
    for (let sequence = 0; sequence < 16; sequence += 1) {
      harness.push(dataFrame("100", String(sequence), Buffer.from([sequence])));
    }
    expect(await received).toEqual(Buffer.from(Array.from({ length: 16 }, (_value, index) => index)));
    await harness.waitForFrame((frame) => frame.Ack === "16");

    socket.destroy();
    await waitFor(() => proxy.state.activeConnections === 0);
    expect(harness.rpc.closeSocks).toHaveBeenCalledTimes(1);
    expect(proxy.state.status).toBe("listening");
  });

  test("remote terminal cleanup never waits for a forced acknowledgement", async () => {
    const harness = new SocksStreamHarness({ stallAfterFrames: 3 });
    const proxy = await startProxy(harness);
    const socket = await connect(proxy);
    await harness.waitForFrame(isLifecycleMarker);
    await write(socket, Buffer.from([0x05]));
    await harness.waitForFrame((frame) => (frame.Data?.length ?? 0) === 1);

    const received = readExactly(socket, 1);
    harness.push(dataFrame("100", "0", Buffer.from([0x42])));
    expect(await received).toEqual(Buffer.from([0x42]));
    harness.push(terminalFrame("100", "1"));

    await waitForSocketClose(socket);
    await waitFor(() => proxy.state.activeConnections === 0);
    expect(harness.frames.some((frame) => frame.Ack === "1")).toBe(false);
    expect(proxy.state.status).toBe("listening");
  });

  test("does not leave a listener behind when the shared stream ends during startup", async () => {
    const port = await allocatePort();
    const harness = new SocksStreamHarness();
    harness.incoming.close();

    await expect(startSocks5Proxy(
      { rpc: harness.rpc as never, sessionId: "session-1" },
      options({ bind: { host: "127.0.0.1", port } }),
    )).rejects.toThrow("Unable to start SOCKS5 proxy");
    await expect(connectAddress({ host: "127.0.0.1", port })).rejects.toThrow();
  });

  test("contains a rejected per-connection setup without an unhandled worker rejection", async () => {
    const harness = new SocksStreamHarness();
    harness.rpc.createSocks.mockRejectedValueOnce(new Error("TOP-SECRET-CREATE-DETAIL"));
    const proxy = await startProxy(harness);
    const events: ForwardConnectionEvent[] = [];
    proxy.connection$.subscribe((event) => events.push(event));

    const socket = await connect(proxy);
    await waitForSocketClose(socket);
    await waitFor(() => events.some((event) => event.status === "failed"));
    expect(events.find((event) => event.status === "failed")).toMatchObject({
      reason: "setup-failed",
      tunnelId: undefined,
    });
    expect(proxy.state).toMatchObject({ status: "listening", activeConnections: 0 });
    expect(JSON.stringify(events)).not.toContain("TOP-SECRET");
  });

  test("closes a remote tunnel created after its local peer has already gone away", async () => {
    const created = deferred<{
      TunnelID: string;
      SessionID: string;
      Capabilities: string;
    }>();
    const harness = new SocksStreamHarness();
    harness.rpc.createSocks.mockImplementationOnce(async () => created.promise);
    const proxy = await startProxy(harness);
    const socket = await connect(proxy);
    await waitFor(() => harness.rpc.createSocks.mock.calls.length === 1);

    socket.destroy();
    await waitForSocketClose(socket);
    const createSignal = (harness.rpc.createSocks.mock.calls[0]?.[1] as { signal: AbortSignal }).signal;
    await waitFor(() => createSignal.aborted);
    created.resolve({ TunnelID: "100", SessionID: "session-1", Capabilities: "4" });

    await waitFor(() => proxy.state.activeConnections === 0);
    expect(harness.rpc.closeSocks).toHaveBeenCalledWith(
      { TunnelID: "100", SessionID: "session-1" },
      { signal: expect.any(AbortSignal) },
    );
  });

  test("does not acquire cleanup ownership for a tunnel returned for the wrong session", async () => {
    const harness = new SocksStreamHarness();
    harness.rpc.createSocks.mockResolvedValueOnce({
      TunnelID: "31337",
      SessionID: "other-session",
      Capabilities: "4",
    });
    const proxy = await startProxy(harness);
    const events: ForwardConnectionEvent[] = [];
    proxy.connection$.subscribe((event) => events.push(event));
    const socket = await connect(proxy);

    await waitForSocketClose(socket);
    await waitFor(() => proxy.state.activeConnections === 0);
    expect(harness.rpc.closeSocks).not.toHaveBeenCalled();
    expect(events.find((event) => event.status === "failed")).toMatchObject({
      tunnelId: "31337",
      reason: "setup-failed",
    });
  });

  test("a wrong-session newcomer cannot close an existing tunnel owner", async () => {
    const harness = new SocksStreamHarness({ echo: true, acknowledge: true });
    const proxy = await startProxy(harness);
    const first = await connect(proxy);
    await harness.waitForFrame(isLifecycleMarker);
    harness.rpc.createSocks.mockResolvedValueOnce({
      TunnelID: "100",
      SessionID: "other-session",
      Capabilities: "4",
    });

    const second = await connect(proxy);
    await waitForSocketClose(second);
    await waitFor(() => proxy.state.activeConnections === 1);
    expect(harness.rpc.closeSocks).not.toHaveBeenCalled();
    expect(harness.frames.filter(isLifecycleMarker)).toHaveLength(1);

    const payload = Buffer.from([0x05, 0x01, 0x00]);
    const received = readExactly(first, payload.length);
    await write(first, payload);
    expect(await received).toEqual(payload);
    expect(proxy.state.status).toBe("listening");
  });

  test("a duplicate newcomer leaves the original tunnel owner usable and responsible for cleanup", async () => {
    const harness = new SocksStreamHarness({ echo: true, acknowledge: true });
    const proxy = await startProxy(harness);
    const first = await connect(proxy);
    await harness.waitForFrame(isLifecycleMarker);
    harness.rpc.createSocks.mockResolvedValueOnce({
      TunnelID: "100",
      SessionID: "session-1",
      Capabilities: "4",
    });

    const second = await connect(proxy);
    await waitForSocketClose(second);
    await waitFor(() => proxy.state.activeConnections === 1);
    expect(proxy.state.status).toBe("listening");
    expect(harness.frames.filter(isLifecycleMarker)).toHaveLength(1);
    expect(harness.rpc.closeSocks).not.toHaveBeenCalled();

    const payload = Buffer.from([0x05, 0x01, 0x00]);
    const received = readExactly(first, payload.length);
    await write(first, payload);
    expect(await received).toEqual(payload);

    await proxy.close();
    await waitForSocketClose(first);
    expect(harness.rpc.closeSocks).toHaveBeenCalledTimes(1);
    expect(harness.rpc.closeSocks).toHaveBeenCalledWith(
      { TunnelID: "100", SessionID: "session-1" },
      { signal: expect.any(AbortSignal) },
    );
  });

  test("retains cleanup ownership while a rejected setup awaits CloseSocks", async () => {
    const cleanup = deferred<void>();
    const harness = new SocksStreamHarness();
    harness.rpc.createSocks.mockResolvedValue({
      TunnelID: "100",
      SessionID: "session-1",
      Capabilities: "1",
    });
    harness.rpc.closeSocks.mockImplementation(async () => {
      await cleanup.promise;
      return {};
    });
    const proxy = await startProxy(harness);
    const events: ForwardConnectionEvent[] = [];
    proxy.connection$.subscribe((event) => events.push(event));
    const first = await connect(proxy);
    await waitFor(() => harness.rpc.closeSocks.mock.calls.length === 1);

    const second = await connect(proxy);
    try {
      await waitForSocketClose(second);
      await waitFor(() => events.some((event) => event.status === "failed"));
      expect(proxy.state).toMatchObject({ status: "listening", activeConnections: 1 });
      expect(harness.frames).toEqual([]);
      expect(harness.rpc.closeSocks).toHaveBeenCalledTimes(1);
    } finally {
      cleanup.resolve(undefined);
    }
    await waitFor(() => proxy.state.activeConnections === 0);
    await Promise.all([waitForSocketClose(first), waitForSocketClose(second)]);
    expect(proxy.state.status).toBe("listening");
    expect(harness.rpc.closeSocks).toHaveBeenCalledTimes(1);
  });

  test("shares tunnel ownership across the SOCKS proxies of one client", async () => {
    const ownerHarness = new SocksStreamHarness({ echo: true, acknowledge: true });
    const newcomerHarness = new SocksStreamHarness();
    const ownerStream = ownerHarness.rpc.socksProxy.getMockImplementation()!;
    ownerHarness.rpc.socksProxy
      .mockImplementationOnce(ownerStream)
      .mockImplementationOnce(newcomerHarness.rpc.socksProxy);
    ownerHarness.rpc.createSocks.mockResolvedValue({
      TunnelID: "100", SessionID: "session-1", Capabilities: "4",
    });
    const client = clientWithSocks(ownerHarness);
    const owner = await client.startSocks5Proxy("session-1", options());
    const newcomer = await client.startSocks5Proxy("session-1", options());
    liveProxies.add(owner);
    liveProxies.add(newcomer);
    const failures: ForwardConnectionEvent[] = [];
    newcomer.connection$.subscribe((event) => failures.push(event));
    const first = await connect(owner);
    await ownerHarness.waitForFrame(isLifecycleMarker);

    const second = await connect(newcomer);
    await waitForSocketClose(second);
    await waitFor(() => failures.some((event) => event.status === "failed"));
    expect(failures.find((event) => event.status === "failed")).toMatchObject({
      tunnelId: "100", reason: "setup-failed",
    });
    expect(owner.state).toMatchObject({ status: "listening", activeConnections: 1 });
    expect(newcomer.state).toMatchObject({ status: "listening", activeConnections: 0 });
    expect(client.listSocks5Proxies()).toEqual(expect.arrayContaining([owner, newcomer]));
    expect(newcomerHarness.frames).toEqual([]);
    expect(ownerHarness.rpc.closeSocks).not.toHaveBeenCalled();

    await client.stopSocks5Proxy(newcomer.id);
    expect(ownerHarness.rpc.closeSocks).not.toHaveBeenCalled();
    const payload = Buffer.from([0x05, 0x01, 0x00]);
    const received = readExactly(first, payload.length);
    await write(first, payload);
    expect(await received).toEqual(payload);
    expect(client.listSocks5Proxies()).toEqual([owner]);

    await client.stopSocks5Proxy(owner.id);
    await waitForSocketClose(first);
    expect(ownerHarness.rpc.closeSocks).toHaveBeenCalledTimes(1);
    expect(ownerHarness.rpc.closeSocks).toHaveBeenCalledWith(
      { TunnelID: "100", SessionID: "session-1" },
      { signal: expect.any(AbortSignal) },
    );
    await client.disconnect();
  });

  test("scopes shared SOCKS ownership by session as well as tunnel id", async () => {
    const firstHarness = new SocksStreamHarness();
    const secondHarness = new SocksStreamHarness();
    const firstStream = firstHarness.rpc.socksProxy.getMockImplementation()!;
    firstHarness.rpc.socksProxy
      .mockImplementationOnce(firstStream)
      .mockImplementationOnce(secondHarness.rpc.socksProxy);
    firstHarness.rpc.createSocks.mockImplementation(async (request: { SessionID: string }) => ({
      TunnelID: "100", SessionID: request.SessionID, Capabilities: "4",
    }));
    const client = clientWithSocks(firstHarness);
    const first = await client.startSocks5Proxy("session-1", options());
    const second = await client.startSocks5Proxy("session-2", options());
    liveProxies.add(first);
    liveProxies.add(second);
    await connect(first);
    await firstHarness.waitForFrame(isLifecycleMarker);
    await connect(second);
    await secondHarness.waitForFrame(isLifecycleMarker);

    expect(first.state).toMatchObject({ status: "listening", activeConnections: 1 });
    expect(second.state).toMatchObject({ status: "listening", activeConnections: 1 });
    await client.stopSocks5Proxy(first.id);
    expect(second.state).toMatchObject({ status: "listening", activeConnections: 1 });
    expect(firstHarness.rpc.closeSocks).toHaveBeenCalledTimes(1);
    expect(firstHarness.rpc.closeSocks).toHaveBeenCalledWith(
      { TunnelID: "100", SessionID: "session-1" },
      { signal: expect.any(AbortSignal) },
    );
    await client.stopSocks5Proxy(second.id);
    expect(firstHarness.rpc.closeSocks).toHaveBeenCalledTimes(2);
    expect(firstHarness.rpc.closeSocks).toHaveBeenLastCalledWith(
      { TunnelID: "100", SessionID: "session-2" },
      { signal: expect.any(AbortSignal) },
    );
    await client.disconnect();
  });

  test("keeps startup cancellation operation-scoped and lifetime abort idempotent", async () => {
    const cancelledHarness = new SocksStreamHarness();
    const startup = new AbortController();
    startup.abort();
    await expect(startSocks5Proxy(
      { rpc: cancelledHarness.rpc as never, sessionId: "session-1" },
      options(),
      { signal: startup.signal },
    )).rejects.toThrow("startup was cancelled");
    expect(cancelledHarness.rpc.socksProxy).not.toHaveBeenCalled();

    const operationHarness = new SocksStreamHarness();
    const operationOwner = new AbortController();
    const operationProxy = await startSocks5Proxy(
      { rpc: operationHarness.rpc as never, sessionId: "session-1" },
      options(),
      { signal: operationOwner.signal },
    );
    liveProxies.add(operationProxy);
    operationOwner.abort();
    await delay(10);
    expect(operationProxy.state.status).toBe("listening");

    const lifetimeHarness = new SocksStreamHarness();
    const lifetime = new AbortController();
    const proxy = await startProxy(lifetimeHarness, { lifetimeSignal: lifetime.signal });
    lifetime.abort();
    await proxy.closed;
    expect(proxy.state).toMatchObject({ status: "closed", reason: "aborted" });
    await expect(proxy.close()).resolves.toBeUndefined();

    const racedHarness = new SocksStreamHarness();
    const racedLifetime = new AbortController();
    const nativeAddEventListener = racedLifetime.signal.addEventListener.bind(racedLifetime.signal);
    Object.defineProperty(racedLifetime.signal, "addEventListener", {
      value: (...args: Parameters<AbortSignal["addEventListener"]>) => {
        racedLifetime.abort();
        nativeAddEventListener(...args);
      },
    });
    await expect(startProxy(racedHarness, { lifetimeSignal: racedLifetime.signal }))
      .rejects.toThrow("startup was cancelled");
    expect(racedHarness.rpc.socksProxy).not.toHaveBeenCalled();
  });

  test("lists, stops, and disconnects client-owned proxy handles", async () => {
    const stopHarness = new SocksStreamHarness();
    const stopClient = clientWithSocks(stopHarness);
    const proxy = await stopClient.startSocks5Proxy("  session-1  ", options());

    const snapshot = stopClient.listSocks5Proxies();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot).toEqual([proxy]);
    await stopClient.stopSocks5Proxy(`  ${proxy.id}  `);
    expect(proxy.state).toMatchObject({ status: "closed", reason: "requested" });
    expect(stopClient.listSocks5Proxies()).toEqual([]);
    await expect(stopClient.stopSocks5Proxy(proxy.id)).resolves.toBeUndefined();

    const disconnectHarness = new SocksStreamHarness();
    const disconnectClient = clientWithSocks(disconnectHarness);
    const disconnectProxy = await disconnectClient.startSocks5Proxy("session-1", options());
    await disconnectClient.disconnect();
    expect(disconnectProxy.state).toMatchObject({ status: "closed", reason: "client-disconnected" });
    expect(disconnectClient.listSocks5Proxies()).toEqual([]);
    expect(disconnectHarness.stopTunnels).toHaveBeenCalledTimes(1);
  });
});

class SocksStreamHarness {
  readonly incoming = new PushAsyncIterable<SocksData>();
  readonly frames: Array<DeepPartial<SocksData>> = [];
  readonly rpc: {
    createSocks: jest.Mock;
    closeSocks: jest.Mock;
    socksProxy: jest.Mock;
  };
  readonly stopTunnels = jest.fn(async () => undefined);

  private readonly waiters = new Set<() => void>();
  private readonly inboundSequences = new Map<string, bigint>();
  private nextTunnelId = 100n;

  constructor(private readonly behavior: {
    echo?: boolean;
    acknowledge?: boolean;
    stallAfterFrames?: number;
    deferSerializationUntilSuccessorPull?: boolean;
  } = {}) {
    this.rpc = {
      createSocks: jest.fn(async (request: { SessionID?: string }) => ({
        TunnelID: (this.nextTunnelId++).toString(),
        SessionID: request.SessionID ?? "",
        Capabilities: "4",
      })),
      closeSocks: jest.fn(async () => ({})),
      socksProxy: jest.fn((outgoing: AsyncIterable<DeepPartial<SocksData>>, call: { signal: AbortSignal }) => {
        call.signal.addEventListener("abort", () => this.incoming.close(), { once: true });
        void this.consume(outgoing).catch(() => undefined);
        return this.incoming;
      }),
    };
  }

  push(frame: SocksData): void {
    this.incoming.push(frame);
  }

  dataFrames(tunnelId: string): Array<DeepPartial<SocksData>> {
    return this.frames.filter((frame) => frame.TunnelID === tunnelId && (frame.Data?.length ?? 0) > 0);
  }

  async waitForFrame(predicate: (frame: DeepPartial<SocksData>) => boolean): Promise<DeepPartial<SocksData>> {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const existing = this.frames.find(predicate);
      if (existing) return existing;
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.waiters.delete(wake);
          resolve();
        }, 5);
        const wake = () => {
          clearTimeout(timeout);
          this.waiters.delete(wake);
          resolve();
        };
        this.waiters.add(wake);
      });
    }
    throw new Error("Timed out waiting for SOCKS5 frame");
  }

  private async consume(outgoing: AsyncIterable<DeepPartial<SocksData>>): Promise<void> {
    const iterator = outgoing[Symbol.asyncIterator]();
    let nextResult = iterator.next();
    for (;;) {
      const result = await nextResult;
      if (result.done) return;
      const original = result.value;
      // grpc-js may retain the object passed to call.write() and serialize it
      // only after nice-grpc has requested the next iterator item. Model that
      // ownership boundary so premature buffer zeroing is caught locally.
      const deferredSuccessor = this.behavior.deferSerializationUntilSuccessorPull
        ? iterator.next()
        : undefined;
      const frame: DeepPartial<SocksData> = {
        ...original,
        ...(original.Data ? { Data: Buffer.from(original.Data) } : {}),
        ...(original.Request ? { Request: { ...original.Request } } : {}),
      };
      this.frames.push(frame);
      for (const wake of [...this.waiters]) wake();
      if (this.behavior.stallAfterFrames === this.frames.length) return;

      if ((frame.Data?.length ?? 0) > 0) {
        const sequence = BigInt(frame.Sequence ?? "0");
        if (this.behavior.acknowledge) this.push(ackFrame(frame.TunnelID!, (sequence + 1n).toString()));
        if (this.behavior.echo) {
          const inbound = this.inboundSequences.get(frame.TunnelID!) ?? 0n;
          this.push(dataFrame(frame.TunnelID!, inbound.toString(), Buffer.from(frame.Data!)));
          this.inboundSequences.set(frame.TunnelID!, inbound + 1n);
        }
      }
      if (frame.CloseConn && this.behavior.echo) {
        const inbound = this.inboundSequences.get(frame.TunnelID!) ?? 0n;
        this.push(terminalFrame(frame.TunnelID!, inbound.toString()));
      }
      nextResult = deferredSuccessor ?? iterator.next();
    }
  }
}

function clientWithSocks(harness: SocksStreamHarness): SliverClient {
  const client = new SliverClient({
    operator: "socks-test",
    token: "token",
    lhost: "127.0.0.1",
    lport: 31_337,
    ca_certificate: "ca",
    certificate: "certificate",
    private_key: "private-key",
  });
  const internals = client as unknown as {
    rpcClients: Record<string, object>;
    tunnels: { stop(): Promise<void> };
  };
  internals.rpcClients.control = harness.rpc;
  internals.rpcClients["tunnel-stream"] = harness.rpc;
  internals.tunnels = { stop: harness.stopTunnels };
  return client;
}

class PushAsyncIterable<T> implements AsyncIterable<T> {
  private readonly queue: T[] = [];
  private waiter: { resolve: (result: IteratorResult<T>) => void; reject: (error: unknown) => void } | null = null;
  private closed = false;
  private failure: unknown;

  push(value: T): void {
    if (this.closed) return;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.resolve({ value, done: false });
    } else {
      this.queue.push(value);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.resolve({ value: undefined as never, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.closed) return;
    this.failure = error;
    this.closed = true;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        if (this.failure !== undefined) throw this.failure;
        const value = this.queue.shift();
        if (value !== undefined) return { value, done: false };
        if (this.closed) return { value: undefined as never, done: true };
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiter = { resolve, reject };
        });
      },
    };
  }
}

function options(overrides: Partial<Socks5ProxyOptions> = {}): Socks5ProxyOptions {
  return {
    bind: { host: "127.0.0.1", port: 0 },
    ...overrides,
  };
}

async function startProxy(
  harness: SocksStreamHarness,
  overrides: Partial<Socks5ProxyOptions> = {},
  dependencyOverrides: {
    firstPayloadTimeoutMilliseconds?: number;
    maxTotalIncomingBytes?: number;
  } = {},
): Promise<ManagedSocks5Proxy> {
  const proxy = await startSocks5Proxy(
    { rpc: harness.rpc as never, sessionId: "session-1", ...dependencyOverrides },
    options(overrides),
  );
  liveProxies.add(proxy);
  return proxy;
}

async function connect(proxy: Socks5Proxy): Promise<Socket> {
  const socket = await connectAddress(proxy.bind);
  liveSockets.add(socket);
  socket.on("error", () => undefined);
  return socket;
}

async function connectAddress(address: { readonly host: string; readonly port: number }): Promise<Socket> {
  const socket = net.createConnection(address);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function allocatePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing allocated TCP port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function write(socket: Socket, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(data, (error?: Error | null) => error ? reject(error) : resolve());
  });
}

function readExactly(socket: Socket, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    const onData = (chunk: Buffer) => {
      chunks.push(Buffer.from(chunk));
      received += chunk.length;
      if (received >= length) {
        cleanup();
        resolve(Buffer.concat(chunks, received).subarray(0, length));
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Socket closed before expected data arrived"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

function waitForSocketClose(socket: Socket): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve) => socket.once("close", () => resolve()));
}

function isLifecycleMarker(frame: DeepPartial<SocksData>): boolean {
  return frame.Sequence === SOCKS5_TEST_CONSTANTS.lifecycleBindSequence;
}

function dataFrame(tunnelId: string, sequence: string, data: Buffer): SocksData {
  return fullFrame({ TunnelID: tunnelId, Sequence: sequence, Data: data });
}

function terminalFrame(tunnelId: string, sequence: string): SocksData {
  return fullFrame({ TunnelID: tunnelId, Sequence: sequence, CloseConn: true });
}

function ackFrame(tunnelId: string, ack: string): SocksData {
  return fullFrame({ TunnelID: tunnelId, Ack: ack });
}

function fullFrame(partial: Partial<SocksData>): SocksData {
  return {
    Data: Buffer.alloc(0),
    CloseConn: false,
    Username: "",
    Password: "",
    Sequence: "0",
    Ack: "0",
    Capabilities: "0",
    TunnelID: "",
    Request: undefined,
    ...partial,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error("Timed out waiting for test condition");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}
