import { BehaviorSubject } from "rxjs";

import type {
  ForwardingAddress,
  ForwardingOperationOptions,
  ReversePortForward,
  ReversePortForwardInfo,
  ReversePortForwardOptions,
  ReversePortForwardReason,
  ReversePortForwardState,
} from "../forwarding";
import type { Request as CommonRequest } from "../pb/commonpb/common";
import type { SliverRPCClient } from "../pb/rpcpb/services";
import type { RportFwdListener } from "../pb/sliverpb/sliver";
import {
  forwardingOperation,
  joinForwardingAddress,
  parseForwardingAddress,
  validateForwardingAddress,
  validateKeepAliveSeconds,
} from "./portForward";

const DEFAULT_OPERATION_TIMEOUT_SECONDS = 30;
const DEFAULT_CLEANUP_TIMEOUT_SECONDS = 5;

type ReversePortForwardRpc = Pick<
  SliverRPCClient,
  "startRportFwdListener" | "getRportFwdListeners" | "stopRportFwdListener"
>;

export interface ReversePortForwardCallbacks {
  readonly refresh: (
    forward: ManagedReversePortForward,
    options?: ForwardingOperationOptions,
  ) => Promise<ReversePortForwardInfo | undefined>;
  readonly stop: (forward: ManagedReversePortForward) => Promise<void>;
  readonly onTerminal?: (forward: ManagedReversePortForward) => void;
}

export interface CreateReversePortForwardDependencies {
  readonly rpc: ReversePortForwardRpc;
  readonly sessionId: string;
  readonly options: ReversePortForwardOptions;
  readonly operation?: ForwardingOperationOptions;
  readonly request: (timeoutSeconds: number) => CommonRequest;
  /** Synchronous client-registry check; false means the numeric ID may belong to another generation. */
  readonly authorizeCreatedListenerCleanup: (candidate: ReversePortForwardInfo) => boolean;
  readonly callbacks: ReversePortForwardCallbacks;
}

export async function createReversePortForward(
  dependencies: CreateReversePortForwardDependencies,
): Promise<ManagedReversePortForward> {
  const sessionId = requiredIdentifier(dependencies.sessionId, "Session id");
  const normalized = normalizeReversePortForwardOptions(dependencies.options);
  const operation = forwardingOperation(dependencies.operation, DEFAULT_OPERATION_TIMEOUT_SECONDS);
  assertNotAborted(operation.signal);
  if (normalized.lifetimeSignal?.aborted) {
    throw new Error("Reverse port forward lifetime was already aborted");
  }
  const startSignal = normalized.lifetimeSignal
    ? AbortSignal.any([operation.signal, normalized.lifetimeSignal])
    : operation.signal;
  let response: RportFwdListener;
  try {
    response = await dependencies.rpc.startRportFwdListener({
      BindAddress: joinForwardingAddress(normalized.bind),
      BindPort: 0,
      ForwardPort: 0,
      ForwardAddress: joinForwardingAddress(normalized.target),
      KeepAlive: normalized.keepAliveSeconds,
      // Authorization IDs are generated and owned by the teamserver.
      AuthorizationID: "",
      Request: dependencies.request(operation.timeoutSeconds),
    }, { signal: startSignal });
  } catch (error) {
    if (normalized.lifetimeSignal?.aborted) {
      throw new Error("Reverse port forward lifetime was aborted during startup");
    }
    if (startSignal.aborted) throw new Error("Forwarding operation was aborted");
    throw error;
  }
  const rejected = Boolean(response.Response?.Err);
  const info = reversePortForwardInfo(response, sessionId);
  const identityEstablished = !rejected
    && info !== null
    && sameAddress(info.bind, normalized.bind)
    && sameAddress(info.target, normalized.target);
  if (startSignal.aborted) {
    // A test double or transport may deliver a successful response after local
    // cancellation. Retire it only after its returned metadata establishes the
    // exact identity requested by this operation; an untrusted numeric ID alone
    // is not authority to stop an existing same-session listener.
    if (identityEstablished) {
      await bestEffortStopCreatedReversePortForward(dependencies, info);
    }
    throw new Error(normalized.lifetimeSignal?.aborted
      ? "Reverse port forward lifetime was aborted during startup"
      : "Forwarding operation was aborted");
  }
  if (rejected) throw new Error("Reverse port forward was rejected by the target");
  if (!identityEstablished || !info) {
    throw new Error("Invalid reverse port forward response");
  }
  try {
    return new ManagedReversePortForward(
      info as ReversePortForwardInfo & { bind: ForwardingAddress; target: ForwardingAddress },
      dependencies.callbacks,
      normalized.lifetimeSignal,
    );
  } catch {
    await bestEffortStopCreatedReversePortForward(dependencies, info);
    throw new Error("Invalid reverse port forward response");
  }
}

export async function requestReversePortForwards(
  rpc: ReversePortForwardRpc,
  sessionIdValue: string,
  request: (timeoutSeconds: number) => CommonRequest,
  options?: ForwardingOperationOptions,
): Promise<ReversePortForwardInfo[]> {
  const sessionId = requiredIdentifier(sessionIdValue, "Session id");
  const operation = forwardingOperation(options, DEFAULT_OPERATION_TIMEOUT_SECONDS);
  assertNotAborted(operation.signal);
  const response = await rpc.getRportFwdListeners(
    { Request: request(operation.timeoutSeconds) },
    { signal: operation.signal },
  );
  if (response.Response?.Err) throw new Error("Unable to list reverse port forwards");
  const listeners: ReversePortForwardInfo[] = [];
  for (const listener of response.Listeners) {
    const info = reversePortForwardInfo(listener, sessionId);
    if (info) listeners.push(info);
  }
  return listeners.sort((left, right) => left.id - right.id);
}

export async function requestStopReversePortForward(
  rpc: ReversePortForwardRpc,
  sessionIdValue: string,
  listenerId: number,
  request: (timeoutSeconds: number) => CommonRequest,
  options?: ForwardingOperationOptions,
): Promise<void> {
  const sessionId = requiredIdentifier(sessionIdValue, "Session id");
  const id = reverseListenerId(listenerId);
  const operation = forwardingOperation(options, DEFAULT_OPERATION_TIMEOUT_SECONDS);
  assertNotAborted(operation.signal);
  const response = await rpc.stopRportFwdListener(
    { ID: id, Request: request(operation.timeoutSeconds) },
    { signal: operation.signal },
  );
  if (!response.Response?.Err) return;

  // Stop is intentionally idempotent. The server revokes its authorization
  // before invoking the implant, whose legacy "Invalid ID" response can race a
  // prior close. Confirm absence from authoritative inventory before failing.
  const remaining = await requestReversePortForwards(
    rpc,
    sessionId,
    request,
    { timeoutSeconds: operation.timeoutSeconds, signal: operation.signal },
  );
  if (!remaining.some((listener) => listener.id === id)) return;
  throw new Error("Unable to stop reverse port forward");
}

export class ManagedReversePortForward implements ReversePortForward {
  readonly id: number;
  readonly sessionId: string;
  readonly bind: ForwardingAddress;
  readonly target: ForwardingAddress;
  readonly state$: ReversePortForward["state$"];

  private readonly callbacks: ReversePortForwardCallbacks;
  private readonly stateSubject = new BehaviorSubject<ReversePortForwardState>(freezeReverseState({
    status: "listening",
  }));
  private readonly lifetimeSignal?: AbortSignal;
  private lifetimeAbort?: () => void;
  private closePromise: Promise<void> | null = null;
  private stopRequested = false;
  private stopReason: "requested" | "aborted" = "requested";

  constructor(
    info: ReversePortForwardInfo & { bind: ForwardingAddress; target: ForwardingAddress },
    callbacks: ReversePortForwardCallbacks,
    lifetimeSignal?: AbortSignal,
  ) {
    this.id = reverseListenerId(info.id);
    this.sessionId = requiredIdentifier(info.sessionId, "Session id");
    this.bind = Object.freeze({ ...info.bind });
    this.target = Object.freeze({ ...info.target });
    this.callbacks = callbacks;
    this.lifetimeSignal = lifetimeSignal;
    this.state$ = this.stateSubject.asObservable();
    if (lifetimeSignal) {
      this.lifetimeAbort = () => {
        void this.closeWithReason("aborted").catch(() => undefined);
      };
      lifetimeSignal.addEventListener("abort", this.lifetimeAbort, { once: true });
      if (lifetimeSignal.aborted) queueMicrotask(this.lifetimeAbort);
    }
  }

  get state(): ReversePortForwardState {
    return this.stateSubject.value;
  }

  refresh(options?: ForwardingOperationOptions): Promise<ReversePortForwardState> {
    if (isReverseTerminal(this.state.status)) return Promise.resolve(this.state);
    return this.callbacks.refresh(this, options).then(() => this.state, () => {
      this.markDetached("control-error");
      throw new Error("Unable to refresh reverse port forward");
    });
  }

  close(): Promise<void> {
    return this.closeWithReason("requested");
  }

  /** @internal Marks the remote listener's state unknown without stopping it. */
  markDetached(reason: ReversePortForwardReason = "client-disconnected"): void {
    if (isReverseTerminal(this.state.status) || this.state.status === "stopping") return;
    this.publishState("detached", reason);
  }

  /** @internal Reconciles an authoritative inventory entry after reconnect. */
  reconcile(info: ReversePortForwardInfo | undefined): void {
    if (isReverseTerminal(this.state.status)) return;
    if (!info) {
      this.publishState(this.stopRequested ? "stopped" : "lost", this.stopRequested ? "requested" : "remote-missing");
      this.finishTerminal();
      return;
    }
    if (
      info.id !== this.id
      || info.sessionId !== this.sessionId
      || !sameAddress(info.bind, this.bind)
      || !sameAddress(info.target, this.target)
    ) {
      this.publishState("lost", "identity-mismatch");
      this.finishTerminal();
      return;
    }
    if (this.stopRequested) {
      if (!this.closePromise) void this.closeWithReason(this.stopReason).catch(() => undefined);
      return;
    }
    this.publishState("listening");
  }

  /** @internal Used when a raw stop call targets this tracked handle. */
  markStopped(reason: ReversePortForwardReason = "requested"): void {
    if (this.state.status === "stopped" || this.state.status === "lost") return;
    this.publishState("stopped", reason);
    this.finishTerminal();
  }

  private closeWithReason(reason: "requested" | "aborted"): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.state.status === "stopped" || this.state.status === "lost") {
      this.closePromise = Promise.resolve();
      return this.closePromise;
    }
    this.stopRequested = true;
    this.stopReason = reason;
    const operation = Promise.resolve().then(() => this.callbacks.stop(this)).then(() => {
      this.markStopped(reason);
    }, () => {
      this.closePromise = null;
      this.publishState("detached", "control-error");
      throw new Error("Unable to stop reverse port forward");
    });
    // BehaviorSubject delivery is synchronous. Publish only after installing
    // the shared operation so a stopping subscriber cannot re-enter stop.
    this.closePromise = operation;
    this.publishState("stopping", reason);
    return operation;
  }

  private publishState(
    status: ReversePortForwardState["status"],
    reason?: ReversePortForwardReason,
  ): void {
    this.stateSubject.next(freezeReverseState({ status, ...(reason ? { reason } : {}) }));
  }

  private finishTerminal(): void {
    if (this.lifetimeSignal && this.lifetimeAbort) {
      this.lifetimeSignal.removeEventListener("abort", this.lifetimeAbort);
    }
    this.stateSubject.complete();
    try {
      this.callbacks.onTerminal?.(this);
    } catch {
      // Registry cleanup is advisory and must not alter remote stop semantics.
    }
  }
}

function normalizeReversePortForwardOptions(options: ReversePortForwardOptions): {
  readonly bind: ForwardingAddress;
  readonly target: ForwardingAddress;
  readonly keepAliveSeconds: number;
  readonly lifetimeSignal?: AbortSignal;
} {
  if (!options || typeof options !== "object") throw new Error("Reverse port forward options are required");
  return {
    bind: validateForwardingAddress(options.bind, "Reverse port forward bind", true, false),
    target: validateForwardingAddress(options.target, "Reverse port forward target", false, false),
    keepAliveSeconds: validateKeepAliveSeconds(options.keepAliveSeconds),
    ...(options.lifetimeSignal ? { lifetimeSignal: options.lifetimeSignal } : {}),
  };
}

function reversePortForwardInfo(
  listener: RportFwdListener,
  sessionId: string,
): ReversePortForwardInfo | null {
  if (!Number.isSafeInteger(listener.ID) || listener.ID < 1 || listener.ID > 0xffff_ffff) return null;
  return Object.freeze({
    id: listener.ID,
    sessionId,
    bind: parseForwardingAddress(listener.BindAddress, true),
    target: parseForwardingAddress(listener.ForwardAddress, false),
  });
}

async function bestEffortStopCreatedReversePortForward(
  dependencies: CreateReversePortForwardDependencies,
  candidate: ReversePortForwardInfo,
): Promise<void> {
  // startReversePortForward() holds the client lifecycle queue while this check
  // runs. Refuse numeric-ID cleanup when a managed generation already owns the
  // key; a late or malformed response must not stop that existing listener.
  try {
    if (!dependencies.authorizeCreatedListenerCleanup(candidate)) return;
  } catch {
    return;
  }
  const listenerId = candidate.id;
  if (!Number.isSafeInteger(listenerId) || listenerId < 1 || listenerId > 0xffff_ffff) return;
  const cleanup = forwardingOperation(undefined, DEFAULT_CLEANUP_TIMEOUT_SECONDS);
  try {
    await dependencies.rpc.stopRportFwdListener({
      ID: listenerId,
      Request: dependencies.request(DEFAULT_CLEANUP_TIMEOUT_SECONDS),
    }, { signal: cleanup.signal });
  } catch {
    // Startup is already failing after exact response identity was established,
    // so remote cleanup cannot replace the primary error.
  }
}

function sameAddress(left: ForwardingAddress | null, right: ForwardingAddress): boolean {
  return left !== null && left.host === right.host && left.port === right.port;
}

function reverseListenerId(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 0xffff_ffff) {
    throw new RangeError("Reverse port forward listener id must be a positive uint32");
  }
  return value;
}

function requiredIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
  return value.trim();
}

function freezeReverseState(state: ReversePortForwardState): ReversePortForwardState {
  return Object.freeze({ ...state });
}

function isReverseTerminal(status: ReversePortForwardState["status"]): boolean {
  return status === "stopped" || status === "lost";
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Forwarding operation was aborted");
}
