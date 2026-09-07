import type { Observable } from "rxjs";

/** A structured TCP host and port. IPv6 hosts must be supplied without brackets. */
export interface ForwardingAddress {
  readonly host: string;
  readonly port: number;
}

/** Cancellation and deadline for one forwarding control-plane operation. */
export interface ForwardingOperationOptions {
  readonly timeoutSeconds?: number;
  readonly signal?: AbortSignal;
}

export type LocalForwardStatus = "starting" | "listening" | "closing" | "closed" | "failed";

export type LocalForwardReason =
  | "requested"
  | "aborted"
  | "client-disconnected"
  | "listener-error"
  | "transport-disconnected";

/** Immutable aggregate snapshot emitted by local port-forward and SOCKS handles. */
export interface LocalForwardState {
  readonly status: LocalForwardStatus;
  readonly activeConnections: number;
  readonly totalConnections: number;
  readonly bytesToTarget: number;
  readonly bytesFromTarget: number;
  readonly reason?: LocalForwardReason;
}

export type ForwardConnectionStatus = "opening" | "open" | "closed" | "failed" | "rejected";

export type ForwardConnectionReason =
  | "capacity"
  | "setup-failed"
  | "local-closed"
  | "remote-closed"
  | "forward-closed"
  | "buffer-overflow"
  | "protocol-error"
  | "transport-disconnected";

/** Immutable lifecycle event for one accepted local connection. */
export interface ForwardConnectionEvent {
  readonly connectionId: string;
  readonly status: ForwardConnectionStatus;
  readonly source?: ForwardingAddress;
  readonly tunnelId?: string;
  readonly bytesToTarget: number;
  readonly bytesFromTarget: number;
  readonly reason?: ForwardConnectionReason;
}

export interface PortForwardOptions {
  /** Local TCP listener. Port zero requests an ephemeral OS-assigned port. */
  readonly bind: ForwardingAddress;
  /** TCP destination opened by the implant. */
  readonly target: ForwardingAddress;
  /** Implant-side TCP keepalive period. Zero uses Sliver's default; -1 disables it. */
  readonly keepAliveSeconds?: number;
  /** Deadline for each accepted connection's tunnel and destination setup. */
  readonly connectTimeoutSeconds?: number;
  /** Deadline for each best-effort CloseTunnel call. */
  readonly closeTimeoutSeconds?: number;
  readonly maxConnections?: number;
  readonly maxBufferedBytesPerConnection?: number;
  /** Optional lifetime owner. Aborting it closes the returned local listener. */
  readonly lifetimeSignal?: AbortSignal;
}

/**
 * Stateful local TCP listener forwarding each connection through a Sliver tunnel.
 * Connections use full-close semantics: a local FIN retires both directions.
 */
export interface PortForward {
  readonly id: string;
  readonly sessionId: string;
  /** Actual bound address, including an OS-assigned port when zero was requested. */
  readonly bind: ForwardingAddress;
  readonly target: ForwardingAddress;
  readonly state: LocalForwardState;
  readonly state$: Observable<LocalForwardState>;
  readonly connection$: Observable<ForwardConnectionEvent>;
  /** Idempotently stops accepting, closes all connections, and retires their tunnels. */
  close(): Promise<void>;
}

export interface Socks5Authentication {
  readonly username: string;
  readonly password: string;
}

export interface Socks5ProxyOptions {
  /** Local SOCKS5 listener. Port zero requests an ephemeral OS-assigned port. */
  readonly bind: ForwardingAddress;
  /** Omit for no authentication. Both values are required when supplied. */
  readonly authentication?: Socks5Authentication;
  readonly connectTimeoutSeconds?: number;
  readonly closeTimeoutSeconds?: number;
  readonly maxConnections?: number;
  readonly maxBufferedBytesPerConnection?: number;
  readonly lifetimeSignal?: AbortSignal;
}

/**
 * Stateful local SOCKS5 listener multiplexed over one Sliver SOCKS stream.
 * Connections use full-close semantics: a local FIN retires both directions.
 */
export interface Socks5Proxy {
  readonly id: string;
  readonly sessionId: string;
  readonly bind: ForwardingAddress;
  readonly state: LocalForwardState;
  readonly state$: Observable<LocalForwardState>;
  /** `open` means the Sliver lifecycle stream exists, before SOCKS CONNECT succeeds. */
  readonly connection$: Observable<ForwardConnectionEvent>;
  close(): Promise<void>;
}

export interface ReversePortForwardOptions {
  /** TCP listener opened by the implant. Port zero is not supported. */
  readonly bind: ForwardingAddress;
  /** TCP destination opened by the teamserver for each reverse connection. */
  readonly target: ForwardingAddress;
  readonly keepAliveSeconds?: number;
  /** Optional lifetime owner. Aborting it requests remote listener teardown. */
  readonly lifetimeSignal?: AbortSignal;
}

export interface ReversePortForwardInfo {
  readonly id: number;
  readonly sessionId: string;
  /** Null only for compatibility-only legacy inventory without trusted metadata. */
  readonly bind: ForwardingAddress | null;
  /** Null only for compatibility-only legacy inventory without trusted metadata. */
  readonly target: ForwardingAddress | null;
}

export type ReversePortForwardStatus =
  | "starting"
  | "listening"
  | "detached"
  | "stopping"
  | "stopped"
  | "lost"
  | "failed";

export type ReversePortForwardReason =
  | "requested"
  | "aborted"
  | "client-disconnected"
  | "remote-missing"
  | "identity-mismatch"
  | "control-error";

export interface ReversePortForwardState {
  readonly status: ReversePortForwardStatus;
  readonly reason?: ReversePortForwardReason;
}

/** Stateful control handle for a server-owned reverse port-forward listener. */
export interface ReversePortForward extends ReversePortForwardInfo {
  readonly bind: ForwardingAddress;
  readonly target: ForwardingAddress;
  readonly state: ReversePortForwardState;
  readonly state$: Observable<ReversePortForwardState>;
  /** Reconciles this handle with authoritative server inventory. */
  refresh(options?: ForwardingOperationOptions): Promise<ReversePortForwardState>;
  /** Idempotently asks Sliver to stop the implant listener. */
  close(): Promise<void>;
}
