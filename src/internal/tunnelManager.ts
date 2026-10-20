import { BehaviorSubject, Subject, type Observable } from "rxjs";

import { TUNNEL_STREAM_MAX_PAYLOAD_BYTES } from "../messageBudget";
import type { SliverRPCClient, DeepPartial } from "../pb/rpcpb/services";
import type { TunnelData } from "../pb/sliverpb/sliver";

import { AsyncQueue } from "./asyncQueue";

export const TUNNEL_MANAGER_MAX_ACTIVE_TUNNELS = 64;
export const TUNNEL_MANAGER_MAX_BUFFERED_OUTPUT_FRAMES = 1_024;
export const TUNNEL_MANAGER_MAX_QUEUED_FRAMES_PER_TUNNEL = 8;
export const TUNNEL_MANAGER_MAX_QUEUED_BYTES_PER_TUNNEL = 256 * 1024;
export const TUNNEL_MANAGER_MAX_TOTAL_QUEUED_BYTES = 4 * 1024 * 1024;
/** Bounds retired identities retained to reject stale handles; reconnect resets this budget. */
export const TUNNEL_MANAGER_MAX_LIFETIME_TUNNELS = 65_536;

const SAFE_TUNNEL_CLOSED_ERROR = "Tunnel is closed";
const SAFE_TUNNEL_OVERFLOW_ERROR = "Tunnel output exceeded its bounded buffer";
const SAFE_TUNNEL_TRANSPORT_ERROR = "Tunnel transport disconnected";

export interface TunnelOutputOptions {
  readonly maxBufferedBytes: number;
  readonly onClosed?: () => void;
  readonly onFailure?: (reason: "cancelled" | "overflow" | "transport") => void;
}

export interface TunnelManagerStats {
  readonly activeTunnels: number;
  readonly queuedFrames: number;
  readonly queuedBytes: number;
}

export interface TunnelTransportState {
  readonly status: "stopped" | "idle" | "connecting" | "connected" | "failed";
  readonly generation: number;
}

interface TunnelTransportGeneration {
  readonly id: number;
  readonly outgoing: FairTunnelSendQueue;
  readonly abort: AbortController;
  running: Promise<void> | null;
  failed: boolean;
}

interface TunnelState {
  readonly subject: Subject<TunnelData>;
  readonly generation: TunnelTransportGeneration;
  output?: AsyncQueue<Uint8Array>;
  onClosed?: () => void;
  onFailure?: (reason: "cancelled" | "overflow" | "transport") => void;
  bind?: TunnelBindState;
}

interface TunnelBindState {
  readonly sessionId: string;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  started: boolean;
  settled: boolean;
}

interface PendingFrame {
  readonly message: DeepPartial<TunnelData>;
  readonly cost: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

interface OutgoingTunnelState {
  readonly frames: PendingFrame[];
  queuedBytes: number;
  scheduled: boolean;
}

/**
 * Per-tunnel round-robin scheduler used as the request side of TunnelData.
 * A sender's promise resolves only when nice-grpc requests the successor to a
 * delivered frame, providing backpressure through serialization rather than
 * acknowledging an unbounded in-memory enqueue.
 */
class FairTunnelSendQueue implements AsyncIterable<DeepPartial<TunnelData>> {
  private readonly byTunnelId = new Map<string, OutgoingTunnelState>();
  private readonly readyTunnelIds: string[] = [];
  private pendingRead: {
    resolve: (result: IteratorResult<DeepPartial<TunnelData>>) => void;
    reject: (error: Error) => void;
  } | null = null;

  private totalQueuedBytes = 0;
  private closed = false;
  private failure: Error | null = null;
  private deliveredFrame: PendingFrame | null = null;

  register(tunnelId: string): void {
    if (this.closed) throw new Error(SAFE_TUNNEL_CLOSED_ERROR);
    if (this.byTunnelId.has(tunnelId)) return;
    if (this.byTunnelId.size >= TUNNEL_MANAGER_MAX_ACTIVE_TUNNELS) {
      throw new Error("Tunnel capacity is exhausted");
    }
    this.byTunnelId.set(tunnelId, { frames: [], queuedBytes: 0, scheduled: false });
  }

  enqueue(message: DeepPartial<TunnelData>): Promise<void> {
    if (this.closed) return Promise.reject(this.failure ?? new Error(SAFE_TUNNEL_CLOSED_ERROR));

    const tunnelId = message.TunnelID?.trim();
    if (!tunnelId) return Promise.reject(new Error("Tunnel id is required"));

    const state = this.byTunnelId.get(tunnelId);
    if (!state) return Promise.reject(new Error(SAFE_TUNNEL_CLOSED_ERROR));

    const dataLength = message.Data?.length ?? 0;
    if (dataLength > TUNNEL_STREAM_MAX_PAYLOAD_BYTES) {
      return Promise.reject(new Error("Tunnel frame exceeds the reviewed payload limit"));
    }
    const cost = Math.max(dataLength, 1);
    if (
      state.frames.length >= TUNNEL_MANAGER_MAX_QUEUED_FRAMES_PER_TUNNEL
      || state.queuedBytes + cost > TUNNEL_MANAGER_MAX_QUEUED_BYTES_PER_TUNNEL
      || this.totalQueuedBytes + cost > TUNNEL_MANAGER_MAX_TOTAL_QUEUED_BYTES
    ) {
      return Promise.reject(new Error("Tunnel write exceeded its bounded queue"));
    }

    return new Promise<void>((resolve, reject) => {
      const stableMessage = message.Data
        ? { ...message, Data: Buffer.from(message.Data) }
        : message;
      state.frames.push({ message: stableMessage, cost, resolve, reject });
      state.queuedBytes += cost;
      this.totalQueuedBytes += cost;
      this.schedule(tunnelId, state);
      this.flushPendingRead();
    });
  }

  unregister(tunnelId: string, error = new Error(SAFE_TUNNEL_CLOSED_ERROR)): void {
    const state = this.byTunnelId.get(tunnelId);
    if (!state) return;

    if (this.deliveredFrame?.message.TunnelID?.trim() === tunnelId) {
      this.rejectDeliveredFrame(error);
    }
    this.byTunnelId.delete(tunnelId);
    for (const frame of state.frames.splice(0, state.frames.length)) {
      this.totalQueuedBytes -= frame.cost;
      frame.message.Data?.fill(0);
      frame.reject(error);
    }
    state.queuedBytes = 0;
    for (let index = this.readyTunnelIds.length - 1; index >= 0; index -= 1) {
      if (this.readyTunnelIds[index] === tunnelId) this.readyTunnelIds.splice(index, 1);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error(SAFE_TUNNEL_CLOSED_ERROR);
    this.rejectDeliveredFrame(error);
    this.rejectAll(error);
    if (this.pendingRead) {
      const waiter = this.pendingRead;
      this.pendingRead = null;
      waiter.resolve({ value: undefined as never, done: true });
    }
  }

  fail(): void {
    if (this.failure) return;
    this.failure = new Error(SAFE_TUNNEL_TRANSPORT_ERROR);
    this.closed = true;
    this.rejectDeliveredFrame(this.failure);
    this.rejectAll(this.failure);
    if (this.pendingRead) {
      const waiter = this.pendingRead;
      this.pendingRead = null;
      waiter.reject(this.failure);
    }
  }

  stats(): Pick<TunnelManagerStats, "queuedFrames" | "queuedBytes"> {
    let queuedFrames = 0;
    for (const state of this.byTunnelId.values()) queuedFrames += state.frames.length;
    return { queuedFrames, queuedBytes: this.totalQueuedBytes };
  }

  [Symbol.asyncIterator](): AsyncIterator<DeepPartial<TunnelData>> {
    return {
      next: () => this.next(),
      return: async () => {
        this.rejectDeliveredFrame(new Error(SAFE_TUNNEL_CLOSED_ERROR));
        this.close();
        return { value: undefined as never, done: true };
      },
    };
  }

  private next(): Promise<IteratorResult<DeepPartial<TunnelData>>> {
    // A successor pull proves nice-grpc accepted the previous object with
    // call.write(), but grpc-js may still serialize that object later from its
    // bounded Writable queue. Acknowledge the sender and release our reference
    // without ever mutating an object after it has been yielded.
    this.completeDeliveredFrame();
    if (this.failure) return Promise.reject(this.failure);
    const frame = this.takeNextFrame();
    if (frame) return Promise.resolve({ value: frame.message, done: false });
    if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
    if (this.pendingRead) {
      return Promise.reject(new Error("Tunnel stream supports one pending transport read"));
    }
    return new Promise((resolve, reject) => {
      this.pendingRead = { resolve, reject };
    });
  }

  private schedule(tunnelId: string, state: OutgoingTunnelState): void {
    if (state.scheduled || state.frames.length === 0) return;
    state.scheduled = true;
    this.readyTunnelIds.push(tunnelId);
  }

  private takeNextFrame(): PendingFrame | null {
    while (this.readyTunnelIds.length > 0) {
      const tunnelId = this.readyTunnelIds.shift()!;
      const state = this.byTunnelId.get(tunnelId);
      if (!state) continue;

      state.scheduled = false;
      const frame = state.frames.shift();
      if (!frame) continue;

      state.queuedBytes -= frame.cost;
      this.totalQueuedBytes -= frame.cost;
      this.schedule(tunnelId, state);
      this.deliveredFrame = frame;
      return frame;
    }
    return null;
  }

  private flushPendingRead(): void {
    if (!this.pendingRead) return;
    const frame = this.takeNextFrame();
    if (!frame) return;
    const waiter = this.pendingRead;
    this.pendingRead = null;
    waiter.resolve({ value: frame.message, done: false });
  }

  private rejectAll(error: Error): void {
    for (const tunnelId of [...this.byTunnelId.keys()]) this.unregister(tunnelId, error);
    this.readyTunnelIds.splice(0, this.readyTunnelIds.length);
    this.totalQueuedBytes = 0;
  }

  private completeDeliveredFrame(): void {
    const frame = this.deliveredFrame;
    if (!frame) return;
    this.deliveredFrame = null;
    frame.resolve();
  }

  private rejectDeliveredFrame(error: Error): void {
    const frame = this.deliveredFrame;
    if (!frame) return;
    this.deliveredFrame = null;
    frame.reject(error);
  }
}

export class TunnelManager {
  private readonly byTunnelId = new Map<string, TunnelState>();
  private readonly issuedTunnelIds = new Set<string>();
  private readonly transportFailureListeners = new Set<() => void>();
  private readonly transportStateSubject = new BehaviorSubject<TunnelTransportState>(
    Object.freeze({ status: "stopped", generation: 0 }),
  );
  readonly transportState$ = this.transportStateSubject.asObservable();

  private rpc: SliverRPCClient | null = null;
  private generation: TunnelTransportGeneration | null = null;
  private stopped = false;

  get transportState(): TunnelTransportState {
    return this.transportStateSubject.value;
  }

  start(rpc: SliverRPCClient): void {
    if (this.stopped) throw new Error("Tunnel manager is stopped");
    if (this.rpc) return;
    this.rpc = rpc;
    this.publishTransportState("idle", 0);
  }

  private ensureRunning(): TunnelTransportGeneration {
    const rpc = this.rpc;
    if (this.stopped || !rpc) throw new Error("Tunnel manager is not connected");
    if (this.generation && !this.generation.failed) return this.generation;

    // Recovery is driven only by a newly-created tunnel. Failed tunnels and
    // their queued frames are never replayed onto the replacement stream.
    const generation: TunnelTransportGeneration = {
      id: (this.generation?.id ?? 0) + 1,
      outgoing: new FairTunnelSendQueue(),
      abort: new AbortController(),
      running: null,
      failed: false,
    };
    this.generation = generation;
    this.publishTransportState("connecting", generation.id);
    if (this.stopped) throw new Error("Tunnel manager is not connected");

    generation.running = (async () => {
      try {
        const stream = rpc.tunnelData(generation.outgoing, { signal: generation.abort.signal });
        for await (const msg of stream) this.receive(msg, generation);
        if (!generation.abort.signal.aborted) throw new Error(SAFE_TUNNEL_TRANSPORT_ERROR);
      } catch {
        // A transport implementation may throw before returning its iterable.
        // Finish registering the initiating output before publishing failure.
        await Promise.resolve();
        this.failGeneration(generation);
      }
    })();
    return generation;
  }

  /**
   * Registers for the current stream's terminal failure. A new listener owner
   * may opt into the next generation when the preceding stream already failed.
   * Listeners are retired with their generation and never called again.
   */
  onTransportFailure(listener: () => void, options?: { readonly nextGeneration?: boolean }): () => void {
    if (this.stopped || (this.generation?.failed && !options?.nextGeneration)) {
      invokeClosed(listener);
      return () => undefined;
    }
    const registration = () => listener();
    this.transportFailureListeners.add(registration);
    return () => this.transportFailureListeners.delete(registration);
  }

  private publishTransportState(status: TunnelTransportState["status"], generation: number): void {
    this.transportStateSubject.next(Object.freeze({ status, generation }));
  }

  private failGeneration(generation: TunnelTransportGeneration): void {
    if (this.stopped || this.generation !== generation || generation.failed) return;
    generation.failed = true;
    const failedTunnels = [...this.byTunnelId.entries()].filter(([, state]) => state.generation === generation);
    const listeners = [...this.transportFailureListeners];
    this.transportFailureListeners.clear();
    // Revoke every old identity before callbacks can create a new generation.
    for (const [id] of failedTunnels) this.byTunnelId.delete(id);
    generation.outgoing.fail();
    generation.abort.abort();
    this.publishTransportState("failed", generation.id);
    for (const [, state] of failedTunnels) this.failTunnelState(state, "transport");
    for (const listener of listeners) invokeClosed(listener);
  }

  /** Legacy RxJS compatibility. New main-process callers use openOutput(). */
  subscribe(tunnelId: string, options?: { readonly exclusive?: boolean }): Observable<TunnelData> {
    return this.ensureTunnel(tunnelId, options?.exclusive ?? false).subject.asObservable();
  }

  openOutput(tunnelId: string, options: TunnelOutputOptions): AsyncIterable<Uint8Array> {
    if (!Number.isSafeInteger(options.maxBufferedBytes) || options.maxBufferedBytes < 1) {
      throw new Error("Tunnel output budget must be a positive safe integer");
    }

    // A managed output is the exclusive first owner of a tunnel id. Legacy
    // subscribe() callers may observe an already-managed tunnel, but a managed
    // caller must never overlay callbacks or cancellation authority onto state
    // that an earlier legacy subscriber created.
    const state = this.ensureTunnel(tunnelId, true);

    state.onClosed = options.onClosed;
    state.onFailure = options.onFailure;
    state.output = new AsyncQueue<Uint8Array>({
      maxItems: TUNNEL_MANAGER_MAX_BUFFERED_OUTPUT_FRAMES,
      maxWeight: options.maxBufferedBytes,
      weight: (chunk) => chunk.byteLength,
      overflowError: () => new Error(SAFE_TUNNEL_OVERFLOW_ERROR),
      dispose: clearBytes,
      onConsumerCancel: () => {
        if (this.byTunnelId.get(tunnelId.trim()) !== state) return;
        this.cancelTunnel(tunnelId);
        invokeFailure(options.onFailure, "cancelled");
      },
    });
    return state.output;
  }

  send(msg: DeepPartial<TunnelData>): Promise<void> {
    const state = this.byTunnelId.get(msg.TunnelID?.trim() ?? "");
    if (!state || this.stopped) return Promise.reject(new Error(SAFE_TUNNEL_CLOSED_ERROR));
    return state.generation.outgoing.enqueue(msg);
  }

  /**
   * Binds a newly-created server tunnel to this manager's TunnelData stream and
   * waits for the server's exact zero-data acknowledgement. Sliver routes the
   * bind and the subsequent Portfwd/Shell unary RPC over independent HTTP/2
   * streams, so waiting only for local serialization leaves a real race.
   */
  async bind(tunnelId: string, sessionId: string, signal?: AbortSignal): Promise<void> {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) throw new Error("Session id is required");
    if (signal?.aborted) throw new Error("Tunnel bind was cancelled");

    const state = this.ensureTunnel(tunnelId);
    if (!state.bind) state.bind = createTunnelBindState(normalizedSessionId);
    const bind = state.bind;
    if (bind.sessionId !== normalizedSessionId) {
      throw new Error("Tunnel belongs to another session");
    }

    // Only the caller that created the bind state emits the ownership frame.
    // Concurrent callers share the same acknowledgement rather than racing a
    // duplicate bind onto the stream.
    if (!bind.started) {
      bind.started = true;
      try {
        await waitForTunnelBind(this.send({
          TunnelID: tunnelId.trim(),
          SessionID: normalizedSessionId,
          Data: Buffer.alloc(0),
        }), signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        settleTunnelBind(bind, "reject", safeTunnelError(error, SAFE_TUNNEL_TRANSPORT_ERROR));
        // Observe the shared promise on this path too. Throwing the send error
        // directly would leave the rejected acknowledgement promise without a
        // consumer and can surface later as an unhandled rejection.
        return await bind.promise;
      }
    }

    await waitForTunnelBind(bind.promise, signal);
  }

  cancelTunnel(tunnelId: string): void {
    const normalized = tunnelId.trim();
    const state = this.byTunnelId.get(normalized);
    if (!state) return;
    this.byTunnelId.delete(normalized);
    state.generation.outgoing.unregister(normalized);
    if (state.bind) settleTunnelBind(state.bind, "reject", new Error(SAFE_TUNNEL_CLOSED_ERROR));
    state.output?.cancel();
    state.subject.complete();
  }

  stats(): TunnelManagerStats {
    return {
      activeTunnels: this.byTunnelId.size,
      ...(this.generation?.outgoing.stats() ?? { queuedFrames: 0, queuedBytes: 0 }),
    };
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      if (this.generation?.running) await this.generation.running;
      return;
    }
    this.stopped = true;
    this.rpc = null;
    const generation = this.generation;
    this.transportFailureListeners.clear();
    generation?.abort.abort();
    generation?.outgoing.close();
    this.publishTransportState("stopped", generation?.id ?? 0);
    for (const tunnelId of [...this.byTunnelId.keys()]) this.failTunnel(tunnelId, "transport");
    if (generation?.running) await generation.running;
  }

  private ensureTunnel(tunnelId: string, exclusive = false): TunnelState {
    const normalized = tunnelId.trim();
    if (!normalized) throw new Error("Tunnel id is required");

    let state = this.byTunnelId.get(normalized);
    if (state) {
      if (exclusive) throw new Error("Tunnel output is already registered");
      return state;
    }
    if (this.stopped || !this.rpc) throw new Error("Tunnel manager is not connected");
    if (this.issuedTunnelIds.has(normalized)) throw new Error("Tunnel identity has already been retired");
    if (this.issuedTunnelIds.size >= TUNNEL_MANAGER_MAX_LIFETIME_TUNNELS) {
      throw new Error("Tunnel identity capacity is exhausted; reconnect the client");
    }
    if (this.byTunnelId.size >= TUNNEL_MANAGER_MAX_ACTIVE_TUNNELS) {
      throw new Error("Tunnel capacity is exhausted");
    }

    // Establish TunnelData only for a new identity; stale handles cannot
    // restart a stream or gain authority over a replacement tunnel.
    const generation = this.ensureRunning();
    // State observers run synchronously and may have registered a tunnel while
    // handling the new generation's connecting notification.
    state = this.byTunnelId.get(normalized);
    if (state) {
      if (exclusive) throw new Error("Tunnel output is already registered");
      return state;
    }
    if (this.issuedTunnelIds.has(normalized)) throw new Error("Tunnel identity has already been retired");
    if (this.issuedTunnelIds.size >= TUNNEL_MANAGER_MAX_LIFETIME_TUNNELS) {
      throw new Error("Tunnel identity capacity is exhausted; reconnect the client");
    }
    if (this.byTunnelId.size >= TUNNEL_MANAGER_MAX_ACTIVE_TUNNELS) throw new Error("Tunnel capacity is exhausted");
    state = { subject: new Subject<TunnelData>(), generation };
    this.byTunnelId.set(normalized, state);
    try {
      generation.outgoing.register(normalized);
      this.issuedTunnelIds.add(normalized);
    } catch (error) {
      this.byTunnelId.delete(normalized);
      throw error;
    }
    return state;
  }

  private receive(msg: TunnelData, generation: TunnelTransportGeneration): void {
    if (this.stopped || this.generation !== generation || generation.failed) {
      msg.Data.fill(0);
      return;
    }
    const tunnelId = msg.TunnelID;
    const state = this.byTunnelId.get(tunnelId);
    if (!state || state.generation !== generation) {
      msg.Data.fill(0);
      return;
    }

    // Once bind() establishes an owner, TunnelID alone is no longer a valid
    // routing capability. Ignore foreign-session frames before overflow,
    // observer, output, or terminal processing so they cannot disclose bytes
    // or tear down the owner's tunnel. Legacy subscribe()-only tunnels remain
    // intentionally unbound and retain their historical routing behavior.
    if (state.bind && msg.SessionID !== state.bind.sessionId) {
      msg.Data.fill(0);
      return;
    }

    if (msg.Data.length > TUNNEL_STREAM_MAX_PAYLOAD_BYTES) {
      msg.Data.fill(0);
      this.failTunnel(tunnelId, "overflow");
      return;
    }

    if (this.transportState.status === "connecting") {
      this.publishTransportState("connected", generation.id);
      // Observers may synchronously disconnect while handling readiness.
      if (this.stopped || this.byTunnelId.get(tunnelId) !== state) {
        msg.Data.fill(0);
        return;
      }
    }

    if (state.bind && msg.SessionID === state.bind.sessionId && msg.Data.length === 0 && !msg.Closed) {
      settleTunnelBind(state.bind, "resolve");
    }

    state.subject.next(msg);
    if (msg.Data.length > 0 && state.output) {
      const copy = Uint8Array.from(msg.Data);
      if (!state.output.push(copy)) {
        this.failTunnel(tunnelId, "overflow");
        return;
      }
    }

    if (msg.Closed) {
      this.byTunnelId.delete(tunnelId);
      generation.outgoing.unregister(tunnelId);
      if (state.bind) settleTunnelBind(state.bind, "reject", new Error(SAFE_TUNNEL_CLOSED_ERROR));
      state.output?.close();
      state.subject.complete();
      invokeClosed(state.onClosed);
    }
  }

  private failTunnel(tunnelId: string, reason: "overflow" | "transport"): void {
    const state = this.byTunnelId.get(tunnelId);
    if (!state) return;
    this.byTunnelId.delete(tunnelId);
    const error = new Error(reason === "overflow" ? SAFE_TUNNEL_OVERFLOW_ERROR : SAFE_TUNNEL_TRANSPORT_ERROR);
    state.generation.outgoing.unregister(tunnelId, error);
    this.failTunnelState(state, reason);
  }

  private failTunnelState(state: TunnelState, reason: "overflow" | "transport"): void {
    const error = new Error(reason === "overflow" ? SAFE_TUNNEL_OVERFLOW_ERROR : SAFE_TUNNEL_TRANSPORT_ERROR);
    if (state.bind) settleTunnelBind(state.bind, "reject", error);
    state.output?.fail(error);
    state.subject.error(error);
    invokeFailure(state.onFailure, reason);
  }
}

function createTunnelBindState(sessionId: string): TunnelBindState {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  // A caller may cancel after the ownership frame is serialized but before it
  // begins waiting for the shared acknowledgement. Keep the shared rejection
  // observed even if that caller then retires the tunnel.
  void promise.catch(() => undefined);
  return { sessionId, promise, resolve, reject, started: false, settled: false };
}

function settleTunnelBind(
  bind: TunnelBindState,
  outcome: "resolve" | "reject",
  error?: Error,
): void {
  if (bind.settled) return;
  bind.settled = true;
  if (outcome === "resolve") {
    bind.resolve();
  } else {
    bind.reject(error ?? new Error(SAFE_TUNNEL_CLOSED_ERROR));
  }
}

async function waitForTunnelBind(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = (): void => finish(new Error("Tunnel bind was cancelled"));
    // Attach to the underlying promise before inspecting an already-aborted
    // signal so a later queue/tunnel cancellation cannot become unhandled.
    promise.then(() => finish(), (error: unknown) => finish(error));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function safeTunnelError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

function clearBytes(value: Uint8Array): void {
  value.fill(0);
}

function invokeClosed(callback: (() => void) | undefined): void {
  if (!callback) return;
  try {
    callback();
  } catch {
    // Lifecycle callbacks are advisory and must not kill the transport loop.
  }
}

function invokeFailure(
  callback: ((reason: "cancelled" | "overflow" | "transport") => void) | undefined,
  reason: "cancelled" | "overflow" | "transport",
): void {
  if (!callback) return;
  try {
    callback(reason);
  } catch {
    // Lifecycle callbacks are advisory and must not kill the transport loop.
  }
}
