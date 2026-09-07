import { randomUUID } from "node:crypto";
import { createServer, isIP, type AddressInfo, type Server, type Socket } from "node:net";

import { BehaviorSubject, Subject } from "rxjs";

import type {
  ForwardConnectionEvent,
  ForwardConnectionReason,
  ForwardingAddress,
  ForwardingOperationOptions,
  LocalForwardReason,
  LocalForwardState,
  PortForward,
  PortForwardOptions,
} from "../forwarding";
import { TUNNEL_STREAM_MAX_PAYLOAD_BYTES } from "../messageBudget";
import type { Request as CommonRequest } from "../pb/commonpb/common";
import type { SliverRPCClient } from "../pb/rpcpb/services";
import type { TunnelData } from "../pb/sliverpb/sliver";
import { validateTimeoutSeconds } from "./timeout";

export const PORT_FORWARD_DEFAULT_MAX_CONNECTIONS = 32;
export const PORT_FORWARD_MAX_CONNECTIONS = 64;
export const PORT_FORWARD_DEFAULT_BUFFER_BYTES_PER_CONNECTION = 512 * 1024;
export const PORT_FORWARD_MAX_BUFFER_BYTES_PER_CONNECTION = 4 * 1024 * 1024;
export const PORT_FORWARD_MAX_TOTAL_BUFFER_BYTES = 32 * 1024 * 1024;

const DEFAULT_OPERATION_TIMEOUT_SECONDS = 30;
const DEFAULT_CLOSE_TIMEOUT_SECONDS = 5;
const PORT_FORWARD_PROTOCOL_TCP = 1;

type PortForwardRpc = Pick<SliverRPCClient, "createTunnel" | "closeTunnel" | "portfwd">;

export interface PortForwardTunnelTransport {
  onTransportFailure(listener: () => void): () => void;
  openOutput(
    tunnelId: string,
    options: {
      readonly maxBufferedBytes: number;
      readonly onClosed?: () => void;
      readonly onFailure?: (reason: "cancelled" | "overflow" | "transport") => void;
    },
  ): AsyncIterable<Uint8Array>;
  bind(tunnelId: string, sessionId: string, signal?: AbortSignal): Promise<void>;
  send(message: Partial<TunnelData>): Promise<void>;
  cancelTunnel(tunnelId: string): void;
}

export interface PortForwardDependencies {
  readonly rpc: PortForwardRpc;
  readonly tunnels: PortForwardTunnelTransport;
  readonly sessionId: string;
  readonly options: PortForwardOptions;
  readonly operation?: ForwardingOperationOptions;
  readonly request: (timeoutSeconds: number) => CommonRequest;
  readonly onClosed?: (forward: ManagedPortForward) => void;
}

interface NormalizedPortForwardOptions {
  readonly requestedBind: ForwardingAddress;
  readonly target: ForwardingAddress;
  readonly keepAliveSeconds: number;
  readonly connectTimeoutSeconds: number;
  readonly closeTimeoutSeconds: number;
  readonly maxConnections: number;
  readonly maxBufferedBytesPerConnection: number;
  readonly lifetimeSignal?: AbortSignal;
}

interface LiveConnection {
  readonly id: string;
  readonly socket: Socket;
  readonly source?: ForwardingAddress;
  readonly abort: AbortController;
  tunnelId: string;
  tunnelManagerOwned: boolean;
  bytesToTarget: number;
  bytesFromTarget: number;
  reason?: ForwardConnectionReason;
  worker: Promise<void>;
}

export async function createPortForward(dependencies: PortForwardDependencies): Promise<ManagedPortForward> {
  const forward = new ManagedPortForward(dependencies);
  await forward.start(dependencies.operation);
  return forward;
}

export class ManagedPortForward implements PortForward {
  readonly id = randomUUID();
  readonly sessionId: string;
  readonly target: ForwardingAddress;
  readonly state$: PortForward["state$"];
  readonly connection$: PortForward["connection$"];

  private readonly rpc: PortForwardRpc;
  private readonly tunnels: PortForwardTunnelTransport;
  private readonly options: NormalizedPortForwardOptions;
  private readonly request: (timeoutSeconds: number) => CommonRequest;
  private readonly onClosed?: (forward: ManagedPortForward) => void;
  private readonly stateSubject: BehaviorSubject<LocalForwardState>;
  private readonly connectionSubject = new Subject<ForwardConnectionEvent>();
  private readonly server: Server;
  private readonly connections = new Map<string, LiveConnection>();

  private actualBind: ForwardingAddress;
  private totalConnections = 0;
  private bytesToTarget = 0;
  private bytesFromTarget = 0;
  private closePromise: Promise<void> | null = null;
  private lifetimeAbort?: () => void;
  private removeTransportFailureListener?: () => void;

  constructor(dependencies: PortForwardDependencies) {
    this.sessionId = requiredIdentifier(dependencies.sessionId, "Session id");
    this.rpc = dependencies.rpc;
    this.tunnels = dependencies.tunnels;
    this.options = normalizePortForwardOptions(dependencies.options);
    this.actualBind = this.options.requestedBind;
    this.target = this.options.target;
    this.request = dependencies.request;
    this.onClosed = dependencies.onClosed;
    this.stateSubject = new BehaviorSubject<LocalForwardState>(freezeLocalState({
      status: "starting",
      activeConnections: 0,
      totalConnections: 0,
      bytesToTarget: 0,
      bytesFromTarget: 0,
    }));
    this.state$ = this.stateSubject.asObservable();
    this.connection$ = this.connectionSubject.asObservable();
    this.server = createServer({ allowHalfOpen: false, pauseOnConnect: true }, (socket) => {
      this.accept(socket);
    });
  }

  get bind(): ForwardingAddress {
    return this.actualBind;
  }

  get state(): LocalForwardState {
    return this.stateSubject.value;
  }

  async start(operation?: ForwardingOperationOptions): Promise<void> {
    const { signal: operationSignal } = forwardingOperation(operation, DEFAULT_OPERATION_TIMEOUT_SECONDS);
    if (this.options.lifetimeSignal?.aborted) {
      await this.closeWithReason("aborted");
      throw new Error("Port forward lifetime was already aborted");
    }
    const startupSignal = this.options.lifetimeSignal
      ? AbortSignal.any([operationSignal, this.options.lifetimeSignal])
      : operationSignal;
    try {
      await listen(this.server, this.options.requestedBind, startupSignal);
      const address = this.server.address();
      if (!address || typeof address === "string") throw new Error("Port forward listener has no TCP address");
      this.actualBind = freezeAddress(addressFromInfo(address));
      this.server.on("error", this.onListenerError);
      this.publishState("listening");
      this.removeTransportFailureListener = this.tunnels.onTransportFailure(() => {
        void this.closeWithReason("transport-disconnected", true);
      });
      if (this.closePromise) {
        await this.closePromise;
        throw new Error("Tunnel transport is disconnected");
      }
      if (this.options.lifetimeSignal) {
        this.lifetimeAbort = () => {
          void this.closeWithReason("aborted");
        };
        this.options.lifetimeSignal.addEventListener("abort", this.lifetimeAbort, { once: true });
        if (this.options.lifetimeSignal.aborted) {
          await this.closeWithReason("aborted");
          throw new Error("Port forward lifetime was aborted during startup");
        }
      }
    } catch (error) {
      const aborted = operationSignal.aborted || this.options.lifetimeSignal?.aborted === true;
      await this.closeWithReason(aborted ? "aborted" : "listener-error", true).catch(() => undefined);
      throw aborted ? abortError(startupSignal) : new Error("Unable to start port forward listener", { cause: error });
    }
  }

  close(): Promise<void> {
    return this.closeWithReason("requested");
  }

  /** @internal Used by SliverClient.disconnect(). */
  closeForClientDisconnect(): Promise<void> {
    return this.closeWithReason("client-disconnected");
  }

  private readonly onListenerError = (): void => {
    if (this.state.status === "closing" || this.state.status === "closed") return;
    void this.closeWithReason("listener-error", true);
  };

  private accept(socket: Socket): void {
    socket.pause();
    const connection: LiveConnection = {
      id: randomUUID(),
      socket,
      source: socketAddress(socket),
      abort: new AbortController(),
      tunnelId: "",
      tunnelManagerOwned: false,
      bytesToTarget: 0,
      bytesFromTarget: 0,
      worker: Promise.resolve(),
    };
    this.totalConnections = addCount(this.totalConnections, 1);

    if (this.state.status !== "listening" || this.connections.size >= this.options.maxConnections) {
      this.publishConnection(
        connection,
        "rejected",
        this.state.status === "listening" ? "capacity" : "forward-closed",
      );
      socket.destroy();
      this.publishState(this.state.status, this.state.reason);
      return;
    }

    configureLocalSocket(socket, this.options.keepAliveSeconds);
    socket.on("error", () => {
      connection.reason ??= "local-closed";
      connection.abort.abort();
    });
    socket.once("close", () => {
      connection.reason ??= "local-closed";
      connection.abort.abort();
    });
    this.connections.set(connection.id, connection);
    this.publishConnection(connection, "opening");
    this.publishState("listening");
    connection.worker = this.runConnection(connection).finally(() => {
      this.connections.delete(connection.id);
      this.publishState(this.state.status, this.state.reason);
    });
    void connection.worker.catch(() => undefined);
  }

  private async runConnection(connection: LiveConnection): Promise<void> {
    let output: AsyncIterable<Uint8Array> | undefined;
    let opened = false;
    try {
      const setup = forwardingOperation(
        { timeoutSeconds: this.options.connectTimeoutSeconds, signal: connection.abort.signal },
        this.options.connectTimeoutSeconds,
      );
      const created = await this.rpc.createTunnel({ SessionID: this.sessionId }, { signal: setup.signal });
      const candidateTunnelId = requiredIdentifier(created.TunnelID, "Tunnel id");
      if (created.SessionID !== this.sessionId) throw new Error("Tunnel session mismatch");

      // A CreateTunnel response is not proof that this connection owns the
      // corresponding TunnelManager entry. In particular, a malformed or
      // duplicate response may name a tunnel that another live connection is
      // already using. Record ownership only after openOutput() atomically
      // claims the manager entry, so cleanup cannot retire that other stream.
      output = this.tunnels.openOutput(candidateTunnelId, {
        maxBufferedBytes: this.options.maxBufferedBytesPerConnection,
        onClosed: () => {
          connection.reason ??= "remote-closed";
          connection.abort.abort();
        },
        onFailure: (reason) => {
          connection.reason ??= reason === "overflow"
            ? "buffer-overflow"
            : reason === "transport" ? "transport-disconnected" : "forward-closed";
          connection.abort.abort();
        },
      });
      connection.tunnelId = candidateTunnelId;
      connection.tunnelManagerOwned = true;
      await this.tunnels.bind(connection.tunnelId, this.sessionId, setup.signal);
      const response = await this.rpc.portfwd({
        Host: this.target.host,
        Port: this.target.port,
        Protocol: PORT_FORWARD_PROTOCOL_TCP,
        KeepAlive: this.options.keepAliveSeconds,
        TunnelID: connection.tunnelId,
        Request: this.request(this.options.connectTimeoutSeconds),
      }, { signal: setup.signal });
      if (response.Response?.Err) throw new Error("Port forward rejected by target");
      if (
        response.TunnelID !== connection.tunnelId
        || response.Host !== this.target.host
        || response.Port !== this.target.port
        || response.Protocol !== PORT_FORWARD_PROTOCOL_TCP
      ) {
        throw new Error("Port forward response mismatch");
      }

      opened = true;
      this.publishConnection(connection, "open");
      connection.socket.resume();
      await this.relay(connection, output);
    } catch {
      connection.reason ??= opened ? "transport-disconnected" : "setup-failed";
    } finally {
      connection.abort.abort();
      connection.socket.destroy();
      if (connection.tunnelId) {
        this.releaseTunnelManager(connection);
        await this.bestEffortCloseTunnel(connection.tunnelId);
      }
      this.publishConnection(
        connection,
        opened && isOrdinaryConnectionClose(connection.reason) ? "closed" : "failed",
        connection.reason ?? (opened ? "local-closed" : "setup-failed"),
      );
    }
  }

  private async relay(connection: LiveConnection, output: AsyncIterable<Uint8Array>): Promise<void> {
    const toTarget = this.copySocketToTunnel(connection).then(() => {
      connection.reason ??= "local-closed";
    });
    const fromTarget = this.copyTunnelToSocket(connection, output).then(() => {
      connection.reason ??= "remote-closed";
    });
    const aborted = waitForAbort(connection.abort.signal);

    try {
      await Promise.race([toTarget, fromTarget, aborted]);
    } finally {
      connection.socket.destroy();
      this.releaseTunnelManager(connection);
      await Promise.allSettled([toTarget, fromTarget]);
    }
  }

  private async copySocketToTunnel(connection: LiveConnection): Promise<void> {
    for await (const value of connection.socket) {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      try {
        for (let offset = 0; offset < bytes.length; offset += TUNNEL_STREAM_MAX_PAYLOAD_BYTES) {
          const frame = Buffer.from(bytes.subarray(offset, offset + TUNNEL_STREAM_MAX_PAYLOAD_BYTES));
          try {
            await this.tunnels.send({
              TunnelID: connection.tunnelId,
              SessionID: this.sessionId,
              Data: frame,
            });
            connection.bytesToTarget = addCount(connection.bytesToTarget, frame.length);
            this.bytesToTarget = addCount(this.bytesToTarget, frame.length);
          } finally {
            frame.fill(0);
          }
        }
      } finally {
        bytes.fill(0);
      }
      this.publishState(this.state.status, this.state.reason);
    }
  }

  private async copyTunnelToSocket(
    connection: LiveConnection,
    output: AsyncIterable<Uint8Array>,
  ): Promise<void> {
    for await (const value of output) {
      const bytes = Buffer.from(value);
      try {
        await writeSocket(connection.socket, bytes, connection.abort.signal);
        connection.bytesFromTarget = addCount(connection.bytesFromTarget, bytes.length);
        this.bytesFromTarget = addCount(this.bytesFromTarget, bytes.length);
      } finally {
        bytes.fill(0);
        value.fill(0);
      }
      this.publishState(this.state.status, this.state.reason);
    }
  }

  private bestEffortCloseTunnel(tunnelId: string): Promise<void> {
    const operation = forwardingOperation({ timeoutSeconds: this.options.closeTimeoutSeconds }, this.options.closeTimeoutSeconds);
    return this.rpc.closeTunnel({ TunnelID: tunnelId, SessionID: this.sessionId }, { signal: operation.signal })
      .then(() => undefined, () => undefined);
  }

  private releaseTunnelManager(connection: LiveConnection): void {
    if (!connection.tunnelManagerOwned) return;
    connection.tunnelManagerOwned = false;
    this.tunnels.cancelTunnel(connection.tunnelId);
  }

  private closeWithReason(reason: LocalForwardReason, failed = false): Promise<void> {
    if (this.closePromise) return this.closePromise;

    // Install the shared latch before BehaviorSubject.next(). Subscribers run
    // synchronously and are allowed to reenter close(); every caller must see
    // this exact operation rather than starting a second teardown.
    const closePromise = Promise.resolve().then(async () => {
      this.server.off("error", this.onListenerError);
      const serverClosed = closeServer(this.server);
      for (const connection of this.connections.values()) {
        connection.reason ??= "forward-closed";
        connection.abort.abort();
        connection.socket.destroy();
        this.releaseTunnelManager(connection);
      }
      await Promise.allSettled([...this.connections.values()].map((connection) => connection.worker));
      await serverClosed;
    }).finally(() => {
      if (this.options.lifetimeSignal && this.lifetimeAbort) {
        this.options.lifetimeSignal.removeEventListener("abort", this.lifetimeAbort);
      }
      this.removeTransportFailureListener?.();
      this.removeTransportFailureListener = undefined;
      this.publishState(failed ? "failed" : "closed", reason);
      this.connectionSubject.complete();
      this.stateSubject.complete();
      try {
        this.onClosed?.(this);
      } catch {
        // Client registry cleanup is advisory and cannot alter close semantics.
      }
    });
    this.closePromise = closePromise;
    this.publishState("closing", reason);
    return closePromise;
  }

  private publishConnection(
    connection: LiveConnection,
    status: ForwardConnectionEvent["status"],
    reason?: ForwardConnectionReason,
  ): void {
    this.connectionSubject.next(Object.freeze({
      connectionId: connection.id,
      status,
      ...(connection.source ? { source: connection.source } : {}),
      ...(connection.tunnelId ? { tunnelId: connection.tunnelId } : {}),
      bytesToTarget: connection.bytesToTarget,
      bytesFromTarget: connection.bytesFromTarget,
      ...(reason ? { reason } : {}),
    }));
  }

  private publishState(status: LocalForwardState["status"], reason?: LocalForwardReason): void {
    if (this.stateSubject.closed) return;
    this.stateSubject.next(freezeLocalState({
      status,
      activeConnections: this.connections.size,
      totalConnections: this.totalConnections,
      bytesToTarget: this.bytesToTarget,
      bytesFromTarget: this.bytesFromTarget,
      ...(reason ? { reason } : {}),
    }));
  }
}

export function forwardingOperation(
  options: ForwardingOperationOptions | undefined,
  defaultTimeoutSeconds: number,
): { readonly timeoutSeconds: number; readonly signal: AbortSignal } {
  const timeoutSeconds = validateTimeoutSeconds(options?.timeoutSeconds ?? defaultTimeoutSeconds);
  const signals: AbortSignal[] = [];
  if (options?.signal) signals.push(options.signal);
  if (timeoutSeconds > 0) signals.push(AbortSignal.timeout(timeoutSeconds * 1_000));
  const signal = signals.length === 0
    ? new AbortController().signal
    : signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
  return { timeoutSeconds, signal };
}

export function validateForwardingAddress(
  value: ForwardingAddress,
  label: string,
  allowEmptyHost: boolean,
  allowZeroPort: boolean,
): ForwardingAddress {
  if (!value || typeof value !== "object") throw new Error(`${label} is required`);
  if (typeof value.host !== "string") throw new Error(`${label} host must be a string`);
  let host = value.host.trim();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!allowEmptyHost && !host) throw new Error(`${label} host must not be empty`);
  if (/\s|[\u0000-\u001f\u007f]/u.test(host)) throw new Error(`${label} host contains invalid characters`);
  if (host.includes(":") && isIP(host) !== 6) throw new Error(`${label} host is not a valid IPv6 address`);
  if (!Number.isSafeInteger(value.port) || value.port < (allowZeroPort ? 0 : 1) || value.port > 65_535) {
    throw new RangeError(`${label} port must be from ${allowZeroPort ? 0 : 1} to 65535`);
  }
  return freezeAddress({ host, port: value.port });
}

export function joinForwardingAddress(value: ForwardingAddress): string {
  return `${value.host.includes(":") ? `[${value.host}]` : value.host}:${value.port}`;
}

export function parseForwardingAddress(value: string, allowEmptyHost: boolean): ForwardingAddress | null {
  if (!value) return null;
  let host: string;
  let rawPort: string;
  if (value.startsWith("[")) {
    const closing = value.indexOf("]");
    if (closing < 0 || value[closing + 1] !== ":") return null;
    host = value.slice(1, closing);
    rawPort = value.slice(closing + 2);
  } else {
    const colon = value.lastIndexOf(":");
    if (colon < 0) return null;
    host = value.slice(0, colon);
    rawPort = value.slice(colon + 1);
  }
  if (!/^\d+$/u.test(rawPort)) return null;
  try {
    return validateForwardingAddress({ host, port: Number(rawPort) }, "Forwarding address", allowEmptyHost, false);
  } catch {
    return null;
  }
}

export function validateKeepAliveSeconds(value = 30): number {
  if (!Number.isInteger(value) || value < -1 || value > 2_147_483_647) {
    throw new RangeError("Keepalive must be -1 or a non-negative int32 number of seconds");
  }
  return value;
}

function normalizePortForwardOptions(options: PortForwardOptions): NormalizedPortForwardOptions {
  if (!options || typeof options !== "object") throw new Error("Port forward options are required");
  const requestedBind = validateForwardingAddress(options.bind, "Port forward bind", false, true);
  const target = validateForwardingAddress(options.target, "Port forward target", false, false);
  const connectTimeoutSeconds = positiveTimeout(options.connectTimeoutSeconds ?? DEFAULT_OPERATION_TIMEOUT_SECONDS, "Connect timeout");
  const closeTimeoutSeconds = positiveTimeout(options.closeTimeoutSeconds ?? DEFAULT_CLOSE_TIMEOUT_SECONDS, "Close timeout");
  const maxConnections = positiveInteger(options.maxConnections ?? PORT_FORWARD_DEFAULT_MAX_CONNECTIONS, "Connection limit");
  if (maxConnections > PORT_FORWARD_MAX_CONNECTIONS) {
    throw new RangeError(`Connection limit must not exceed ${PORT_FORWARD_MAX_CONNECTIONS}`);
  }
  const maxBufferedBytesPerConnection = positiveInteger(
    options.maxBufferedBytesPerConnection ?? PORT_FORWARD_DEFAULT_BUFFER_BYTES_PER_CONNECTION,
    "Per-connection buffer limit",
  );
  if (maxBufferedBytesPerConnection > PORT_FORWARD_MAX_BUFFER_BYTES_PER_CONNECTION) {
    throw new RangeError(
      `Per-connection buffer limit must not exceed ${PORT_FORWARD_MAX_BUFFER_BYTES_PER_CONNECTION}`,
    );
  }
  if (maxConnections * maxBufferedBytesPerConnection > PORT_FORWARD_MAX_TOTAL_BUFFER_BYTES) {
    throw new RangeError(`Aggregate port forward buffer limit must not exceed ${PORT_FORWARD_MAX_TOTAL_BUFFER_BYTES}`);
  }
  return {
    requestedBind,
    target,
    keepAliveSeconds: validateKeepAliveSeconds(options.keepAliveSeconds),
    connectTimeoutSeconds,
    closeTimeoutSeconds,
    maxConnections,
    maxBufferedBytesPerConnection,
    ...(options.lifetimeSignal ? { lifetimeSignal: options.lifetimeSignal } : {}),
  };
}

function listen(server: Server, address: ForwardingAddress, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      server.off("error", onError);
      server.off("listening", onListening);
      signal.removeEventListener("abort", onAbort);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onListening = (): void => {
      cleanup();
      resolve();
    };
    const onAbort = (): void => {
      cleanup();
      server.close(() => undefined);
      reject(abortError(signal));
    };
    server.once("error", onError);
    server.once("listening", onListening);
    signal.addEventListener("abort", onAbort, { once: true });
    server.listen({ host: address.host, port: address.port });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function writeSocket(socket: Socket, bytes: Buffer, signal: AbortSignal): Promise<void> {
  if (signal.aborted || socket.destroyed) return Promise.reject(new Error("Forward connection is closed"));
  return new Promise<void>((resolve, reject) => {
    let aborted = false;
    const onAbort = (): void => {
      aborted = true;
      socket.destroy();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      // The callback is the ownership boundary for `bytes`: do not let the
      // caller zero it while Node may still be flushing it to the socket.
      socket.write(bytes, (error) => {
        signal.removeEventListener("abort", onAbort);
        if (error || aborted) reject(new Error("Forward connection failed"));
        else resolve();
      });
    } catch {
      signal.removeEventListener("abort", onAbort);
      reject(new Error("Forward connection failed"));
    }
  });
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Forwarding operation was aborted");
}

function addressFromInfo(address: AddressInfo): ForwardingAddress {
  return { host: address.address, port: address.port };
}

function socketAddress(socket: Socket): ForwardingAddress | undefined {
  if (!socket.remoteAddress || socket.remotePort === undefined) return undefined;
  return freezeAddress({ host: socket.remoteAddress, port: socket.remotePort });
}

function configureLocalSocket(socket: Socket, keepAliveSeconds: number): void {
  socket.setNoDelay(true);
  if (keepAliveSeconds < 0) {
    socket.setKeepAlive(false);
    return;
  }
  const initialDelayMilliseconds = Math.min(
    (keepAliveSeconds > 0 ? keepAliveSeconds : 30) * 1_000,
    2_147_483_647,
  );
  socket.setKeepAlive(true, initialDelayMilliseconds);
}

function freezeAddress(address: ForwardingAddress): ForwardingAddress {
  return Object.freeze({ host: address.host, port: address.port });
}

function freezeLocalState(state: LocalForwardState): LocalForwardState {
  return Object.freeze({ ...state });
}

function requiredIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
  return value.trim();
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive safe integer`);
  return value;
}

function positiveTimeout(value: number, label: string): number {
  const timeout = validateTimeoutSeconds(value);
  if (timeout === 0) throw new RangeError(`${label} must be greater than zero`);
  return timeout;
}

function addCount(current: number, amount: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, current + amount);
}

function isOrdinaryConnectionClose(reason: ForwardConnectionReason | undefined): boolean {
  return reason === "local-closed" || reason === "remote-closed" || reason === "forward-closed";
}
