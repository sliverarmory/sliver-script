import { Subject, type Observable } from "rxjs";

import { TUNNEL_STREAM_MAX_PAYLOAD_BYTES } from "../messageBudget";
import type { SliverRPCClient, DeepPartial } from "../pb/rpcpb/services";
import type { TunnelData } from "../pb/sliverpb/sliver";

import { AsyncQueue } from "./asyncQueue";

export const TUNNEL_MANAGER_MAX_ACTIVE_TUNNELS = 64;
export const TUNNEL_MANAGER_MAX_BUFFERED_OUTPUT_FRAMES = 1_024;
export const TUNNEL_MANAGER_MAX_QUEUED_FRAMES_PER_TUNNEL = 8;
export const TUNNEL_MANAGER_MAX_QUEUED_BYTES_PER_TUNNEL = 256 * 1024;
export const TUNNEL_MANAGER_MAX_TOTAL_QUEUED_BYTES = 4 * 1024 * 1024;

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

interface TunnelState {
  readonly subject: Subject<TunnelData>;
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
  private readonly outgoing = new FairTunnelSendQueue();
  private readonly byTunnelId = new Map<string, TunnelState>();
  private readonly abort = new AbortController();
  private readonly transportFailureListeners = new Set<() => void>();

  private rpc: SliverRPCClient | null = null;
  private running: Promise<void> | null = null;
  private transportFailed = false;

  start(rpc: SliverRPCClient): void {
    if (this.rpc) return;
    this.rpc = rpc;
  }

  private ensureRunning(): void {
    if (this.running) return;
    const rpc = this.rpc;
    if (!rpc) throw new Error("Tunnel manager is not connected");

    this.running = (async () => {
      try {
        const stream = rpc.tunnelData(this.outgoing, { signal: this.abort.signal });
        for await (const msg of stream) this.receive(msg);
        if (!this.abort.signal.aborted) throw new Error(SAFE_TUNNEL_TRANSPORT_ERROR);
      } catch {
        if (!this.abort.signal.aborted) {
          this.transportFailed = true;
          this.outgoing.fail();
          for (const tunnelId of [...this.byTunnelId.keys()]) {
            this.failTunnel(tunnelId, "transport");
          }
          for (const listener of [...this.transportFailureListeners]) invokeClosed(listener);
        }
      }
    })();
  }

  /** Registers a listener for an unexpected terminal TunnelData failure. */
  onTransportFailure(listener: () => void): () => void {
    if (this.transportFailed) {
      invokeClosed(listener);
      return () => undefined;
    }
    this.transportFailureListeners.add(listener);
    return () => this.transportFailureListeners.delete(listener);
  }

  /** Legacy RxJS compatibility. New main-process callers use openOutput(). */
  subscribe(tunnelId: string): Observable<TunnelData> {
    return this.ensureTunnel(tunnelId).subject.asObservable();
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
        this.cancelTunnel(tunnelId);
        invokeFailure(options.onFailure, "cancelled");
      },
    });
    return state.output;
  }

  send(msg: DeepPartial<TunnelData>): Promise<void> {
    return this.outgoing.enqueue(msg);
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
    const state = this.byTunnelId.get(tunnelId);
    if (!state) return;
    this.byTunnelId.delete(tunnelId);
    this.outgoing.unregister(tunnelId);
    if (state.bind) settleTunnelBind(state.bind, "reject", new Error(SAFE_TUNNEL_CLOSED_ERROR));
    state.output?.cancel();
    state.subject.complete();
  }

  stats(): TunnelManagerStats {
    return {
      activeTunnels: this.byTunnelId.size,
      ...this.outgoing.stats(),
    };
  }

  async stop(): Promise<void> {
    this.abort.abort();
    this.outgoing.close();
    if (this.running) await this.running;
    this.running = null;
    this.rpc = null;
    for (const tunnelId of [...this.byTunnelId.keys()]) this.failTunnel(tunnelId, "transport");
    this.transportFailureListeners.clear();
  }

  private ensureTunnel(tunnelId: string, exclusive = false): TunnelState {
    const normalized = tunnelId.trim();
    if (!normalized) throw new Error("Tunnel id is required");

    // Establish TunnelData only when a caller actually registers a tunnel;
    // regular control and artifact RPCs do not need a long-lived stream.
    this.ensureRunning();

    let state = this.byTunnelId.get(normalized);
    if (state) {
      if (exclusive) throw new Error("Tunnel output is already registered");
      return state;
    }
    if (this.byTunnelId.size >= TUNNEL_MANAGER_MAX_ACTIVE_TUNNELS) {
      throw new Error("Tunnel capacity is exhausted");
    }

    state = { subject: new Subject<TunnelData>() };
    this.byTunnelId.set(normalized, state);
    try {
      this.outgoing.register(normalized);
    } catch (error) {
      this.byTunnelId.delete(normalized);
      throw error;
    }
    return state;
  }

  private receive(msg: TunnelData): void {
    const tunnelId = msg.TunnelID;
    const state = this.byTunnelId.get(tunnelId);
    if (!state) return;

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
      this.outgoing.unregister(tunnelId);
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
    this.outgoing.unregister(tunnelId, error);
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
