import { SliverClient } from "../client";
import type { SliverClientConfig } from "../config";
import { Version } from "../pb/clientpb/client";
import {
  OperationAbortedError,
  OperationTimeoutError,
  operationOptions,
  operationTimeoutSeconds,
  timeoutSecondsToNanoseconds,
  withTimeoutSignal,
} from "../internal/timeout";

const MAX_TIMEOUT_SECONDS = 2_147_483;
const invalidTimeouts = [
  -1,
  0.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  MAX_TIMEOUT_SECONDS + 1,
  Number.MAX_SAFE_INTEGER,
] as const;

describe("Sliver operation timeout encoding", () => {
  test("matches the pinned Go client's nanoseconds-minus-one wire values", () => {
    expect(timeoutSecondsToNanoseconds(0)).toBe("0");
    expect(timeoutSecondsToNanoseconds(1)).toBe("999999999");
    expect(timeoutSecondsToNanoseconds(60)).toBe("59999999999");
    expect(timeoutSecondsToNanoseconds(MAX_TIMEOUT_SECONDS)).toBe("2147482999999999");
  });

  test.each(invalidTimeouts)("rejects invalid timeout %s before encoding", (timeout) => {
    expect(() => timeoutSecondsToNanoseconds(timeout)).toThrow(RangeError);
  });

  test.each(invalidTimeouts)("rejects invalid timeout %s before invoking a callback", async (timeout) => {
    const callback = jest.fn(async (_signal: AbortSignal) => "called");

    await expect(withTimeoutSignal(timeout, callback)).rejects.toBeInstanceOf(RangeError);
    expect(callback).not.toHaveBeenCalled();
  });

  test.each(invalidTimeouts)("rejects invalid timeout %s before RPC dispatch", async (timeout) => {
    const getVersion = jest.fn(async () => Version.create());
    const client = clientWithControlRpc({ getVersion });

    await expect(client.getVersion(timeout)).rejects.toBeInstanceOf(RangeError);
    expect(getVersion).not.toHaveBeenCalled();
  });

  test("accepts zero and the supported timer ceiling", async () => {
    const callback = jest.fn(async (signal: AbortSignal) => signal.aborted);

    await expect(withTimeoutSignal(0, callback)).resolves.toBe(false);
    await expect(withTimeoutSignal(MAX_TIMEOUT_SECONDS, callback)).resolves.toBe(false);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  test("uses the same validated default for options and protobuf encoding", () => {
    const controller = new AbortController();
    expect(operationTimeoutSeconds({})).toBe(30);
    expect(operationTimeoutSeconds({ signal: controller.signal }, 60)).toBe(60);
    expect(operationTimeoutSeconds({ timeoutSeconds: 0 }, 60)).toBe(0);
    expect(timeoutSecondsToNanoseconds({})).toBe("29999999999");
    expect(timeoutSecondsToNanoseconds({ timeoutSeconds: 1 })).toBe("999999999");
    expect(operationOptions({ signal: controller.signal }, 60)).toEqual({
      timeoutSeconds: 60,
      signal: controller.signal,
    });
    expect(operationOptions(5, 60)).toEqual({ timeoutSeconds: 5 });
    expect(() => operationTimeoutSeconds({}, -1)).toThrow(RangeError);
  });

  test.each(invalidTimeouts)("rejects invalid options timeout %s before dispatch", async (timeoutSeconds) => {
    const callback = jest.fn(async () => "called");
    await expect(withTimeoutSignal({ timeoutSeconds }, callback)).rejects.toBeInstanceOf(RangeError);
    expect(() => timeoutSecondsToNanoseconds({ timeoutSeconds })).toThrow(RangeError);
    expect(callback).not.toHaveBeenCalled();
  });
});

describe("operation cancellation and deadlines", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test("rejects pre-aborted callers without dispatching or registering resources", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    controller.abort(reason);
    const add = jest.spyOn(controller.signal, "addEventListener");
    const callback = jest.fn(async () => "called");

    await expect(withTimeoutSignal({ signal: controller.signal }, callback)).rejects.toMatchObject({
      name: "OperationAbortedError",
      cause: reason,
    });
    expect(callback).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test("aborts a stalled callback with no deadline and observes its late rejection", async () => {
    const controller = new AbortController();
    const remove = jest.spyOn(controller.signal, "removeEventListener");
    let derived!: AbortSignal;
    let rejectLate!: (reason: Error) => void;
    const operation = withTimeoutSignal({ timeoutSeconds: 0, signal: controller.signal }, (signal) => {
      derived = signal;
      return new Promise((_resolve, reject) => { rejectLate = reject; });
    });
    const result = operation.catch((error: unknown) => error);
    expect(jest.getTimerCount()).toBe(0);

    const reason = new Error("stop this one");
    controller.abort(reason);
    const failure = await result;
    expect(failure).toBeInstanceOf(OperationAbortedError);
    expect(failure).toMatchObject({ cause: reason });
    expect(derived.aborted).toBe(true);
    expect(derived.reason).toBe(failure);
    expect(remove).toHaveBeenCalledTimes(1);

    rejectLate(new Error("late transport failure"));
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("classifies a numeric deadline even when transport rejects on abort", async () => {
    let derived!: AbortSignal;
    const operation = withTimeoutSignal(2, (signal) => {
      derived = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("transport cancelled")), { once: true });
      });
    });
    const result = operation.catch((error: unknown) => error);

    await jest.advanceTimersByTimeAsync(1_999);
    expect(derived.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    const failure = await result;
    expect(failure).toBeInstanceOf(OperationTimeoutError);
    expect(failure).toMatchObject({ timeoutSeconds: 2 });
    expect(derived.reason).toBe(failure);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("expires signal-only options after the default 30 seconds without aborting the caller", async () => {
    const controller = new AbortController();
    const remove = jest.spyOn(controller.signal, "removeEventListener");
    const operation = withTimeoutSignal({ signal: controller.signal }, () => new Promise<never>(() => {}));
    const result = operation.catch((error: unknown) => error);

    await jest.advanceTimersByTimeAsync(30_000);
    expect(await result).toMatchObject({ name: "OperationTimeoutError", timeoutSeconds: 30 });
    expect(controller.signal.aborted).toBe(false);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test.each(["success", "rejection", "throw"] as const)("removes the caller listener and timer after callback %s", async (outcome) => {
    const controller = new AbortController();
    const add = jest.spyOn(controller.signal, "addEventListener");
    const remove = jest.spyOn(controller.signal, "removeEventListener");
    const failure = new Error("callback failure");
    let derived!: AbortSignal;
    const operation = withTimeoutSignal({ timeoutSeconds: 60, signal: controller.signal }, (signal) => {
      derived = signal;
      if (outcome === "throw") throw failure;
      if (outcome === "rejection") return Promise.reject(failure);
      return Promise.resolve("value");
    });
    if (outcome === "success") await expect(operation).resolves.toBe("value");
    else await expect(operation).rejects.toBe(failure);

    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]![1]);
    expect(jest.getTimerCount()).toBe(0);
    controller.abort();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(derived.aborted).toBe(false);
  });

  test("keeps sibling operations independent when one deadline expires", async () => {
    const controller = new AbortController();
    let firstSignal!: AbortSignal;
    let secondSignal!: AbortSignal;
    let resolveSecond!: (value: string) => void;
    const first = withTimeoutSignal({ timeoutSeconds: 1, signal: controller.signal }, (signal) => {
      firstSignal = signal;
      return new Promise<never>(() => {});
    });
    const firstResult = first.catch((error: unknown) => error);
    const second = withTimeoutSignal({ timeoutSeconds: 5, signal: controller.signal }, (signal) => {
      secondSignal = signal;
      return new Promise<string>((resolve) => { resolveSecond = resolve; });
    });

    await jest.advanceTimersByTimeAsync(1_000);
    expect(await firstResult).toBeInstanceOf(OperationTimeoutError);
    expect(firstSignal.aborted).toBe(true);
    expect(secondSignal.aborted).toBe(false);
    expect(controller.signal.aborted).toBe(false);
    resolveSecond("still running");
    await expect(second).resolves.toBe("still running");
    expect(jest.getTimerCount()).toBe(0);
  });

  test("caller cancellation wins even when the callback synchronously returns success afterward", async () => {
    const controller = new AbortController();
    const operation = withTimeoutSignal({ signal: controller.signal }, async () => {
      controller.abort("cancel during dispatch");
      return "late success";
    });
    await expect(operation).rejects.toBeInstanceOf(OperationAbortedError);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("caller cancellation clears its pending deadline", async () => {
    const controller = new AbortController();
    const operation = withTimeoutSignal({ timeoutSeconds: 5, signal: controller.signal }, () => new Promise<never>(() => {}));
    const result = operation.catch((error: unknown) => error);
    expect(jest.getTimerCount()).toBe(1);
    controller.abort();
    expect(await result).toBeInstanceOf(OperationAbortedError);
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(await result).toBeInstanceOf(OperationAbortedError);
  });

  test("rejects malformed options and signals before dispatch", async () => {
    const callback = jest.fn(async () => "called");
    for (const options of [null, [], "5", { signal: {} }, { timeoutSeconds: null }]) {
      await expect(withTimeoutSignal(options as never, callback)).rejects.toBeInstanceOf(Error);
    }
    expect(callback).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test("does not dispose a resource delivered successfully", async () => {
    const resource = { close: jest.fn(async () => undefined) };
    const dispose = jest.fn(async (value: typeof resource) => value.close());
    await expect(withTimeoutSignal(5, async () => resource, dispose)).resolves.toBe(resource);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(dispose).not.toHaveBeenCalled();
    expect(resource.close).not.toHaveBeenCalled();
  });

  test.each(["caller", "deadline"] as const)("disposes a late resource exactly once after %s cancellation", async (cause) => {
    const controller = new AbortController();
    const resource = { close: jest.fn(async () => undefined) };
    const dispose = jest.fn(async (value: typeof resource) => value.close());
    let resolveLate!: (value: typeof resource) => void;
    const operation = withTimeoutSignal({ timeoutSeconds: 1, signal: controller.signal }, () =>
      new Promise<typeof resource>((resolve) => { resolveLate = resolve; }), dispose,
    );
    const result = operation.catch((error: unknown) => error);
    if (cause === "caller") controller.abort();
    else await jest.advanceTimersByTimeAsync(1_000);
    expect(await result).toBeInstanceOf(cause === "caller" ? OperationAbortedError : OperationTimeoutError);
    expect(dispose).not.toHaveBeenCalled();

    resolveLate(resource);
    await jest.advanceTimersByTimeAsync(0);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith(resource);
    expect(resource.close).toHaveBeenCalledTimes(1);
    controller.abort();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test.each(["throw", "reject"] as const)("observes a late disposer %s without changing cancellation", async (outcome) => {
    const controller = new AbortController();
    let resolveLate!: (value: object) => void;
    const dispose = jest.fn(() => {
      if (outcome === "throw") throw new Error("private cleanup detail");
      return Promise.reject(new Error("private cleanup detail"));
    });
    const operation = withTimeoutSignal({ signal: controller.signal }, () =>
      new Promise<object>((resolve) => { resolveLate = resolve; }), dispose,
    );
    const result = operation.catch((error: unknown) => error);
    controller.abort("cancel");
    const cancellation = await result;
    expect(cancellation).toBeInstanceOf(OperationAbortedError);
    resolveLate({});
    await jest.advanceTimersByTimeAsync(0);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(await result).toBe(cancellation);
    expect(jest.getTimerCount()).toBe(0);
  });
});

function clientWithControlRpc(controlRpc: object): SliverClient {
  const config: SliverClientConfig = {
    operator: "timeout-test",
    lhost: "127.0.0.1",
    lport: 31_337,
    ca_certificate: "fixture-ca",
    certificate: "fixture-cert",
    private_key: "fixture-key",
    token: "fixture-token",
  };
  const client = new SliverClient(config);
  const internals = client as unknown as { rpcClients: Record<string, object> };
  internals.rpcClients.control = controlRpc;
  return client;
}
