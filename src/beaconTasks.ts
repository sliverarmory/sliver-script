import { Subscription, type Observable } from "rxjs";

import {
  OperationTimeoutError,
  operationOptions,
  validateTimeoutSeconds,
  withTimeoutSignal,
  type OperationTimeout,
} from "./internal/timeout";
import { BEACON_TASK_MAX_PAYLOAD_BYTES, BEACON_TASK_RPC_MESSAGE_BYTES } from "./messageBudget";
import { BeaconTask, type Event } from "./pb/clientpb/client";
import type { SliverRPCClient } from "./pb/rpcpb/services";

/** Generated protobuf message codecs implement this interface. */
export interface BeaconTaskDecoder<T> {
  decode(bytes: Buffer): T;
}

/** A queued task can be awaited repeatedly or reattached using its persisted ID. */
export interface BeaconTaskHandle<T> {
  readonly id: string;
  /** Canceling this local wait does not cancel the server's task. */
  wait(options?: OperationTimeout): Promise<T>;
  status(options?: OperationTimeout): Promise<BeaconTask>;
  /** Explicitly ask the server to cancel this task. */
  cancel(options?: OperationTimeout): Promise<BeaconTask>;
}

export class BeaconTaskStateError extends Error {
  constructor(readonly taskId: string, readonly state: "canceled" | "failed") {
    super(`Beacon task ${taskId} ended in state ${state}`);
    this.name = "BeaconTaskStateError";
  }
}

export class BeaconTaskResponseError extends Error {
  constructor(readonly taskId: string, message: string) {
    super(message);
    this.name = "BeaconTaskResponseError";
  }
}

export class BeaconTaskIdentityError extends Error {
  constructor(readonly taskId: string) {
    super(`Beacon task response did not match task ${taskId}`);
    this.name = "BeaconTaskIdentityError";
  }
}

export class BeaconTaskTimeoutError extends Error {
  constructor(readonly taskId: string, readonly timeoutSeconds: number) {
    super(`Timeout waiting for beacon task result: ${taskId}`);
    this.name = "BeaconTaskTimeoutError";
  }
}

/** @internal Dependencies are supplied by SliverClient to retain channel ownership. */
export interface BeaconTaskHandleDependencies<T> {
  taskId: string;
  beaconId?: string;
  decoder: BeaconTaskDecoder<T>;
  /** Resolve on every poll so a handle can survive a client reconnection. */
  getRpc: () => Pick<SliverRPCClient, "getBeaconTaskContent"> | undefined;
  cancel: (taskId: string, options: OperationTimeout) => Promise<BeaconTask>;
  events: Observable<Event> | (() => Observable<Event>);
  defaultTimeoutSeconds?: number;
  pollIntervalMilliseconds?: number;
}

/** @internal Construct a typed handle without exposing a method-name dispatcher. */
export function createBeaconTaskHandle<T>(dependencies: BeaconTaskHandleDependencies<T>): BeaconTaskHandle<T> {
  const { taskId, beaconId, decoder, getRpc } = dependencies;
  validateIdentifier(taskId, "Beacon task id");
  if (beaconId !== undefined) validateIdentifier(beaconId, "Beacon id");
  if (!decoder || typeof decoder.decode !== "function") throw new TypeError("Beacon task decoder is required");
  const defaultTimeout = validateTimeoutSeconds(dependencies.defaultTimeoutSeconds ?? 30);
  const pollInterval = dependencies.pollIntervalMilliseconds ?? 1_000;
  if (!Number.isSafeInteger(pollInterval) || pollInterval < 1 || pollInterval > 2_147_483_647) {
    throw new RangeError("Beacon task poll interval must be a positive timer-safe integer");
  }

  const optionsFor = (options?: OperationTimeout) => operationOptions(
    options === undefined ? defaultTimeout : options,
    defaultTimeout,
  );

  const validateIdentity = (task: BeaconTask): BeaconTask => {
    if (task.ID !== taskId || (beaconId !== undefined && task.BeaconID !== beaconId)) {
      throw new BeaconTaskIdentityError(taskId);
    }
    return task;
  };

  const fetch = async (signal: AbortSignal): Promise<BeaconTask> => {
    const rpc = getRpc();
    if (!rpc) throw new Error("SliverClient is not connected");
    const task = await rpc.getBeaconTaskContent({ ID: taskId }, { signal });
    return validateIdentity(task);
  };

  const decodeCompleted = (task: BeaconTask): T => {
    if (task.Response.length === 0) {
      throw new BeaconTaskResponseError(taskId, `Beacon task ${taskId} returned an empty response`);
    }
    if (task.Response.length > BEACON_TASK_MAX_PAYLOAD_BYTES) {
      throw new BeaconTaskResponseError(taskId, `Beacon task ${taskId} response exceeds the bounded task limit`);
    }
    // Protobuf decoders may return slices of their input. Each wait owns a copy:
    // neither clearing a failed decode nor a consumer mutating its result can
    // damage a concurrent wait or the RPC's shared response bytes.
    const owned = Buffer.from(task.Response);
    let decoded: T;
    try {
      decoded = decoder.decode(owned);
    } catch {
      owned.fill(0);
      throw new BeaconTaskResponseError(taskId, `Beacon task ${taskId} returned an invalid response`);
    }
    if (hasTargetError(decoded)) {
      owned.fill(0);
      throw new BeaconTaskResponseError(taskId, `Beacon task ${taskId} was rejected by the target`);
    }
    return decoded;
  };

  const wait = async (options?: OperationTimeout): Promise<T> => {
    try {
      return await withTimeoutSignal(optionsFor(options), (signal) => new Promise<T>((resolve, reject) => {
        let settled = false;
        let refreshing = false;
        let refreshPending = false;
        let pollTimer: ReturnType<typeof setInterval> | undefined;
        const subscription = new Subscription();
        const finish = (settle: () => void): void => {
          if (settled) return;
          settled = true;
          if (pollTimer !== undefined) clearInterval(pollTimer);
          signal.removeEventListener("abort", onAbort);
          subscription.unsubscribe();
          settle();
        };
        const onAbort = (): void => finish(() => reject(signal.reason));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
          return;
        }

        const refresh = async (): Promise<void> => {
          if (settled || refreshing) return;
          refreshing = true;
          try {
            while (refreshPending && !settled) {
              refreshPending = false;
              // A disconnected client may reconnect before this wait's deadline.
              const rpc = getRpc();
              if (!rpc) continue;
              let task: BeaconTask;
              try {
                task = await rpc.getBeaconTaskContent({ ID: taskId }, { signal });
              } catch (error) {
                if (settled) return;
                if (isTransientRpcError(error)) continue;
                throw error;
              }
              if (settled) return;
              validateIdentity(task);
              const state = task.State.toLowerCase();
              if (state === "canceled" || state === "failed") {
                throw new BeaconTaskStateError(taskId, state);
              }
              if (state === "completed" || (state === "" && task.Response.length > 0)) {
                const decoded = decodeCompleted(task);
                finish(() => resolve(decoded));
              }
            }
          } catch (error) {
            finish(() => reject(error));
          } finally {
            refreshing = false;
            if (refreshPending && !settled) void refresh();
          }
        };
        const requestRefresh = (): void => {
          if (settled) return;
          refreshPending = true;
          if (!refreshing) void refresh();
        };

        try {
          const events = typeof dependencies.events === "function" ? dependencies.events() : dependencies.events;
          subscription.add(events.subscribe({
            next: (event) => {
              if (event.EventType !== "beacon-taskresult" || event.Data.length > BEACON_TASK_RPC_MESSAGE_BYTES) return;
              try {
                const task = BeaconTask.decode(event.Data);
                if (task.ID === taskId && (beaconId === undefined || task.BeaconID === beaconId)) requestRefresh();
              } catch {
                // Unrelated malformed events must not fail a valid pending task.
              }
            },
            // Polling remains authoritative if the optional event stream fails.
            error: () => undefined,
          }));
        } catch {
          // Events optimize latency; a reconnecting stream is not required.
        }
        if (settled) return;
        pollTimer = setInterval(requestRefresh, pollInterval);
        requestRefresh();
      }));
    } catch (error) {
      if (error instanceof OperationTimeoutError) throw new BeaconTaskTimeoutError(taskId, error.timeoutSeconds);
      throw error;
    }
  };

  return Object.freeze({
    id: taskId,
    wait,
    status: (options?: OperationTimeout) => withTimeoutSignal(optionsFor(options), fetch),
    cancel: async (options?: OperationTimeout) => {
      const normalized = optionsFor(options);
      return withTimeoutSignal(normalized, async (signal) => {
        // Verify the beacon binding before a remote mutation, under the same
        // deadline that covers cancellation. Checking only its response would
        // detect a mismatched beacon after that beacon's task was canceled.
        if (beaconId !== undefined) await fetch(signal);
        signal.throwIfAborted();
        return validateIdentity(await dependencies.cancel(taskId, { ...normalized, signal }));
      });
    },
  });
}

function validateIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.trim() !== value) {
    throw new TypeError(`${label} must be a non-empty identifier of at most 256 characters`);
  }
}

function hasTargetError(value: unknown): boolean {
  if (value === null || typeof value !== "object" || !("Response" in value)) return false;
  const response = value.Response;
  return response !== null && typeof response === "object" && "Err" in response && Boolean(response.Err);
}

function isTransientRpcError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  // CANCELLED / UNAVAILABLE may occur when an old channel closes on disconnect.
  return error.code === 1 || error.code === 14;
}
