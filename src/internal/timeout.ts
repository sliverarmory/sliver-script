const NANOSECONDS_PER_SECOND = 1_000_000_000n;
const MAX_PROTOBUF_INT64 = 9_223_372_036_854_775_807n;
// Node.js and browsers clamp larger delays to an implementation-defined short
// timeout. Restrict the public whole-second API so a requested long deadline
// can never fire immediately because of timer overflow.
const MAX_TIMER_DELAY_MILLISECONDS = 2_147_483_647;
const MAX_TIMER_TIMEOUT_SECONDS = Math.floor(MAX_TIMER_DELAY_MILLISECONDS / 1_000);
const MAX_PROTOBUF_TIMEOUT_SECONDS = Number((MAX_PROTOBUF_INT64 + 1n) / NANOSECONDS_PER_SECOND);
const MAX_TIMEOUT_SECONDS = Math.min(MAX_TIMER_TIMEOUT_SECONDS, MAX_PROTOBUF_TIMEOUT_SECONDS);

/** A local operation deadline and optional caller cancellation signal. */
export interface OperationOptions {
  /** Defaults to 30 seconds. Zero disables the local deadline. */
  timeoutSeconds?: number;
  /** Cancel this operation without disconnecting unrelated operations. */
  signal?: AbortSignal;
}

/** Numeric timeouts retain their existing whole-second behavior. */
export type OperationTimeout = number | OperationOptions;

/** Caller cancellation; a dispatched remote operation may still complete. */
export class OperationAbortedError extends Error {
  constructor(reason?: unknown) {
    super("Operation was aborted", { cause: reason });
    this.name = "OperationAbortedError";
  }
}

/** Local deadline expiry; a dispatched remote operation may still complete. */
export class OperationTimeoutError extends Error {
  readonly timeoutSeconds: number;

  constructor(timeoutSeconds: number) {
    super(`Operation timed out after ${timeoutSeconds} seconds`);
    this.name = "OperationTimeoutError";
    this.timeoutSeconds = timeoutSeconds;
  }
}

/** Resolve and validate the whole-second timeout shared by local and wire deadlines. */
export function operationTimeoutSeconds(timeout: OperationTimeout, defaultSeconds = 30): number {
  if (typeof timeout === "number") return validateTimeoutSeconds(timeout);
  if (!timeout || typeof timeout !== "object" || Array.isArray(timeout)) {
    throw new TypeError("Operation timeout must be a number or options object");
  }
  return validateTimeoutSeconds(timeout.timeoutSeconds === undefined ? defaultSeconds : timeout.timeoutSeconds);
}

/** Preserve a method's default deadline when the caller supplies only a signal. */
export function operationOptions(timeout: OperationTimeout, defaultSeconds = 30): OperationOptions {
  const timeoutSeconds = operationTimeoutSeconds(timeout, defaultSeconds);
  return typeof timeout === "number" ? { timeoutSeconds } : { timeoutSeconds, signal: timeout.signal };
}

/**
 * Convert the public timeout unit to the nanoseconds expected by
 * commonpb.Request.Timeout without passing an imprecise number to protobuf.
 */
export function timeoutSecondsToNanoseconds(timeout: OperationTimeout): string {
  const validatedTimeoutSeconds = operationTimeoutSeconds(timeout);

  // Match Sliver's canonical Go clients: leave zero unset, and make the
  // server-side deadline expire just before the same whole-second local
  // transport deadline for positive values.
  const timeoutNanoseconds = validatedTimeoutSeconds === 0
    ? 0n
    : (BigInt(validatedTimeoutSeconds) * NANOSECONDS_PER_SECOND) - 1n;
  if (timeoutNanoseconds > MAX_PROTOBUF_INT64) {
    throw new RangeError("Timeout exceeds the protobuf int64 range");
  }

  return timeoutNanoseconds.toString();
}

/**
 * Settle on caller cancellation or deadline expiry even if the callback ignores
 * its signal. Late callback failures are observed. Supply onLateResult to release
 * an owned resource or buffer returned after cancellation; its cleanup failures
 * are also observed without replacing the operation's cancellation error. The
 * default behavior cannot safely dispose an arbitrary T.
 */
export async function withTimeoutSignal<T>(
  timeout: OperationTimeout,
  fn: (signal: AbortSignal) => Promise<T>,
  onLateResult?: (value: T) => void | Promise<void>,
): Promise<T> {
  const timeoutSeconds = operationTimeoutSeconds(timeout);
  const callerSignal = typeof timeout === "number" ? undefined : timeout.signal;
  if (callerSignal !== undefined && (
    !callerSignal
    || typeof callerSignal.aborted !== "boolean"
    || typeof callerSignal.addEventListener !== "function"
    || typeof callerSignal.removeEventListener !== "function"
  )) {
    throw new TypeError("Operation signal must be an AbortSignal");
  }
  if (callerSignal?.aborted) throw new OperationAbortedError(callerSignal.reason);

  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let aborted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    };
    const abort = (error: OperationAbortedError | OperationTimeoutError) => {
      if (settled) return;
      settled = true;
      aborted = true;
      cleanup();
      // Claim the result before notifying callback abort handlers, which can
      // synchronously reject with transport-specific cancellation errors.
      reject(error);
      controller.abort(error);
    };
    const onCallerAbort = () => abort(new OperationAbortedError(callerSignal?.reason));

    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    // Also handle signals that became aborted while the listener was attached.
    if (callerSignal?.aborted) {
      onCallerAbort();
      return;
    }
    if (timeoutSeconds > 0) {
      timer = setTimeout(() => abort(new OperationTimeoutError(timeoutSeconds)), timeoutSeconds * 1_000);
    }

    try {
      Promise.resolve(fn(controller.signal)).then(
        (value) => {
          if (settled) {
            if (aborted && onLateResult) {
              try {
                // The caller has already received cancellation. Cleanup owns
                // any late resource, including observing its own rejection.
                Promise.resolve(onLateResult(value)).catch(() => undefined);
              } catch {
                // A synchronous cleanup failure must not become an unhandled
                // rejection or expose callback details after cancellation.
              }
            }
            return;
          }
          settled = true;
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      );
    } catch (error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }
  });
}

export function validateTimeoutSeconds(timeoutSeconds: number): number {
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 0) {
    throw new RangeError("Timeout must be a non-negative whole number of seconds");
  }
  if (timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    throw new RangeError(`Timeout must not exceed ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  return timeoutSeconds;
}
