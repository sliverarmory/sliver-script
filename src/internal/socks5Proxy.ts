import net, { type AddressInfo, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";

import { BehaviorSubject, Subject, type Observable } from "rxjs";

import type {
  ForwardConnectionEvent,
  ForwardConnectionReason,
  ForwardingAddress,
  ForwardingOperationOptions,
  LocalForwardReason,
  LocalForwardState,
  Socks5Proxy,
  Socks5ProxyOptions,
} from "../forwarding";
import { TUNNEL_STREAM_MAX_PAYLOAD_BYTES } from "../messageBudget";
import type { DeepPartial, SliverRPCClient } from "../pb/rpcpb/services";
import type { Socks, SocksData } from "../pb/sliverpb/sliver";

const SOCKS_FLOW_CONTROL_CAPABILITY = 4n;
const SOCKS_FLOW_CONTROL_WINDOW = 64n;
const SOCKS_ACK_BATCH = 16n;
const SOCKS_LIFECYCLE_BIND_SEQUENCE = "18446744073709551615";
const UINT64_MAX = (1n << 64n) - 1n;

const DEFAULT_CONNECT_TIMEOUT_MILLISECONDS = 30_000;
const DEFAULT_STARTUP_TIMEOUT_MILLISECONDS = 30_000;
const DEFAULT_CLOSE_TIMEOUT_MILLISECONDS = 5_000;
const DEFAULT_FIRST_PAYLOAD_TIMEOUT_MILLISECONDS = 10_000;
const DEFAULT_MAX_CONNECTIONS = 256;
const DEFAULT_CONNECTION_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_CONNECTION_BUFFER_BYTES = 64 * 1024 * 1024;
const MAX_RECEIVE_FRAMES_PER_CONNECTION = 128;
const DEFAULT_TOTAL_INCOMING_BYTES = 32 * 1024 * 1024;
const MAX_OUTGOING_FRAMES_PER_CONNECTION = 8;
const MAX_OUTGOING_BYTES_PER_CONNECTION = 512 * 1024;
const MAX_TOTAL_OUTGOING_BYTES = 8 * 1024 * 1024;

/** Protocol constants exported only to keep focused wire tests literal and drift-proof. */
export const SOCKS5_TEST_CONSTANTS = Object.freeze({
  flowControlCapability: SOCKS_FLOW_CONTROL_CAPABILITY.toString(),
  flowControlWindow: Number(SOCKS_FLOW_CONTROL_WINDOW),
  acknowledgementBatch: Number(SOCKS_ACK_BATCH),
  lifecycleBindSequence: SOCKS_LIFECYCLE_BIND_SEQUENCE,
});

type SocksProxyRpc = Pick<SliverRPCClient, "createSocks" | "closeSocks" | "socksProxy">;

/** Internal ownership shared by the SOCKS listeners of one SliverClient. */
export class SocksTunnelLeases {
  private readonly sessions = new Map<string, Set<string>>();

  acquire(sessionId: string, tunnelId: string): (() => void) | undefined {
    let tunnels = this.sessions.get(sessionId);
    if (tunnels?.has(tunnelId)) return undefined;
    if (!tunnels) {
      tunnels = new Set<string>();
      this.sessions.set(sessionId, tunnels);
    }
    tunnels.add(tunnelId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      tunnels.delete(tunnelId);
      if (tunnels.size === 0) this.sessions.delete(sessionId);
    };
  }
}

export interface Socks5ProxyDependencies {
  readonly rpc: SocksProxyRpc;
  readonly sessionId: string;
  readonly id?: string;
  readonly tunnelLeases?: SocksTunnelLeases;
  /** Test/integration override; the public API intentionally keeps this lease fixed. */
  readonly firstPayloadTimeoutMilliseconds?: number;
  /** Test-only pressure override for the proxy-wide receive allocation budget. */
  readonly maxTotalIncomingBytes?: number;
}

export interface ManagedSocks5ProxyStats extends LocalForwardState {
  readonly queuedOutgoingFrames: number;
  readonly queuedOutgoingBytes: number;
  readonly queuedIncomingFrames: number;
  readonly queuedIncomingBytes: number;
}

/** Internal extension of the public handle used by SliverClient lifecycle cleanup. */
export interface ManagedSocks5Proxy extends Socks5Proxy {
  readonly stats: ManagedSocks5ProxyStats;
  readonly closed: Promise<void>;
  close(reason?: LocalForwardReason): Promise<void>;
}

interface NormalizedOptions {
  readonly bind: ForwardingAddress;
  readonly username: string;
  readonly password: string;
  readonly connectTimeoutMilliseconds: number;
  readonly closeTimeoutMilliseconds: number;
  readonly maxConnections: number;
  readonly maxBufferedBytesPerConnection: number;
  readonly lifetimeSignal?: AbortSignal;
}

interface PendingSend {
  readonly frame: DeepPartial<SocksData>;
  readonly weight: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

interface OutgoingTunnelState {
  readonly frames: PendingSend[];
  queuedBytes: number;
  scheduled: boolean;
}

interface ReceiveFrame {
  readonly data: Buffer;
  readonly sequence: bigint;
  readonly terminal: boolean;
}

interface ConnectionCounters {
  bytesToTarget: number;
  bytesFromTarget: number;
}

interface ManagedConnection {
  readonly connectionId: string;
  readonly tunnelId: string;
  readonly socket: Socket;
  readonly source?: ForwardingAddress;
  readonly flow: SocksSendFlow;
  readonly receiver: SocksReceiveQueue;
  readonly counters: ConnectionCounters;
  readonly flowControlled: boolean;
  remoteClosed: boolean;
  closeReason?: ForwardConnectionReason;
}

/**
 * Starts one local SOCKS5 listener backed by one multiplexed Sliver SocksProxy
 * stream. Every accepted TCP connection receives a distinct server tunnel ID.
 */
export async function startSocks5Proxy(
  dependencies: Socks5ProxyDependencies,
  options: Socks5ProxyOptions,
  operation?: ForwardingOperationOptions,
): Promise<ManagedSocks5Proxy> {
  const proxy = new StatefulSocks5Proxy(dependencies, normalizeOptions(options));
  await proxy.start(operation);
  return proxy;
}

/** Alias retained for callers that name internal factories with create*. */
export const createSocks5Proxy = startSocks5Proxy;

class StatefulSocks5Proxy implements ManagedSocks5Proxy {
  readonly id: string;
  readonly sessionId: string;
  readonly state$: Observable<LocalForwardState>;
  readonly connection$: Observable<ForwardConnectionEvent>;
  readonly closed: Promise<void>;

  bind: ForwardingAddress;

  private readonly rpc: SocksProxyRpc;
  private readonly options: Omit<NormalizedOptions, "username" | "password">;
  readonly #username: string;
  readonly #password: string;
  private readonly server: Server;
  private readonly outgoing = new FairSocksSendQueue();
  private readonly stateSubject: BehaviorSubject<LocalForwardState>;
  private readonly connectionSubject = new Subject<ForwardConnectionEvent>();
  private readonly lifetimeAbort = new AbortController();
  private readonly pendingSockets = new Map<string, Socket>();
  private readonly connections = new Map<string, ManagedConnection>();
  private readonly tunnelLeases: SocksTunnelLeases;
  private readonly workers = new Set<Promise<void>>();
  private readonly firstPayloadTimeoutMilliseconds: number;
  private readonly incomingBudget: SocksReceiveBudget;

  private receiveTask: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private shutdownFailed = false;
  private resolveClosed!: () => void;
  private proxyStatus: LocalForwardState["status"] = "starting";
  private proxyReason: LocalForwardReason | undefined;
  private connectionSequence = 0;
  private totalConnections = 0;
  private bytesToTarget = 0;
  private bytesFromTarget = 0;
  private lifetimeAbortListener: (() => void) | null = null;

  constructor(dependencies: Socks5ProxyDependencies, options: NormalizedOptions) {
    const sessionId = dependencies.sessionId.trim();
    if (!sessionId) throw new Error("Session id is required");
    if (!dependencies.rpc) throw new Error("SOCKS5 RPC client is required");

    this.id = normalizeProxyId(dependencies.id);
    this.sessionId = sessionId;
    this.rpc = dependencies.rpc;
    this.tunnelLeases = dependencies.tunnelLeases ?? new SocksTunnelLeases();
    const { username, password, ...safeOptions } = options;
    this.options = safeOptions;
    this.#username = username;
    this.#password = password;
    this.bind = options.bind;
    this.firstPayloadTimeoutMilliseconds = boundedMilliseconds(
      dependencies.firstPayloadTimeoutMilliseconds,
      DEFAULT_FIRST_PAYLOAD_TIMEOUT_MILLISECONDS,
      "SOCKS5 first-payload timeout",
    );
    this.incomingBudget = new SocksReceiveBudget(boundedInteger(
      dependencies.maxTotalIncomingBytes,
      DEFAULT_TOTAL_INCOMING_BYTES,
      1,
      DEFAULT_TOTAL_INCOMING_BYTES,
      "SOCKS5 total incoming buffer",
    ));
    this.stateSubject = new BehaviorSubject<LocalForwardState>(this.snapshot());
    this.state$ = this.stateSubject.asObservable();
    this.connection$ = this.connectionSubject.asObservable();
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
    this.server = net.createServer({
      allowHalfOpen: false,
      pauseOnConnect: true,
      highWaterMark: TUNNEL_STREAM_MAX_PAYLOAD_BYTES,
    }, (socket) => {
      this.accept(socket);
    });
  }

  get state(): LocalForwardState {
    return this.stateSubject.value;
  }

  get stats(): ManagedSocks5ProxyStats {
    let incomingFrames = 0;
    let incomingBytes = 0;
    for (const connection of this.connections.values()) {
      incomingFrames += connection.receiver.pendingFrames;
      incomingBytes += connection.receiver.pendingBytes;
    }
    const outgoing = this.outgoing.stats();
    return Object.freeze({
      ...this.state,
      queuedOutgoingFrames: outgoing.frames,
      queuedOutgoingBytes: outgoing.bytes,
      queuedIncomingFrames: incomingFrames,
      queuedIncomingBytes: incomingBytes,
    });
  }

  async start(operation?: ForwardingOperationOptions): Promise<void> {
    if (this.options.lifetimeSignal?.aborted) {
      throw new Error("SOCKS5 proxy lifetime was already aborted");
    }

    const startup = startupSignal(
      operation,
      this.lifetimeAbort.signal,
      ...(this.options.lifetimeSignal ? [this.options.lifetimeSignal] : []),
    );
    if (startup.signal.aborted) {
      startup.dispose();
      throw new Error("SOCKS5 proxy startup was cancelled");
    }

    this.receiveTask = this.receiveStream();
    this.server.on("error", () => {
      if (this.proxyStatus === "listening") this.failProxy("listener-error");
    });

    try {
      await listen(this.server, this.options.bind, startup.signal);
      if (this.proxyStatus !== "starting") throw new Error("SOCKS5 stream failed during startup");
      const address = this.server.address();
      if (!address || typeof address === "string") throw new Error("invalid listener address");
      this.bind = Object.freeze({ host: normalizeBoundHost(address), port: address.port });
      this.proxyStatus = "listening";
      this.publishState();
    } catch {
      if (this.options.lifetimeSignal?.aborted) {
        await this.close("aborted");
        throw new Error("SOCKS5 proxy lifetime was aborted during startup");
      }
      this.failProxy("listener-error");
      await this.shutdownPromise;
      throw new Error("Unable to start SOCKS5 proxy");
    } finally {
      startup.dispose();
    }

    if (this.options.lifetimeSignal) {
      this.lifetimeAbortListener = () => {
        void this.close("aborted");
      };
      this.options.lifetimeSignal.addEventListener("abort", this.lifetimeAbortListener, { once: true });
      // AbortSignal does not replay an abort to a listener added after the
      // transition. Close explicitly if it raced successful listen startup.
      if (this.options.lifetimeSignal.aborted) void this.close("aborted");
    }
  }

  close(reason: LocalForwardReason = "requested"): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (this.proxyStatus !== "failed") {
      this.proxyStatus = "closing";
      this.proxyReason = reason;
    }
    const shutdown = this.latchShutdown();
    this.publishState();
    return shutdown;
  }

  private accept(socket: Socket): void {
    this.connectionSequence += 1;
    this.totalConnections += 1;
    const connectionId = `${this.id}:${this.connectionSequence}`;
    const source = socketAddress(socket.remoteAddress, socket.remotePort);
    // Socket errors are converted into exact connection lifecycle events by the
    // worker; never leave EventEmitter's special "error" event unobserved.
    socket.on("error", () => undefined);

    if (this.proxyStatus !== "listening" || this.pendingSockets.size >= this.options.maxConnections) {
      socket.destroy();
      this.emitConnection({
        connectionId,
        status: "rejected",
        source,
        bytesToTarget: 0,
        bytesFromTarget: 0,
        reason: this.proxyStatus === "listening" ? "capacity" : "forward-closed",
      });
      this.publishState();
      return;
    }

    configureKeepAlive(socket);
    this.pendingSockets.set(connectionId, socket);
    this.emitConnection({
      connectionId,
      status: "opening",
      source,
      bytesToTarget: 0,
      bytesFromTarget: 0,
    });
    this.publishState();

    const worker = this.runConnection(connectionId, source, socket);
    this.workers.add(worker);
    void worker.then(
      () => this.workers.delete(worker),
      () => this.workers.delete(worker),
    );
  }

  private async runConnection(connectionId: string, source: ForwardingAddress | undefined, socket: Socket): Promise<void> {
    let tunnelId = "";
    let releaseTunnel: (() => void) | undefined;
    let registered = false;
    let terminalSent = false;
    let opened = false;
    let connection: ManagedConnection | undefined;
    let closeReason: ForwardConnectionReason = "setup-failed";
    let firstPayloadTimer: ReturnType<typeof setTimeout> | undefined;
    let receivedLocalPayload = false;
    let lifecycleMarkerDelivered = false;
    const connectionAbort = new AbortController();
    const input = socket[Symbol.asyncIterator]();
    let pendingInput = input.next();
    void pendingInput.catch(() => undefined);
    let connectionTeardownStarted = false;
    const teardownConnection = (): void => {
      if (connectionTeardownStarted) return;
      connectionTeardownStarted = true;
      connectionAbort.abort();
      connection?.flow.close();
      connection?.receiver.stop();
      if (registered && tunnelId) this.outgoing.unregister(tunnelId);
    };
    socket.once("error", teardownConnection);
    socket.once("close", teardownConnection);

    try {
      const created = await this.createRemoteTunnel(connectionAbort.signal);
      tunnelId = validateCreatedTunnelId(created);
      if (created.SessionID !== this.sessionId) throw new Error("Invalid SOCKS5 tunnel session");
      releaseTunnel = this.tunnelLeases.acquire(this.sessionId, tunnelId);
      if (!releaseTunnel) {
        throw new Error("duplicate SOCKS5 tunnel id");
      }
      // Keep the cleanup lease through setup failures and CloseSocks completion,
      // even when this connection never reaches stream registration.
      if (connectionAbort.signal.aborted) throw new Error("SOCKS5 local connection closed");

      const capabilities = parseUint64(created.Capabilities, "SOCKS5 capabilities");
      if ((capabilities & ~SOCKS_FLOW_CONTROL_CAPABILITY) !== 0n) {
        throw new Error("unsupported SOCKS5 capabilities");
      }
      const flowControlled = (capabilities & SOCKS_FLOW_CONTROL_CAPABILITY) !== 0n;
      const counters: ConnectionCounters = { bytesToTarget: 0, bytesFromTarget: 0 };
      const flow = new SocksSendFlow(flowControlled);
      const receiver = new SocksReceiveQueue(
        socket,
        flowControlled,
        this.options.maxBufferedBytesPerConnection,
        this.incomingBudget,
        async (ack) => this.sendAcknowledgement(tunnelId, ack),
        (reason) => {
          if (connection) {
            connection.closeReason = reason;
            socket.destroy();
          }
        },
        (bytes) => {
          counters.bytesFromTarget += bytes;
          this.bytesFromTarget += bytes;
          this.publishState();
        },
      );
      connection = {
        connectionId,
        tunnelId,
        socket,
        source,
        flow,
        receiver,
        counters,
        flowControlled,
        remoteClosed: false,
      };
      this.connections.set(tunnelId, connection);
      this.outgoing.register(tunnelId);
      registered = true;

      firstPayloadTimer = setTimeout(() => {
        if (connection) connection.closeReason = "setup-failed";
        socket.destroy();
      }, this.firstPayloadTimeoutMilliseconds);
      firstPayloadTimer.unref?.();
      await this.outgoing.enqueue({
        TunnelID: tunnelId,
        Sequence: SOCKS_LIFECYCLE_BIND_SEQUENCE,
        Capabilities: capabilities.toString(),
        Username: this.#username,
        Password: this.#password,
        Request: sessionRequest(this.sessionId),
      });
      lifecycleMarkerDelivered = true;
      if (receivedLocalPayload && firstPayloadTimer) {
        clearTimeout(firstPayloadTimer);
        firstPayloadTimer = undefined;
      }

      opened = true;
      closeReason = "local-closed";
      this.emitConnection(this.connectionEvent(connection, "open"));

      let sequence = 0n;
      for (;;) {
        const result = await pendingInput;
        if (result.done) break;
        pendingInput = input.next();
        void pendingInput.catch(() => undefined);
        const chunk = Buffer.isBuffer(result.value) ? result.value : Buffer.from(result.value as Uint8Array);
        try {
          if (chunk.length === 0) continue;
          receivedLocalPayload = true;
          if (lifecycleMarkerDelivered && firstPayloadTimer) {
            clearTimeout(firstPayloadTimer);
            firstPayloadTimer = undefined;
          }
          for (let offset = 0; offset < chunk.length; offset += TUNNEL_STREAM_MAX_PAYLOAD_BYTES) {
            await flow.wait(this.lifetimeAbort.signal);
            const payload = Buffer.from(chunk.subarray(offset, offset + TUNNEL_STREAM_MAX_PAYLOAD_BYTES));
            flow.recordSent(sequence);
            const frame: DeepPartial<SocksData> = {
              TunnelID: tunnelId,
              Sequence: sequence.toString(),
              Data: payload,
              Request: sessionRequest(this.sessionId),
            };
            if (sequence === 0n) {
              frame.Username = this.#username;
              frame.Password = this.#password;
            }
            try {
              await this.outgoing.enqueue(frame);
            } finally {
              // FairSocksSendQueue owns its immutable clone. Release the reader's
              // operation-owned copy on both transport success and failure.
              payload.fill(0);
            }
            connection.counters.bytesToTarget += payload.length;
            this.bytesToTarget += payload.length;
            this.publishState();
            sequence += 1n;
          }
        } finally {
          chunk.fill(0);
        }
      }

      closeReason = connection.closeReason ?? (connection.remoteClosed ? "remote-closed" : "local-closed");
      await this.outgoing.enqueue({
        TunnelID: tunnelId,
        Sequence: sequence.toString(),
        CloseConn: true,
        Request: sessionRequest(this.sessionId),
      });
      terminalSent = true;
    } catch {
      if (connection?.closeReason) closeReason = connection.closeReason;
      else if (this.proxyStatus === "failed") closeReason = "transport-disconnected";
      else if (this.proxyStatus !== "listening") closeReason = "forward-closed";
    } finally {
      if (firstPayloadTimer) clearTimeout(firstPayloadTimer);
      connectionAbort.abort();
      socket.off("error", teardownConnection);
      socket.off("close", teardownConnection);
      if (connection) {
        connection.flow.close();
        connection.receiver.stop();
      }
      socket.destroy();
      try {
        const unread = await pendingInput;
        if (!unread.done) (unread.value as Uint8Array).fill(0);
      } catch {
        // Socket teardown owns input failure and exposes only safe lifecycle state.
      }
      if (connection) await connection.receiver.finished;
      if (registered) this.outgoing.unregister(tunnelId);
      if (releaseTunnel && !terminalSent) await this.closeRemoteTunnel(tunnelId);
      if (tunnelId && this.connections.get(tunnelId) === connection) this.connections.delete(tunnelId);
      releaseTunnel?.();
      this.pendingSockets.delete(connectionId);
      this.emitConnection({
        connectionId,
        status: opened && closeReason !== "setup-failed"
          && closeReason !== "buffer-overflow"
          && closeReason !== "transport-disconnected"
          && closeReason !== "protocol-error"
          ? "closed"
          : "failed",
        source,
        tunnelId: tunnelId || undefined,
        bytesToTarget: connection?.counters.bytesToTarget ?? 0,
        bytesFromTarget: connection?.counters.bytesFromTarget ?? 0,
        reason: closeReason,
      });
      this.publishState();
    }
  }

  private async createRemoteTunnel(connectionSignal: AbortSignal): Promise<Socks> {
    const operation = operationSignal(
      AbortSignal.any([this.lifetimeAbort.signal, connectionSignal]),
      this.options.connectTimeoutMilliseconds,
    );
    try {
      return await this.rpc.createSocks(
        { SessionID: this.sessionId, Capabilities: SOCKS_FLOW_CONTROL_CAPABILITY.toString() },
        { signal: operation.signal },
      );
    } finally {
      operation.dispose();
    }
  }

  private async closeRemoteTunnel(tunnelId: string): Promise<void> {
    const operation = operationSignal(undefined, this.options.closeTimeoutMilliseconds);
    try {
      await this.rpc.closeSocks({ TunnelID: tunnelId, SessionID: this.sessionId }, { signal: operation.signal });
    } catch {
      // The stream teardown is a second exact cleanup owner. Never reflect a
      // potentially target-controlled RPC error through the public handle.
    } finally {
      operation.dispose();
    }
  }

  private sendAcknowledgement(tunnelId: string, ack: bigint): Promise<void> {
    return this.outgoing.enqueue({
      TunnelID: tunnelId,
      Ack: ack.toString(),
      Request: sessionRequest(this.sessionId),
    });
  }

  private async receiveStream(): Promise<void> {
    let failed = false;
    try {
      const stream = this.rpc.socksProxy(this.outgoing, { signal: this.lifetimeAbort.signal });
      for await (const frame of stream) this.receiveFrame(frame);
      failed = !this.lifetimeAbort.signal.aborted;
    } catch {
      failed = !this.lifetimeAbort.signal.aborted;
    } finally {
      if (failed) this.failProxy("transport-disconnected");
    }
  }

  private receiveFrame(frame: SocksData): void {
    const tunnelId = frame.TunnelID.trim();
    const connection = this.connections.get(tunnelId);
    if (!connection) return;

    try {
      const ack = parseUint64(frame.Ack, "SOCKS5 acknowledgement");
      if (ack !== 0n) {
        if (!isCanonicalAcknowledgement(frame)) throw new Error("malformed SOCKS5 acknowledgement");
        connection.flow.acknowledge(ack);
        return;
      }
      if (
        frame.Capabilities !== "0"
        || frame.Username !== ""
        || frame.Password !== ""
        || frame.Request !== undefined
      ) {
        throw new Error("unexpected SOCKS5 response metadata");
      }
      if (frame.Data.length > TUNNEL_STREAM_MAX_PAYLOAD_BYTES) {
        throw new ReceiveFailure("buffer-overflow");
      }
      if (frame.CloseConn && frame.Data.length !== 0) {
        throw new Error("SOCKS5 terminal frame carried data");
      }
      const sequence = parseUint64(frame.Sequence, "SOCKS5 sequence");
      if (!connection.receiver.admit(Buffer.from(frame.Data), sequence, frame.CloseConn)) {
        throw new ReceiveFailure("buffer-overflow");
      }
      if (frame.CloseConn) connection.remoteClosed = true;
    } catch (error) {
      connection.closeReason = error instanceof ReceiveFailure ? error.reason : "protocol-error";
      connection.flow.close();
      connection.receiver.stop();
      connection.socket.destroy();
    }
  }

  private failProxy(reason: Extract<LocalForwardReason, "listener-error" | "transport-disconnected">): void {
    if (this.proxyStatus === "closed" || this.proxyStatus === "failed" || this.proxyStatus === "closing") return;
    this.shutdownFailed = true;
    this.proxyStatus = "closing";
    this.proxyReason = reason;
    this.latchShutdown();
    this.publishState();
  }

  private latchShutdown(): Promise<void> {
    // BehaviorSubject delivery is synchronous. Defer shutdown work by one
    // microtask and publish only after this shared promise is installed.
    this.shutdownPromise ??= Promise.resolve().then(() => this.shutdown());
    return this.shutdownPromise;
  }

  private async shutdown(): Promise<void> {
    this.lifetimeAbort.abort();
    const serverClosed = closeServer(this.server);
    this.outgoing.fail(new Error("SOCKS5 proxy transport disconnected"));
    for (const connection of this.connections.values()) {
      connection.closeReason = this.shutdownFailed ? "transport-disconnected" : "forward-closed";
      connection.flow.close();
      connection.receiver.stop();
    }
    for (const socket of this.pendingSockets.values()) socket.destroy();

    await serverClosed;
    while (this.workers.size > 0) {
      await Promise.allSettled([...this.workers]);
    }
    if (this.receiveTask) await this.receiveTask.catch(() => undefined);

    if (this.options.lifetimeSignal && this.lifetimeAbortListener) {
      this.options.lifetimeSignal.removeEventListener("abort", this.lifetimeAbortListener);
      this.lifetimeAbortListener = null;
    }
    this.proxyStatus = this.shutdownFailed ? "failed" : "closed";
    this.publishState();
    this.connectionSubject.complete();
    this.stateSubject.complete();
    this.resolveClosed();
  }

  private snapshot(): LocalForwardState {
    return Object.freeze({
      status: this.proxyStatus,
      activeConnections: this.pendingSockets.size,
      totalConnections: this.totalConnections,
      bytesToTarget: this.bytesToTarget,
      bytesFromTarget: this.bytesFromTarget,
      ...(this.proxyReason ? { reason: this.proxyReason } : {}),
    });
  }

  private publishState(): void {
    if (!this.stateSubject.closed) this.stateSubject.next(this.snapshot());
  }

  private emitConnection(event: ForwardConnectionEvent): void {
    if (!this.connectionSubject.closed) this.connectionSubject.next(Object.freeze(event));
  }

  private connectionEvent(
    connection: ManagedConnection,
    status: ForwardConnectionEvent["status"],
    reason?: ForwardConnectionReason,
  ): ForwardConnectionEvent {
    return {
      connectionId: connection.connectionId,
      status,
      source: connection.source,
      tunnelId: connection.tunnelId,
      bytesToTarget: connection.counters.bytesToTarget,
      bytesFromTarget: connection.counters.bytesFromTarget,
      reason,
    };
  }
}

class SocksSendFlow {
  private sent = 0n;
  private acked = 0n;
  private closed = false;
  private generation = deferred<void>();

  constructor(private readonly enabled: boolean) {}

  async wait(signal: AbortSignal): Promise<void> {
    while (this.enabled && this.sent - this.acked >= SOCKS_FLOW_CONTROL_WINDOW) {
      if (this.closed || signal.aborted) throw new Error("SOCKS5 flow closed");
      const current = this.generation.promise;
      await waitWithAbort(current, signal, "SOCKS5 flow closed");
    }
    if (this.closed || signal.aborted) throw new Error("SOCKS5 flow closed");
  }

  recordSent(sequence: bigint): void {
    if (this.closed) throw new Error("SOCKS5 flow closed");
    if (!this.enabled) return;
    if (sequence !== this.sent) throw new Error("Invalid SOCKS5 send sequence");
    this.sent += 1n;
  }

  acknowledge(ack: bigint): void {
    if (!this.enabled || ack === 0n || ack > this.sent) throw new Error("Invalid SOCKS5 acknowledgement");
    if (ack <= this.acked) return;
    this.acked = ack;
    this.signal();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.signal();
  }

  private signal(): void {
    this.generation.resolve();
    this.generation = deferred<void>();
  }
}

class SocksReceiveQueue {
  readonly finished: Promise<void>;

  private readonly frames: ReceiveFrame[] = [];
  private readonly done = deferred<void>();
  private wake = deferred<void>();
  private stopped = false;
  private terminal = false;
  private expectedSequence = 0n;
  private consumed = 0n;
  private lastAck = 0n;
  private frameCount = 0;
  private byteCount = 0;

  constructor(
    private readonly socket: Socket,
    private readonly flowControlled: boolean,
    private readonly maxBytes: number,
    private readonly budget: SocksReceiveBudget,
    private readonly acknowledge: (ack: bigint) => Promise<void>,
    private readonly failConnection: (reason: ForwardConnectionReason) => void,
    private readonly recordBytes: (bytes: number) => void,
  ) {
    this.finished = this.run();
  }

  get pendingFrames(): number {
    return this.frameCount;
  }

  get pendingBytes(): number {
    return this.byteCount;
  }

  admit(data: Buffer, sequence: bigint, terminal: boolean): boolean {
    if (this.stopped || this.terminal) {
      data.fill(0);
      return false;
    }
    if (this.flowControlled && sequence !== this.expectedSequence) {
      data.fill(0);
      this.failConnection("protocol-error");
      return true;
    }
    if (
      this.frameCount >= MAX_RECEIVE_FRAMES_PER_CONNECTION
      || this.byteCount + data.length > this.maxBytes
      || !this.budget.reserve(data.length)
    ) {
      data.fill(0);
      return false;
    }

    this.frames.push({ data, sequence, terminal });
    this.frameCount += 1;
    this.byteCount += data.length;
    if (terminal) this.terminal = true;
    else if (this.flowControlled) this.expectedSequence += 1n;
    this.signal();
    return true;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const frame of this.frames.splice(0, this.frames.length)) {
      this.frameCount -= 1;
      this.byteCount -= frame.data.length;
      this.budget.release(frame.data.length);
      frame.data.fill(0);
    }
    this.done.resolve();
    this.signal();
  }

  private async run(): Promise<void> {
    try {
      while (!this.stopped) {
        const frame = this.frames.shift();
        if (!frame) {
          await Promise.race([this.wake.promise, this.done.promise]);
          continue;
        }
        try {
          if (frame.terminal) {
            this.socket.destroy();
            return;
          }
          await writeSocket(this.socket, frame.data);
          this.recordBytes(frame.data.length);
          if (this.flowControlled) await this.acknowledgeConsumed(frame.sequence + 1n, false);
        } catch {
          this.failConnection("local-closed");
          return;
        } finally {
          this.frameCount -= 1;
          this.byteCount -= frame.data.length;
          this.budget.release(frame.data.length);
          frame.data.fill(0);
        }
      }
    } finally {
      this.stop();
    }
  }

  private async acknowledgeConsumed(next: bigint, force: boolean): Promise<void> {
    if (!this.flowControlled) return;
    if (next > this.consumed) this.consumed = next;
    if (this.consumed === 0n || this.consumed <= this.lastAck) return;
    if (!force && this.consumed - this.lastAck < SOCKS_ACK_BATCH) return;
    const ack = this.consumed;
    this.lastAck = ack;
    await this.acknowledge(ack);
  }

  private signal(): void {
    this.wake.resolve();
    this.wake = deferred<void>();
  }
}

/** Shared reservation pool preventing maxConnections * per-connection memory. */
class SocksReceiveBudget {
  private bytes = 0;

  constructor(private readonly maximum: number) {}

  reserve(bytes: number): boolean {
    if (bytes < 0 || this.bytes + bytes > this.maximum) return false;
    this.bytes += bytes;
    return true;
  }

  release(bytes: number): void {
    this.bytes = Math.max(0, this.bytes - bytes);
  }
}

class FairSocksSendQueue implements AsyncIterable<DeepPartial<SocksData>> {
  private readonly tunnels = new Map<string, OutgoingTunnelState>();
  private readonly ready: string[] = [];
  private pendingRead: ReturnType<typeof deferred<IteratorResult<DeepPartial<SocksData>>>> | null = null;
  private delivered: PendingSend | null = null;
  private totalBytes = 0;
  private closed = false;
  private failure: Error | null = null;

  register(tunnelId: string): void {
    if (this.closed) throw this.failure ?? new Error("SOCKS5 stream is closed");
    if (this.tunnels.has(tunnelId)) throw new Error("SOCKS5 tunnel is already registered");
    this.tunnels.set(tunnelId, { frames: [], queuedBytes: 0, scheduled: false });
  }

  enqueue(frame: DeepPartial<SocksData>): Promise<void> {
    if (this.closed) return Promise.reject(this.failure ?? new Error("SOCKS5 stream is closed"));
    const tunnelId = frame.TunnelID?.trim();
    if (!tunnelId) return Promise.reject(new Error("SOCKS5 tunnel id is required"));
    const tunnel = this.tunnels.get(tunnelId);
    if (!tunnel) return Promise.reject(new Error("SOCKS5 tunnel is closed"));
    const dataLength = frame.Data?.length ?? 0;
    if (dataLength > TUNNEL_STREAM_MAX_PAYLOAD_BYTES) {
      return Promise.reject(new Error("SOCKS5 frame exceeds payload limit"));
    }
    const weight = Math.max(
      dataLength + Buffer.byteLength(frame.Username ?? "") + Buffer.byteLength(frame.Password ?? ""),
      1,
    );
    if (
      tunnel.frames.length >= MAX_OUTGOING_FRAMES_PER_CONNECTION
      || tunnel.queuedBytes + weight > MAX_OUTGOING_BYTES_PER_CONNECTION
      || this.totalBytes + weight > MAX_TOTAL_OUTGOING_BYTES
    ) {
      return Promise.reject(new Error("SOCKS5 outgoing queue capacity exceeded"));
    }

    return new Promise<void>((resolve, reject) => {
      const stable: DeepPartial<SocksData> = {
        ...frame,
        ...(frame.Data ? { Data: Buffer.from(frame.Data) } : {}),
        ...(frame.Request ? { Request: { ...frame.Request } } : {}),
      };
      tunnel.frames.push({ frame: stable, weight, resolve, reject });
      tunnel.queuedBytes += weight;
      this.totalBytes += weight;
      this.schedule(tunnelId, tunnel);
      this.flushRead();
    });
  }

  unregister(tunnelId: string): void {
    const tunnel = this.tunnels.get(tunnelId);
    if (!tunnel) return;
    const error = new Error("SOCKS5 tunnel is closed");
    if (this.delivered?.frame.TunnelID === tunnelId) {
      // Once an item has been yielded, nice-grpc's Writable owns it. A
      // successor pull only proves that call.write accepted the object; the
      // grpc-js Writable may serialize it later. Mutating it here can turn a
      // queued SOCKS greeting into an empty frame on the real transport.
      this.delivered.reject(error);
      this.delivered = null;
    }
    this.tunnels.delete(tunnelId);
    for (const pending of tunnel.frames.splice(0, tunnel.frames.length)) {
      this.totalBytes -= pending.weight;
      clearSocksFrame(pending.frame);
      pending.reject(error);
    }
    for (let index = this.ready.length - 1; index >= 0; index -= 1) {
      if (this.ready[index] === tunnelId) this.ready.splice(index, 1);
    }
  }

  fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    if (this.delivered) {
      // A yielded frame belongs to the transport until grpc-js serializes it.
      // Release our reference without changing transport-owned bytes/metadata.
      this.delivered.reject(error);
      this.delivered = null;
    }
    for (const tunnelId of [...this.tunnels.keys()]) this.unregister(tunnelId);
    this.pendingRead?.reject(error);
    this.pendingRead = null;
  }

  stats(): { frames: number; bytes: number } {
    let frames = 0;
    for (const tunnel of this.tunnels.values()) frames += tunnel.frames.length;
    return { frames, bytes: this.totalBytes };
  }

  [Symbol.asyncIterator](): AsyncIterator<DeepPartial<SocksData>> {
    return {
      next: () => this.next(),
      return: async () => {
        this.fail(new Error("SOCKS5 stream is closed"));
        return { value: undefined as never, done: true };
      },
    };
  }

  private next(): Promise<IteratorResult<DeepPartial<SocksData>>> {
    this.completeDelivered();
    if (this.failure) return Promise.reject(this.failure);
    const pending = this.take();
    if (pending) return Promise.resolve({ value: pending.frame, done: false });
    if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
    if (this.pendingRead) return Promise.reject(new Error("SOCKS5 stream has concurrent transport reads"));
    this.pendingRead = deferred<IteratorResult<DeepPartial<SocksData>>>();
    return this.pendingRead.promise;
  }

  private schedule(tunnelId: string, tunnel: OutgoingTunnelState): void {
    if (tunnel.scheduled || tunnel.frames.length === 0) return;
    tunnel.scheduled = true;
    this.ready.push(tunnelId);
  }

  private take(): PendingSend | null {
    while (this.ready.length > 0) {
      const tunnelId = this.ready.shift()!;
      const tunnel = this.tunnels.get(tunnelId);
      if (!tunnel) continue;
      tunnel.scheduled = false;
      const pending = tunnel.frames.shift();
      if (!pending) continue;
      tunnel.queuedBytes -= pending.weight;
      this.totalBytes -= pending.weight;
      this.schedule(tunnelId, tunnel);
      this.delivered = pending;
      return pending;
    }
    return null;
  }

  private flushRead(): void {
    if (!this.pendingRead) return;
    const pending = this.take();
    if (!pending) return;
    const reader = this.pendingRead;
    this.pendingRead = null;
    reader.resolve({ value: pending.frame, done: false });
  }

  private completeDelivered(): void {
    if (!this.delivered) return;
    const delivered = this.delivered;
    this.delivered = null;
    // Do not clear a yielded object here. nice-grpc requests the successor
    // immediately after call.write(), while grpc-js is still allowed to defer
    // serialization inside its bounded Writable queue.
    delivered.resolve();
  }
}

function clearSocksFrame(frame: DeepPartial<SocksData>): void {
  frame.Data?.fill(0);
  frame.Username = "";
  frame.Password = "";
}

class ReceiveFailure extends Error {
  constructor(readonly reason: ForwardConnectionReason) {
    super(reason);
  }
}

function normalizeOptions(options: Socks5ProxyOptions): NormalizedOptions {
  if (!options || typeof options !== "object") throw new Error("SOCKS5 proxy options are required");
  const bind = normalizeAddress(options.bind, true, "SOCKS5 bind");
  const username = options.authentication?.username ?? "";
  const password = options.authentication?.password ?? "";
  if (options.authentication) {
    const usernameBytes = Buffer.byteLength(username);
    const passwordBytes = Buffer.byteLength(password);
    if (usernameBytes < 1 || usernameBytes > 255 || passwordBytes < 1 || passwordBytes > 255) {
      throw new Error("SOCKS5 credentials must each contain 1 to 255 UTF-8 bytes");
    }
  }
  return {
    bind,
    username,
    password,
    connectTimeoutMilliseconds: secondsToMilliseconds(
      options.connectTimeoutSeconds,
      DEFAULT_CONNECT_TIMEOUT_MILLISECONDS,
      "SOCKS5 connect timeout",
    ),
    closeTimeoutMilliseconds: secondsToMilliseconds(
      options.closeTimeoutSeconds,
      DEFAULT_CLOSE_TIMEOUT_MILLISECONDS,
      "SOCKS5 close timeout",
    ),
    maxConnections: boundedInteger(options.maxConnections, DEFAULT_MAX_CONNECTIONS, 1, 256, "SOCKS5 max connections"),
    maxBufferedBytesPerConnection: boundedInteger(
      options.maxBufferedBytesPerConnection,
      DEFAULT_CONNECTION_BUFFER_BYTES,
      1,
      MAX_CONNECTION_BUFFER_BYTES,
      "SOCKS5 connection buffer",
    ),
    lifetimeSignal: options.lifetimeSignal,
  };
}

function normalizeAddress(address: ForwardingAddress, allowZero: boolean, label: string): ForwardingAddress {
  if (!address || typeof address !== "object") throw new Error(`${label} address is required`);
  const host = address.host.trim();
  if (!host || /[\u0000-\u0020\u007f]/u.test(host)) throw new Error(`${label} host is invalid`);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(address.port) || address.port < minimum || address.port > 65_535) {
    throw new Error(`${label} port is invalid`);
  }
  return Object.freeze({ host, port: address.port });
}

function normalizeProxyId(value: string | undefined): string {
  if (value !== undefined) {
    const normalized = value.trim();
    if (!normalized) throw new Error("SOCKS5 proxy id is required");
    return normalized;
  }
  return `socks5-${randomUUID()}`;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return result;
}

function secondsToMilliseconds(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0 || value > 300) throw new Error(`${label} must be between 0 and 300 seconds`);
  return Math.ceil(value * 1000);
}

function boundedMilliseconds(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {
    throw new Error(`${label} must be between 1 and 300000 milliseconds`);
  }
  return value;
}

function sessionRequest(sessionId: string): { SessionID: string } {
  return { SessionID: sessionId };
}

function validateCreatedTunnelId(created: Socks): string {
  if (!created) throw new Error("Invalid SOCKS5 tunnel response");
  const tunnelId = created.TunnelID.trim();
  if (parseUint64(tunnelId, "SOCKS5 tunnel id") === 0n) throw new Error("Invalid SOCKS5 tunnel id");
  return tunnelId;
}

function parseUint64(value: string, label: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new Error(`${label} is invalid`);
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > UINT64_MAX) throw new Error(`${label} is invalid`);
  return parsed;
}

function isCanonicalAcknowledgement(frame: SocksData): boolean {
  return frame.Data.length === 0
    && !frame.CloseConn
    && frame.Sequence === "0"
    && frame.Capabilities === "0"
    && frame.Username === ""
    && frame.Password === ""
    && frame.Request === undefined;
}

function configureKeepAlive(socket: Socket): void {
  socket.setKeepAlive(true, 30_000);
}

function socketAddress(host: string | undefined, port: number | undefined): ForwardingAddress | undefined {
  if (!host || !Number.isSafeInteger(port)) return undefined;
  return Object.freeze({ host, port: port! });
}

function normalizeBoundHost(address: AddressInfo): string {
  return address.address === "::" && address.family === "IPv6" ? "::" : address.address;
}

function listen(server: Server, address: ForwardingAddress, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("SOCKS5 proxy startup was cancelled"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      server.off("error", onError);
      server.off("listening", onListening);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error) => {
      finish(error);
    };
    const onListening = () => {
      finish();
    };
    const onAbort = () => finish(new Error("SOCKS5 proxy startup was cancelled"));
    server.once("error", onError);
    server.once("listening", onListening);
    signal.addEventListener("abort", onAbort, { once: true });
    server.listen({ host: address.host, port: address.port, exclusive: true, signal });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function writeSocket(socket: Socket, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error("SOCKS5 local connection closed"));
    socket.once("error", onError);
    socket.once("close", onClose);
    try {
      socket.write(data, (error?: Error | null) => finish(error ?? undefined));
    } catch (error) {
      finish(error instanceof Error ? error : new Error("SOCKS5 local write failed"));
    }
  });
}

function operationSignal(parent: AbortSignal | undefined, timeoutMilliseconds: number): {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMilliseconds);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}

function startupSignal(operation: ForwardingOperationOptions | undefined, ...lifetimeSignals: AbortSignal[]): {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeoutMilliseconds = secondsToMilliseconds(
    operation?.timeoutSeconds,
    DEFAULT_STARTUP_TIMEOUT_MILLISECONDS,
    "SOCKS5 startup timeout",
  );
  const sources = [operation?.signal, ...lifetimeSignals].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  for (const source of sources) {
    if (source.aborted) {
      controller.abort();
      continue;
    }
    source.addEventListener("abort", abort, { once: true });
    // AbortSignal listeners do not replay. Close the registration race if the
    // source transitioned between the check and listener installation.
    if (source.aborted) controller.abort();
  }
  const timer = setTimeout(abort, timeoutMilliseconds);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      for (const source of sources) source.removeEventListener("abort", abort);
    },
  };
}

function waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal, message: string): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error(message));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new Error(message));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}
