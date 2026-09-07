import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net, { type AddressInfo, type Server, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import type { E2ESuiteContext } from "../context";

export const name = "10-forwarding";

const host = "127.0.0.1";
const operationTimeoutSeconds = 30;
const ioTimeoutMilliseconds = 30_000;
const maximumFixtureBytes = 2 * 1024 * 1024;
const localForwardBufferBytes = 1024 * 1024;
const frameHeaderBytes = 4;

interface Address {
  readonly host: string;
  readonly port: number;
}

interface ClosableForward {
  close(): Promise<void>;
}

interface Fixture {
  readonly address: Address;
  close(): Promise<void>;
}

interface HttpObservation {
  readonly method: string;
  readonly path: string;
  readonly marker: string;
  readonly bytes: number;
  readonly digest: string;
}

interface HttpFixture extends Fixture {
  readonly observations: HttpObservation[];
}

interface FrameFixture extends Fixture {
  readonly digests: string[];
  readonly connections: FrameConnectionObservation[];
}

interface FrameConnectionObservation {
  readonly chunks: number[];
  readonly completedFrames: number[];
  bufferedBytes: number;
  closed: boolean;
}

interface ForwardConnectionEvent {
  readonly connectionId: string;
  readonly status: string;
}

interface HttpResponse {
  readonly statusCode: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Buffer;
}

export async function run(context: E2ESuiteContext): Promise<void> {
  const sessionId = context.session?.session?.ID;
  assert.ok(sessionId, "live session fixture");

  const [httpFixture, frameFixture] = await Promise.all([
    startHttpFixture(),
    startFrameFixture(),
  ]);
  const openForwards = new Set<ClosableForward>();
  let failure: unknown;
  try {
    console.log("[forwarding] exercising local TCP port forwards");
    await exercisePortForwards(context, sessionId, httpFixture, frameFixture, openForwards);
    console.log("[forwarding] exercising SOCKS5 no-auth and authenticated proxies");
    await exerciseSocks5(context, sessionId, frameFixture, openForwards);
    console.log("[forwarding] exercising reverse TCP port forwards");
    await exerciseReversePortForwards(context, sessionId, httpFixture, frameFixture, openForwards);

    assert.deepEqual(
      httpFixture.observations.map((observation) => observation.marker),
      ["portfwd-http", "rportfwd-http"],
      "HTTP target traffic order",
    );
    assert.equal(frameFixture.digests.length, 6, "binary target frame count across forwarding modes");
  } catch (error) {
    failure = error;
  }

  const cleanupErrors = await cleanup(openForwards, [frameFixture, httpFixture]);
  if (failure && cleanupErrors.length > 0) {
    throw new AggregateError([failure, ...cleanupErrors], "Forwarding E2E and cleanup failed");
  }
  if (failure) throw failure;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Forwarding E2E cleanup failed");
}

async function exercisePortForwards(
  context: E2ESuiteContext,
  sessionId: string,
  httpFixture: HttpFixture,
  frameFixture: FrameFixture,
  openForwards: Set<ClosableForward>,
): Promise<void> {
  const httpForward = await context.client.startPortForward(
    sessionId,
    {
      bind: { host, port: 0 },
      target: httpFixture.address,
      keepAliveSeconds: 5,
      connectTimeoutSeconds: 20,
      closeTimeoutSeconds: 20,
      maxConnections: 8,
      maxBufferedBytesPerConnection: localForwardBufferBytes,
    },
    { timeoutSeconds: operationTimeoutSeconds },
  );
  openForwards.add(httpForward);
  assert.equal(httpForward.sessionId, sessionId, "HTTP port-forward session ID");
  assert.equal(httpForward.state.status, "listening", "HTTP port-forward initial state");
  assert.equal(httpForward.bind.host, host, "HTTP port-forward bind host");
  assert.ok(httpForward.bind.port > 0, "HTTP port-forward ephemeral bind port");
  assert.deepEqual(httpForward.target, httpFixture.address, "HTTP port-forward target");

  const httpEvents: ForwardConnectionEvent[] = [];
  const httpSubscription = httpForward.connection$.subscribe((event) => httpEvents.push(event));
  try {
    const body = deterministicBytes(8_321, 0x31);
    const response = await requestHttp(httpForward.bind, "/portfwd?protocol=http", "portfwd-http", body);
    assertHttpResponse(response, "portfwd-http", body);
    console.log("[forwarding] HTTP port-forward round trip passed");
    await waitForLocalForwardIdle(httpForward, 1, "HTTP port-forward");
    assertConnectionLifecycle(httpEvents, 1, "HTTP port-forward");
    assert.ok(httpForward.state.bytesToTarget >= body.length, "HTTP port-forward outbound byte count");
    assert.ok(httpForward.state.bytesFromTarget > 0, "HTTP port-forward inbound byte count");
  } finally {
    httpSubscription.unsubscribe();
  }

  const frameForward = await context.client.startPortForward(
    sessionId,
    {
      bind: { host, port: 0 },
      target: frameFixture.address,
      keepAliveSeconds: 5,
      connectTimeoutSeconds: 20,
      closeTimeoutSeconds: 20,
      maxConnections: 8,
      maxBufferedBytesPerConnection: localForwardBufferBytes,
    },
    { timeoutSeconds: operationTimeoutSeconds },
  );
  openForwards.add(frameForward);
  assert.equal(frameForward.state.status, "listening", "binary port-forward initial state");
  assert.ok(frameForward.bind.port > 0, "binary port-forward ephemeral bind port");
  assert.deepEqual(frameForward.target, frameFixture.address, "binary port-forward target");

  const frameEvents: ForwardConnectionEvent[] = [];
  const frameSubscription = frameForward.connection$.subscribe((event) => frameEvents.push(event));
  try {
    await framedRoundTrip(frameForward.bind, [
      deterministicBytes(2 * 65_536 + 257, 0x51),
      Buffer.from([0x00, 0xff, 0x7f, 0x80, 0x00, 0x42]),
    ]);
    console.log("[forwarding] binary port-forward round trips passed");
    await waitForLocalForwardIdle(frameForward, 1, "binary port-forward");
    assertConnectionLifecycle(frameEvents, 1, "binary port-forward");
    assert.ok(
      frameForward.state.bytesToTarget > 2 * 65_536,
      "binary port-forward must cross multiple Sliver frames",
    );
    assert.ok(
      frameForward.state.bytesFromTarget > 2 * 65_536,
      "binary port-forward response must cross multiple Sliver frames",
    );
  } finally {
    frameSubscription.unsubscribe();
  }

  const released = [httpForward.bind, frameForward.bind];
  await closeTracked(httpForward, openForwards);
  await closeTracked(httpForward, openForwards);
  await closeTracked(frameForward, openForwards);
  await closeTracked(frameForward, openForwards);
  assert.equal(httpForward.state.status, "closed", "HTTP port-forward closed state");
  assert.equal(frameForward.state.status, "closed", "binary port-forward closed state");
  for (const address of released) await waitForBindable(address, "closed port-forward bind");
}

async function exerciseSocks5(
  context: E2ESuiteContext,
  sessionId: string,
  frameFixture: FrameFixture,
  openForwards: Set<ClosableForward>,
): Promise<void> {
  const noAuth = await context.client.startSocks5Proxy(
    sessionId,
    {
      bind: { host, port: 0 },
      connectTimeoutSeconds: 20,
      closeTimeoutSeconds: 20,
      maxConnections: 8,
      maxBufferedBytesPerConnection: localForwardBufferBytes,
    },
    { timeoutSeconds: operationTimeoutSeconds },
  );
  openForwards.add(noAuth);
  assert.equal(noAuth.sessionId, sessionId, "no-auth SOCKS session ID");
  assert.equal(noAuth.state.status, "listening", "no-auth SOCKS initial state");
  assert.ok(noAuth.bind.port > 0, "no-auth SOCKS ephemeral bind port");

  const noAuthEvents: ForwardConnectionEvent[] = [];
  const noAuthSubscription = noAuth.connection$.subscribe((event) => noAuthEvents.push(event));
  try {
    const tunnel = await openSocksTunnel(noAuth.bind, frameFixture.address, "ipv4");
    try {
      await framedRoundTripOnSocket(tunnel.socket, tunnel.reader, [deterministicBytes(32_777, 0x71)]);
    } finally {
      await closeSocket(tunnel.socket);
    }
    console.log("[forwarding] SOCKS5 IPv4 no-auth round trip passed");
    await waitForLocalForwardIdle(noAuth, 1, "no-auth SOCKS");
    assertConnectionLifecycle(noAuthEvents, 1, "no-auth SOCKS");
  } finally {
    noAuthSubscription.unsubscribe();
  }

  const authentication = {
    username: "sliver-script-e2e",
    password: "sliver-script-e2e-password",
  };
  const authenticated = await context.client.startSocks5Proxy(
    sessionId,
    {
      bind: { host, port: 0 },
      authentication,
      connectTimeoutSeconds: 20,
      closeTimeoutSeconds: 20,
      maxConnections: 8,
      maxBufferedBytesPerConnection: localForwardBufferBytes,
    },
    { timeoutSeconds: operationTimeoutSeconds },
  );
  openForwards.add(authenticated);
  assert.equal(authenticated.state.status, "listening", "authenticated SOCKS initial state");
  assert.ok(authenticated.bind.port > 0, "authenticated SOCKS ephemeral bind port");

  await assertSocksAuthenticationRejected(authenticated.bind, {
    username: authentication.username,
    password: `${authentication.password}-wrong`,
  });
  const domainTunnel = await openSocksTunnel(
    authenticated.bind,
    { host: "localhost", port: frameFixture.address.port },
    "domain",
    authentication,
  );
  try {
    await framedRoundTripOnSocket(
      domainTunnel.socket,
      domainTunnel.reader,
      [deterministicBytes(17_111, 0x91)],
    );
  } finally {
    await closeSocket(domainTunnel.socket);
  }
  console.log("[forwarding] SOCKS5 domain authenticated round trip passed");
  await waitForLocalForwardIdle(authenticated, 2, "authenticated SOCKS");
  assert.ok(authenticated.state.bytesToTarget > 0, "authenticated SOCKS outbound byte count");
  assert.ok(authenticated.state.bytesFromTarget > 0, "authenticated SOCKS inbound byte count");

  const released = [noAuth.bind, authenticated.bind];
  await closeTracked(noAuth, openForwards);
  await closeTracked(noAuth, openForwards);
  await closeTracked(authenticated, openForwards);
  await closeTracked(authenticated, openForwards);
  assert.equal(noAuth.state.status, "closed", "no-auth SOCKS closed state");
  assert.equal(authenticated.state.status, "closed", "authenticated SOCKS closed state");
  for (const address of released) await waitForBindable(address, "closed SOCKS bind");
}

async function exerciseReversePortForwards(
  context: E2ESuiteContext,
  sessionId: string,
  httpFixture: HttpFixture,
  frameFixture: FrameFixture,
  openForwards: Set<ClosableForward>,
): Promise<void> {
  const [httpBindPort, frameBindPort] = await Promise.all([
    context.allocateLoopbackPort(),
    context.allocateLoopbackPort(),
  ]);
  assert.notEqual(httpBindPort, frameBindPort, "reverse port-forward bind ports");

  const httpReverse = await context.client.startReversePortForward(
    sessionId,
    {
      bind: { host, port: httpBindPort },
      target: httpFixture.address,
      keepAliveSeconds: 5,
    },
    { timeoutSeconds: operationTimeoutSeconds },
  );
  openForwards.add(httpReverse);
  const frameReverse = await context.client.startReversePortForward(
    sessionId,
    {
      bind: { host, port: frameBindPort },
      target: frameFixture.address,
      keepAliveSeconds: 5,
    },
    { timeoutSeconds: operationTimeoutSeconds },
  );
  openForwards.add(frameReverse);

  for (const [label, reverse] of [["HTTP", httpReverse], ["binary", frameReverse]] as const) {
    assert.ok(reverse.id > 0, `${label} reverse port-forward listener ID`);
    assert.equal(reverse.sessionId, sessionId, `${label} reverse port-forward session ID`);
    assert.equal(reverse.state.status, "listening", `${label} reverse port-forward initial state`);
    assert.equal(
      (await reverse.refresh({ timeoutSeconds: operationTimeoutSeconds })).status,
      "listening",
      `${label} reverse port-forward refreshed state`,
    );
  }
  assert.deepEqual(httpReverse.bind, { host, port: httpBindPort }, "HTTP reverse bind");
  assert.deepEqual(httpReverse.target, httpFixture.address, "HTTP reverse target");
  assert.deepEqual(frameReverse.bind, { host, port: frameBindPort }, "binary reverse bind");
  assert.deepEqual(frameReverse.target, frameFixture.address, "binary reverse target");

  const managedReverseForwards = [
    {
      label: "HTTP",
      handle: httpReverse,
      identity: {
        id: httpReverse.id,
        sessionId: httpReverse.sessionId,
        bind: { ...httpReverse.bind },
        target: { ...httpReverse.target },
      },
    },
    {
      label: "binary",
      handle: frameReverse,
      identity: {
        id: frameReverse.id,
        sessionId: frameReverse.sessionId,
        bind: { ...frameReverse.bind },
        target: { ...frameReverse.target },
      },
    },
  ] as const;

  const inventory = await context.client.listReversePortForwards(
    sessionId,
    { timeoutSeconds: operationTimeoutSeconds },
  );
  for (const { handle: reverse } of managedReverseForwards) {
    const listed = inventory.find((candidate) => candidate.id === reverse.id);
    assert.ok(listed, `reverse port-forward ${reverse.id} inventory`);
    assert.equal(listed.sessionId, sessionId, `reverse port-forward ${reverse.id} inventory session`);
    assert.deepEqual(listed.bind, reverse.bind, `reverse port-forward ${reverse.id} inventory bind`);
    assert.deepEqual(listed.target, reverse.target, `reverse port-forward ${reverse.id} inventory target`);
  }

  try {
    await context.client.disconnect();
    assert.equal(context.client.isConnected, false, "forwarding lifecycle client disconnected state");
    for (const { label, handle } of managedReverseForwards) {
      assert.deepEqual(
        handle.state,
        { status: "detached", reason: "client-disconnected" },
        `${label} reverse handle synchronously detached on client disconnect`,
      );
    }

    assert.equal(await context.client.connect(), context.client, "forwarding lifecycle reconnect result");
    assert.equal(context.client.isConnected, true, "forwarding lifecycle client reconnected state");
    for (const { label, handle, identity } of managedReverseForwards) {
      assert.deepEqual(handle.state, { status: "listening" }, `${label} reverse handle reconciled state`);
      assert.equal(handle.id, identity.id, `${label} reverse handle listener identity`);
      assert.equal(handle.sessionId, identity.sessionId, `${label} reverse handle session identity`);
      assert.deepEqual(handle.bind, identity.bind, `${label} reverse handle bind identity`);
      assert.deepEqual(handle.target, identity.target, `${label} reverse handle target identity`);
    }

    const reconnectedInventory = await context.client.listReversePortForwards(
      sessionId,
      { timeoutSeconds: operationTimeoutSeconds },
    );
    for (const { label, identity } of managedReverseForwards) {
      const listed = reconnectedInventory.find((candidate) => candidate.id === identity.id);
      assert.ok(listed, `${label} reverse listener remains in authoritative inventory after reconnect`);
      assert.equal(listed.sessionId, identity.sessionId, `${label} reverse inventory session after reconnect`);
      assert.deepEqual(listed.bind, identity.bind, `${label} reverse inventory bind after reconnect`);
      assert.deepEqual(listed.target, identity.target, `${label} reverse inventory target after reconnect`);
    }
  } finally {
    // Later forwarding teardown and the suite context both require a connected
    // control client. Preserve the primary assertion error while making one
    // best-effort public reconnect if disconnect/reconciliation failed midway.
    if (!context.client.isConnected) {
      await context.client.connect().catch(() => {
        console.warn("[forwarding] best-effort reconnect failed; suite cleanup will retry");
      });
    }
  }
  console.log("[forwarding] managed reverse port forwards survived operator reconnect");

  const body = deterministicBytes(7_777, 0xb1);
  const response = await requestHttp(httpReverse.bind, "/rportfwd?protocol=http", "rportfwd-http", body);
  assertHttpResponse(response, "rportfwd-http", body);
  console.log("[forwarding] HTTP reverse port-forward round trip passed");
  const reverseConnectionOffset = frameFixture.connections.length;
  const reversePayloads = [
    // encodeFrame() adds a four-byte length prefix. Each fresh connection's
    // first socket write is therefore exactly 32,769 or 65,537 bytes, crossing
    // the implant's 32 KiB copy boundary and the Sliver frame boundary while
    // the corresponding reverse tunnel is still being published.
    deterministicBytes(32_769 - frameHeaderBytes, 0xd1),
    deterministicBytes(65_537 - frameHeaderBytes, 0xe1),
  ];
  try {
    for (const payload of reversePayloads) {
      await framedRoundTrip(frameReverse.bind, [payload]);
    }
    const observations = frameFixture.connections.slice(reverseConnectionOffset);
    assert.equal(observations.length, 2, "binary reverse target accepted two fresh connections");
    for (const [index, observation] of observations.entries()) {
      const payload = reversePayloads[index]!;
      assert.deepEqual(
        observation.completedFrames,
        [payload.length],
        `binary reverse target connection ${index + 1} completed exactly its first frame`,
      );
      assert.equal(
        observation.chunks.reduce((total, bytes) => total + bytes, 0),
        payload.length + frameHeaderBytes,
        `binary reverse target connection ${index + 1} observed the exact encoded byte count`,
      );
      assert.equal(
        observation.bufferedBytes,
        0,
        `binary reverse target connection ${index + 1} retained no partial frame`,
      );
    }
  } finally {
    const observations = frameFixture.connections.slice(reverseConnectionOffset);
    observations.forEach((observation, index) => {
      console.log(`[forwarding] binary reverse target ${index + 1} ${summarizeFrameConnection(observation)}`);
    });
  }
  console.log("[forwarding] binary reverse port-forward round trip passed");

  await context.client.stopReversePortForward(
    sessionId,
    httpReverse.id,
    { timeoutSeconds: operationTimeoutSeconds },
  );
  await waitForReverseInventoryAbsence(context, sessionId, httpReverse.id);
  assert.equal(
    (await httpReverse.refresh({ timeoutSeconds: operationTimeoutSeconds })).status,
    "stopped",
    "statelessly stopped managed reverse handle state",
  );
  await closeTracked(httpReverse, openForwards);
  await closeTracked(httpReverse, openForwards);

  await closeTracked(frameReverse, openForwards);
  await closeTracked(frameReverse, openForwards);
  assert.equal(frameReverse.state.status, "stopped", "statefully stopped reverse handle state");
  await waitForReverseInventoryAbsence(context, sessionId, frameReverse.id);
  for (const address of [httpReverse.bind, frameReverse.bind]) {
    await waitForBindable(address, "stopped reverse port-forward bind");
  }
}

async function startHttpFixture(): Promise<HttpFixture> {
  const observations: HttpObservation[] = [];
  const sockets = new Set<Socket>();
  const server = http.createServer((request, response) => {
    void handleHttpRequest(request, response, observations).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      response.writeHead(500, { connection: "close", "content-type": "text/plain" });
      response.end("fixture error");
    });
  });
  trackConnections(server, sockets);
  const address = await listen(server);
  return { address, observations, close: () => closeServer(server, sockets) };
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  observations: HttpObservation[],
): Promise<void> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    bytes += chunk.length;
    if (bytes > maximumFixtureBytes) throw new Error("HTTP fixture request exceeded its byte limit");
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks, bytes);
  const markerHeader = request.headers["x-sliver-e2e-marker"];
  const marker = Array.isArray(markerHeader) ? markerHeader[0] : markerHeader;
  assert.ok(marker, "HTTP fixture marker header");
  const observation: HttpObservation = {
    method: request.method ?? "",
    path: request.url ?? "",
    marker,
    bytes,
    digest: sha256(body),
  };
  observations.push(observation);
  response.writeHead(200, {
    connection: "close",
    "content-type": "application/json",
    "x-sliver-e2e-target": "http",
  });
  response.end(JSON.stringify(observation));
}

async function startFrameFixture(): Promise<FrameFixture> {
  const digests: string[] = [];
  const connections: FrameConnectionObservation[] = [];
  const sockets = new Set<Socket>();
  const server = net.createServer((socket) => {
    const observation: FrameConnectionObservation = {
      chunks: [],
      completedFrames: [],
      bufferedBytes: 0,
      closed: false,
    };
    connections.push(observation);
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      observation.chunks.push(chunk.length);
      if (buffered.length + chunk.length > maximumFixtureBytes) {
        socket.destroy(new Error("Frame fixture input exceeded its byte limit"));
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      observation.bufferedBytes = buffered.length;
      while (buffered.length >= 4) {
        const length = buffered.readUInt32BE(0);
        if (length > maximumFixtureBytes) {
          socket.destroy(new Error("Frame fixture declared an oversized frame"));
          return;
        }
        if (buffered.length < length + 4) return;
        const payload = Buffer.from(buffered.subarray(4, length + 4));
        buffered = Buffer.from(buffered.subarray(length + 4));
        observation.bufferedBytes = buffered.length;
        observation.completedFrames.push(payload.length);
        digests.push(sha256(payload));
        socket.write(encodeFrame(payload));
      }
    });
    socket.once("close", () => {
      observation.closed = true;
      observation.bufferedBytes = buffered.length;
    });
  });
  trackConnections(server, sockets);
  const address = await listen(server);
  return { address, digests, connections, close: () => closeServer(server, sockets) };
}

function summarizeFrameConnection(observation: FrameConnectionObservation | undefined): string {
  if (!observation) return "accepted=false";
  const totalBytes = observation.chunks.reduce((total, bytes) => total + bytes, 0);
  return JSON.stringify({
    accepted: true,
    chunks: observation.chunks,
    totalBytes,
    completedFrames: observation.completedFrames,
    bufferedBytes: observation.bufferedBytes,
    closed: observation.closed,
  });
}

function trackConnections(server: Server, sockets: Set<Socket>): void {
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(ioTimeoutMilliseconds, () => socket.destroy());
  });
}

async function listen(server: Server, port = 0): Promise<Address> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen({ host, port, exclusive: true }, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string", "TCP fixture address");
  return { host, port: (address as AddressInfo).port };
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function requestHttp(
  address: Address,
  requestPath: string,
  marker: string,
  body: Buffer,
): Promise<HttpResponse> {
  return withTimeout(new Promise<HttpResponse>((resolve, reject) => {
    const request = http.request({
      host: address.host,
      port: address.port,
      path: requestPath,
      method: "POST",
      agent: false,
      headers: {
        connection: "close",
        "content-length": body.length,
        "content-type": "application/octet-stream",
        "x-sliver-e2e-marker": marker,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maximumFixtureBytes) {
          response.destroy(new Error("HTTP response exceeded its byte limit"));
          return;
        }
        chunks.push(chunk);
      });
      response.once("end", () => resolve({
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks, bytes),
      }));
      response.once("error", reject);
    });
    request.once("error", reject);
    request.setTimeout(ioTimeoutMilliseconds, () => request.destroy(new Error("HTTP request timed out")));
    request.end(body);
  }), ioTimeoutMilliseconds, `HTTP request through ${marker}`);
}

function assertHttpResponse(response: HttpResponse, marker: string, body: Buffer): void {
  assert.equal(response.statusCode, 200, `${marker} HTTP status`);
  assert.equal(response.headers["x-sliver-e2e-target"], "http", `${marker} target header`);
  const parsed = JSON.parse(response.body.toString("utf8")) as Partial<HttpObservation>;
  assert.equal(parsed.method, "POST", `${marker} HTTP method`);
  assert.equal(parsed.marker, marker, `${marker} HTTP marker`);
  assert.equal(parsed.bytes, body.length, `${marker} HTTP body length`);
  assert.equal(parsed.digest, sha256(body), `${marker} HTTP body digest`);
}

async function framedRoundTrip(address: Address, payloads: readonly Buffer[]): Promise<void> {
  const socket = await connectTcp(address);
  const reader = new SocketReader(socket);
  try {
    await framedRoundTripOnSocket(socket, reader, payloads);
  } finally {
    await closeSocket(socket);
  }
}

async function framedRoundTripOnSocket(
  socket: Socket,
  reader: SocketReader,
  payloads: readonly Buffer[],
): Promise<void> {
  for (const payload of payloads) {
    await writeSocket(socket, encodeFrame(payload));
    const header = await reader.readExactly(4, ioTimeoutMilliseconds);
    const length = header.readUInt32BE(0);
    assert.equal(length, payload.length, "echoed binary frame length");
    const echoed = await reader.readExactly(length, ioTimeoutMilliseconds);
    assert.equal(sha256(echoed), sha256(payload), "echoed binary frame digest");
    assert.deepEqual(echoed, payload, "echoed binary frame bytes");
  }
}

function encodeFrame(payload: Buffer): Buffer {
  const header = Buffer.allocUnsafe(frameHeaderBytes);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

async function openSocksTunnel(
  proxy: Address,
  target: Address,
  addressType: "ipv4" | "domain",
  authentication?: { readonly username: string; readonly password: string },
): Promise<{ readonly socket: Socket; readonly reader: SocketReader }> {
  const socket = await connectTcp(proxy);
  const reader = new SocketReader(socket);
  try {
    if (authentication) {
      await writeSocket(socket, Buffer.from([0x05, 0x01, 0x02]));
      assert.deepEqual(
        await reader.readExactly(2, ioTimeoutMilliseconds),
        Buffer.from([0x05, 0x02]),
        "SOCKS username/password method selection",
      );
      await writeSocket(socket, encodeSocksCredentials(authentication));
      assert.deepEqual(
        await reader.readExactly(2, ioTimeoutMilliseconds),
        Buffer.from([0x01, 0x00]),
        "SOCKS authentication success",
      );
    } else {
      await writeSocket(socket, Buffer.from([0x05, 0x01, 0x00]));
      assert.deepEqual(
        await reader.readExactly(2, ioTimeoutMilliseconds),
        Buffer.from([0x05, 0x00]),
        "SOCKS no-auth method selection",
      );
    }

    await writeSocket(socket, encodeSocksConnect(target, addressType));
    const reply = await reader.readExactly(4, ioTimeoutMilliseconds);
    assert.equal(reply[0], 0x05, "SOCKS CONNECT reply version");
    assert.equal(reply[1], 0x00, `SOCKS CONNECT reply code ${reply[1]}`);
    assert.equal(reply[2], 0x00, "SOCKS CONNECT reserved byte");
    await readSocksBoundAddress(reader, reply[3] ?? -1);
    return { socket, reader };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function assertSocksAuthenticationRejected(
  proxy: Address,
  authentication: { readonly username: string; readonly password: string },
): Promise<void> {
  const socket = await connectTcp(proxy);
  const reader = new SocketReader(socket);
  try {
    await writeSocket(socket, Buffer.from([0x05, 0x01, 0x02]));
    assert.deepEqual(
      await reader.readExactly(2, ioTimeoutMilliseconds),
      Buffer.from([0x05, 0x02]),
      "SOCKS rejected-auth method selection",
    );
    await writeSocket(socket, encodeSocksCredentials(authentication));
    const response = await reader.readExactly(2, ioTimeoutMilliseconds);
    assert.equal(response[0], 0x01, "SOCKS rejected-auth version");
    assert.notEqual(response[1], 0x00, "SOCKS rejects an incorrect password");
  } finally {
    socket.destroy();
  }
}

function encodeSocksCredentials(authentication: { readonly username: string; readonly password: string }): Buffer {
  const username = Buffer.from(authentication.username, "utf8");
  const password = Buffer.from(authentication.password, "utf8");
  assert.ok(username.length > 0 && username.length <= 255, "SOCKS username length");
  assert.ok(password.length > 0 && password.length <= 255, "SOCKS password length");
  return Buffer.concat([
    Buffer.from([0x01, username.length]),
    username,
    Buffer.from([password.length]),
    password,
  ]);
}

function encodeSocksConnect(target: Address, addressType: "ipv4" | "domain"): Buffer {
  const port = Buffer.from([target.port >>> 8, target.port & 0xff]);
  if (addressType === "ipv4") {
    const octets = target.host.split(".").map((part) => Number.parseInt(part, 10));
    assert.equal(octets.length, 4, "SOCKS IPv4 target octet count");
    assert.ok(octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255), "SOCKS IPv4 target");
    return Buffer.from([0x05, 0x01, 0x00, 0x01, ...octets, ...port]);
  }
  const domain = Buffer.from(target.host, "utf8");
  assert.ok(domain.length > 0 && domain.length <= 255, "SOCKS domain target length");
  return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, domain.length]), domain, port]);
}

async function readSocksBoundAddress(reader: SocketReader, addressType: number): Promise<void> {
  if (addressType === 0x01) {
    await reader.readExactly(6, ioTimeoutMilliseconds);
    return;
  }
  if (addressType === 0x04) {
    await reader.readExactly(18, ioTimeoutMilliseconds);
    return;
  }
  if (addressType === 0x03) {
    const length = (await reader.readExactly(1, ioTimeoutMilliseconds))[0];
    assert.ok(length !== undefined, "SOCKS bound domain length");
    await reader.readExactly(length + 2, ioTimeoutMilliseconds);
    return;
  }
  throw new Error(`Unsupported SOCKS bound address type ${addressType}`);
}

class SocketReader {
  private buffered = Buffer.alloc(0);
  private terminalError?: Error;
  private waiting?: { readonly resolve: () => void; readonly reject: (error: Error) => void };

  constructor(socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      if (this.buffered.length + chunk.length > maximumFixtureBytes) {
        const error = new Error("Buffered socket response exceeded its byte limit");
        this.fail(error);
        socket.destroy(error);
        return;
      }
      this.buffered = Buffer.concat([this.buffered, chunk]);
      this.wake();
    });
    socket.once("end", () => this.fail(new Error("Socket ended before the expected response arrived")));
    socket.once("close", () => this.fail(new Error("Socket closed before the expected response arrived")));
    socket.once("error", (error) => this.fail(error));
  }

  async readExactly(bytes: number, timeoutMilliseconds: number): Promise<Buffer> {
    assert.ok(Number.isSafeInteger(bytes) && bytes >= 0, "socket read size");
    while (this.buffered.length < bytes) {
      if (this.terminalError) throw this.terminalError;
      await this.wait(timeoutMilliseconds);
    }
    const value = Buffer.from(this.buffered.subarray(0, bytes));
    this.buffered = Buffer.from(this.buffered.subarray(bytes));
    return value;
  }

  private wait(timeoutMilliseconds: number): Promise<void> {
    assert.equal(this.waiting, undefined, "only one bounded socket read may wait at a time");
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = undefined;
        reject(new Error(`Timed out waiting ${timeoutMilliseconds}ms for socket data`));
      }, timeoutMilliseconds);
      this.waiting = {
        resolve: () => {
          clearTimeout(timer);
          this.waiting = undefined;
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          this.waiting = undefined;
          reject(error);
        },
      };
    });
  }

  private wake(): void {
    this.waiting?.resolve();
  }

  private fail(error: Error): void {
    if (!this.terminalError) this.terminalError = error;
    this.waiting?.reject(this.terminalError);
  }
}

async function connectTcp(address: Address): Promise<Socket> {
  const deadline = Date.now() + ioTimeoutMilliseconds;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    try {
      return await withTimeout(new Promise<Socket>((resolve, reject) => {
        const socket = net.createConnection({ host: address.host, port: address.port });
        const onError = (error: Error): void => {
          socket.destroy();
          reject(error);
        };
        socket.once("error", onError);
        socket.once("connect", () => {
          socket.off("error", onError);
          socket.setNoDelay(true);
          socket.setTimeout(ioTimeoutMilliseconds, () => socket.destroy(new Error("TCP socket timed out")));
          resolve(socket);
        });
      }), 5_000, `TCP connect to ${address.host}:${address.port}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await delay(100);
    }
  }
  throw new Error(`Could not connect to ${address.host}:${address.port}: ${lastError?.message ?? "unknown error"}`);
}

async function writeSocket(socket: Socket, data: Buffer): Promise<void> {
  if (socket.write(data)) return;
  await withTimeout(new Promise<void>((resolve, reject) => {
    const onDrain = (): void => {
      socket.off("error", onError);
      resolve();
    };
    const onError = (error: Error): void => {
      socket.off("drain", onDrain);
      reject(error);
    };
    socket.once("drain", onDrain);
    socket.once("error", onError);
  }), ioTimeoutMilliseconds, "socket write drain");
}

async function closeSocket(socket: Socket): Promise<void> {
  if (socket.destroyed) return;
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.end();
  try {
    await withTimeout(closed, 5_000, "socket close");
  } catch {
    socket.destroy();
    await withTimeout(closed, 5_000, "forced socket close");
  }
}

async function waitForLocalForwardIdle(
  forward: { readonly state: { readonly activeConnections: number; readonly totalConnections: number } },
  expectedConnections: number,
  label: string,
): Promise<void> {
  await waitForCondition(
    () => forward.state.totalConnections >= expectedConnections && forward.state.activeConnections === 0,
    `${label} connection accounting`,
  );
  assert.equal(forward.state.totalConnections, expectedConnections, `${label} total connections`);
}

function assertConnectionLifecycle(
  events: readonly ForwardConnectionEvent[],
  expectedConnections: number,
  label: string,
): void {
  const connectionIds = new Set(events.map((event) => event.connectionId));
  assert.equal(connectionIds.size, expectedConnections, `${label} connection event IDs`);
  for (const connectionId of connectionIds) {
    const statuses = events.filter((event) => event.connectionId === connectionId).map((event) => event.status);
    assert.ok(statuses.includes("open"), `${label} connection ${connectionId} open event`);
    assert.ok(statuses.includes("closed"), `${label} connection ${connectionId} closed event`);
  }
}

async function waitForReverseInventoryAbsence(
  context: E2ESuiteContext,
  sessionId: string,
  listenerId: number,
): Promise<void> {
  await waitForCondition(async () => {
    const inventory = await context.client.listReversePortForwards(
      sessionId,
      { timeoutSeconds: operationTimeoutSeconds },
    );
    return !inventory.some((candidate) => candidate.id === listenerId);
  }, `reverse port-forward ${listenerId} inventory removal`);
}

async function waitForBindable(address: Address, label: string): Promise<void> {
  await waitForCondition(async () => {
    const server = net.createServer();
    try {
      await listen(server, address.port);
      await closeServer(server, new Set());
      return true;
    } catch {
      if (server.listening) await closeServer(server, new Set());
      return false;
    }
  }, `${label} ${address.host}:${address.port}`);
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMilliseconds = ioTimeoutMilliseconds,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function closeTracked(
  forward: ClosableForward,
  openForwards: Set<ClosableForward>,
): Promise<void> {
  await forward.close();
  openForwards.delete(forward);
}

async function cleanup(
  openForwards: Set<ClosableForward>,
  fixtures: readonly Fixture[],
): Promise<Error[]> {
  const errors: Error[] = [];
  for (const forward of [...openForwards].reverse()) {
    try {
      await forward.close();
    } catch (error) {
      errors.push(new Error(`close forwarding handle: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  openForwards.clear();
  for (const fixture of fixtures) {
    try {
      await fixture.close();
    } catch (error) {
      errors.push(new Error(`close network fixture: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  return errors;
}

function deterministicBytes(length: number, seed: number): Buffer {
  const value = Buffer.allocUnsafe(length);
  let state = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    value[index] = state & 0xff;
  }
  return value;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function withTimeout<T>(promise: Promise<T>, timeoutMilliseconds: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMilliseconds}ms: ${label}`)), timeoutMilliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
