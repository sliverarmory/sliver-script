import { Subject, of, throwError } from "rxjs";

import {
  BeaconTaskIdentityError,
  BeaconTaskResponseError,
  BeaconTaskStateError,
  BeaconTaskTimeoutError,
  createBeaconTaskHandle,
  type BeaconTaskHandleDependencies,
} from "../beaconTasks";
import { OperationAbortedError, OperationTimeoutError } from "../internal/timeout";
import { BEACON_TASK_MAX_PAYLOAD_BYTES } from "../messageBudget";
import { BeaconTask, Event } from "../pb/clientpb/client";
import { Ping } from "../pb/sliverpb/sliver";

const taskId = "task-42";
const beaconId = "beacon-42";

function task(overrides: Partial<BeaconTask> = {}): BeaconTask {
  return BeaconTask.create({
    ID: taskId,
    BeaconID: beaconId,
    State: "completed",
    Response: Buffer.from(Ping.encode(Ping.create({ Nonce: 42, Response: { Err: "" } })).finish()),
    ...overrides,
  });
}

function setup(overrides: Partial<BeaconTaskHandleDependencies<Ping>> = {}) {
  const events = new Subject<Event>();
  const getBeaconTaskContent = jest.fn(async (_request: unknown, _options?: { signal?: AbortSignal }) => task());
  const cancel = jest.fn(async (_id: string, _options: unknown) => task({ State: "canceled" }));
  const rpc = { getBeaconTaskContent };
  const handle = createBeaconTaskHandle({
    taskId, beaconId, decoder: Ping, getRpc: () => rpc, events, cancel,
    ...overrides,
  });
  return { events, rpc, cancel, handle };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

afterEach(() => {
  jest.useRealTimers();
});

test("fetches a task that completed before subscribing and can wait again", async () => {
  const { handle, rpc, events } = setup();
  const completed = task();
  rpc.getBeaconTaskContent.mockResolvedValue(completed);

  await expect(handle.wait()).resolves.toMatchObject({ Nonce: 42 });
  await expect(handle.wait()).resolves.toMatchObject({ Nonce: 42 });
  expect(handle.id).toBe(taskId);
  expect(rpc.getBeaconTaskContent).toHaveBeenCalledTimes(2);
  expect(rpc.getBeaconTaskContent).toHaveBeenCalledWith({ ID: taskId }, { signal: expect.any(AbortSignal) });
  expect(events.observers).toHaveLength(0);
  expect(completed.Response.some((byte) => byte !== 0)).toBe(true);
});

test("reattaches by a persisted task id without a known beacon id", async () => {
  const { handle } = setup({ beaconId: undefined });
  await expect(handle.wait()).resolves.toMatchObject({ Nonce: 42 });
});

test("polling recovers a completed task when its result event was lost", async () => {
  jest.useFakeTimers();
  const { handle, rpc, events } = setup();
  rpc.getBeaconTaskContent.mockResolvedValueOnce(task({ State: "pending", Response: Buffer.alloc(0) }));
  const waiting = handle.wait(5);
  await flush();
  expect(rpc.getBeaconTaskContent).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1_000);
  await expect(waiting).resolves.toMatchObject({ Nonce: 42 });
  expect(rpc.getBeaconTaskContent).toHaveBeenCalledTimes(2);
  expect(events.observers).toHaveLength(0);
  expect(jest.getTimerCount()).toBe(0);
});

test("task result events trigger an early refresh without waiting for polling", async () => {
  const { handle, rpc, events } = setup();
  rpc.getBeaconTaskContent.mockResolvedValueOnce(task({ State: "pending", Response: Buffer.alloc(0) }));
  const waiting = handle.wait(5);
  await flush();
  events.next(Event.create({ EventType: "beacon-taskresult", Data: Buffer.from(BeaconTask.encode(task()).finish()) }));
  await expect(waiting).resolves.toMatchObject({ Nonce: 42 });
  expect(rpc.getBeaconTaskContent).toHaveBeenCalledTimes(2);
});

test("a synchronous event at subscription time does not lose or duplicate completion", async () => {
  const event = Event.create({ EventType: "beacon-taskresult", Data: Buffer.from(BeaconTask.encode(task()).finish()) });
  const { handle, rpc } = setup({ events: of(event) });
  await expect(handle.wait()).resolves.toMatchObject({ Nonce: 42 });
  expect(rpc.getBeaconTaskContent).toHaveBeenCalledTimes(1);
});

test.each(["canceled", "failed"] as const)("rejects terminal %s tasks with a typed state error", async (state) => {
  const { handle, rpc } = setup();
  rpc.getBeaconTaskContent.mockResolvedValue(task({ State: state, Response: Buffer.alloc(0) }));
  await expect(handle.wait()).rejects.toMatchObject({
    name: "BeaconTaskStateError", taskId, state, message: `Beacon task ${taskId} ended in state ${state}`,
  });
  await expect(handle.wait()).rejects.toBeInstanceOf(BeaconTaskStateError);
});

test.each([
  { ID: "other-task" },
  { BeaconID: "other-beacon" },
  { BeaconID: "" },
])("rejects mismatched task metadata %j", async (fields) => {
  const { handle, rpc } = setup();
  rpc.getBeaconTaskContent.mockResolvedValue(task(fields));
  await expect(handle.wait()).rejects.toBeInstanceOf(BeaconTaskIdentityError);
  await expect(handle.status()).rejects.toBeInstanceOf(BeaconTaskIdentityError);
});

test("caller abort cleans up a stalled wait without canceling the remote task", async () => {
  jest.useFakeTimers();
  const { handle, rpc, events, cancel } = setup();
  rpc.getBeaconTaskContent.mockImplementation(() => new Promise(() => undefined));
  const controller = new AbortController();
  const waiting = handle.wait({ timeoutSeconds: 0, signal: controller.signal });
  const rejected = expect(waiting).rejects.toBeInstanceOf(OperationAbortedError);
  await flush();
  const rpcSignal = rpc.getBeaconTaskContent.mock.calls[0]?.[1]?.signal;
  controller.abort("cancel local waiting");
  await rejected;
  expect(rpcSignal?.aborted).toBe(true);
  expect(events.observers).toHaveLength(0);
  expect(jest.getTimerCount()).toBe(0);
  expect(cancel).not.toHaveBeenCalled();
});

test("pre-aborted waits perform no fetch or event subscription", async () => {
  const { handle, rpc, events } = setup();
  const controller = new AbortController();
  controller.abort();
  await expect(handle.wait({ signal: controller.signal })).rejects.toBeInstanceOf(OperationAbortedError);
  expect(rpc.getBeaconTaskContent).not.toHaveBeenCalled();
  expect(events.observers).toHaveLength(0);
});

test("an aborted wait can be resumed on the same handle", async () => {
  const { handle, rpc } = setup();
  rpc.getBeaconTaskContent.mockResolvedValueOnce(task({ State: "pending", Response: Buffer.alloc(0) }));
  const controller = new AbortController();
  const waiting = handle.wait({ signal: controller.signal });
  const rejected = expect(waiting).rejects.toBeInstanceOf(OperationAbortedError);
  await flush();
  controller.abort();
  await rejected;
  await expect(handle.wait()).resolves.toMatchObject({ Nonce: 42 });
});

test("a zero default timeout is preserved when only a caller signal is supplied", async () => {
  jest.useFakeTimers();
  const { handle, rpc } = setup({ defaultTimeoutSeconds: 0 });
  rpc.getBeaconTaskContent.mockResolvedValue(task({ State: "pending", Response: Buffer.alloc(0) }));
  const controller = new AbortController();
  let settled = false;
  const waiting = handle.wait({ signal: controller.signal });
  void waiting.then(() => { settled = true; }, () => { settled = true; });
  await jest.advanceTimersByTimeAsync(31_000);
  expect(settled).toBe(false);
  rpc.getBeaconTaskContent.mockResolvedValue(task());
  await jest.advanceTimersByTimeAsync(1_000);
  await expect(waiting).resolves.toMatchObject({ Nonce: 42 });
  expect(jest.getTimerCount()).toBe(0);
});

test("time limits produce a typed task timeout and clean up polling", async () => {
  jest.useFakeTimers();
  const { handle, rpc, events } = setup({ defaultTimeoutSeconds: 2 });
  rpc.getBeaconTaskContent.mockResolvedValue(task({ State: "pending", Response: Buffer.alloc(0) }));
  const waiting = handle.wait({});
  const rejected = expect(waiting).rejects.toMatchObject({
    name: "BeaconTaskTimeoutError", taskId, timeoutSeconds: 2,
    message: `Timeout waiting for beacon task result: ${taskId}`,
  });
  await jest.advanceTimersByTimeAsync(2_000);
  await rejected;
  await expect(waiting).rejects.toBeInstanceOf(BeaconTaskTimeoutError);
  expect(events.observers).toHaveLength(0);
  expect(jest.getTimerCount()).toBe(0);
});

test("malformed and unrelated events do not fail or refresh another task", async () => {
  jest.useFakeTimers();
  const { handle, rpc, events } = setup();
  rpc.getBeaconTaskContent.mockResolvedValueOnce(task({ State: "pending", Response: Buffer.alloc(0) }));
  const waiting = handle.wait();
  await flush();
  events.next(Event.create({ EventType: "beacon-taskresult", Data: Buffer.from([0xff]) }));
  events.next(Event.create({ EventType: "beacon-taskresult", Data: Buffer.from(BeaconTask.encode(task({ ID: "other" })).finish()) }));
  await flush();
  expect(rpc.getBeaconTaskContent).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1_000);
  await expect(waiting).resolves.toMatchObject({ Nonce: 42 });
});

test("polling works when the event observable has failed", async () => {
  const { handle } = setup({ events: throwError(() => new Error("stream unavailable")) });
  await expect(handle.wait()).resolves.toMatchObject({ Nonce: 42 });
});

test("decoded target errors are typed and do not reveal target error text", async () => {
  const { handle, rpc } = setup();
  const targetError = "sensitive target diagnostic";
  rpc.getBeaconTaskContent.mockResolvedValue(task({
    Response: Buffer.from(Ping.encode(Ping.create({ Response: { Err: targetError } })).finish()),
  }));
  await expect(handle.wait()).rejects.toMatchObject({
    name: "BeaconTaskResponseError", message: `Beacon task ${taskId} was rejected by the target`,
  });
});

test.each([
  Buffer.alloc(0),
  Buffer.from([0xff]),
  Buffer.alloc(BEACON_TASK_MAX_PAYLOAD_BYTES + 1),
])("rejects empty, malformed, or oversized terminal task bytes", async (bytes) => {
  const { handle, rpc } = setup();
  rpc.getBeaconTaskContent.mockResolvedValue(task({ Response: bytes }));
  await expect(handle.wait()).rejects.toBeInstanceOf(BeaconTaskResponseError);
});

test("each concurrent decoder receives independent response bytes", async () => {
  const shared = task({ Response: Buffer.from([7, 8, 9]) });
  const rpc = { getBeaconTaskContent: jest.fn(async () => shared) };
  const handle = createBeaconTaskHandle({
    taskId, beaconId, getRpc: () => rpc, events: of<Event>(),
    decoder: { decode: (bytes: Buffer) => bytes.subarray(0) },
    cancel: async () => shared,
  });
  const [first, second] = await Promise.all([handle.wait(), handle.wait()]);
  first.fill(0);
  expect(second).toEqual(Buffer.from([7, 8, 9]));
  expect(shared.Response).toEqual(Buffer.from([7, 8, 9]));
});

test("resolves a new RPC client after a temporary disconnection", async () => {
  jest.useFakeTimers();
  const first = { getBeaconTaskContent: jest.fn(async () => task({ State: "pending", Response: Buffer.alloc(0) })) };
  const second = { getBeaconTaskContent: jest.fn(async () => task()) };
  let current: typeof first | undefined = first;
  const { handle } = setup({ getRpc: () => current });
  const waiting = handle.wait(10);
  await flush();
  current = undefined;
  await jest.advanceTimersByTimeAsync(1_000);
  current = second;
  await jest.advanceTimersByTimeAsync(1_000);
  await expect(waiting).resolves.toMatchObject({ Nonce: 42 });
  expect(first.getBeaconTaskContent).toHaveBeenCalledTimes(1);
  expect(second.getBeaconTaskContent).toHaveBeenCalledTimes(1);
});

test.each([1, 14])("retries transient RPC status %s while waiting", async (code) => {
  jest.useFakeTimers();
  const { handle, rpc } = setup();
  rpc.getBeaconTaskContent.mockRejectedValueOnce(Object.assign(new Error("transport closed"), { code }));
  const waiting = handle.wait();
  await jest.advanceTimersByTimeAsync(1_000);
  await expect(waiting).resolves.toMatchObject({ Nonce: 42 });
});

test("permanent RPC errors fail immediately without leaking a polling timer", async () => {
  jest.useFakeTimers();
  const { handle, rpc, events } = setup();
  const denied = Object.assign(new Error("permission denied"), { code: 7 });
  rpc.getBeaconTaskContent.mockRejectedValue(denied);
  await expect(handle.wait()).rejects.toBe(denied);
  expect(rpc.getBeaconTaskContent).toHaveBeenCalledTimes(1);
  expect(events.observers).toHaveLength(0);
  expect(jest.getTimerCount()).toBe(0);
});

test("status and explicit cancellation verify the bound task metadata", async () => {
  const { handle, rpc, cancel } = setup();
  await expect(handle.status(4)).resolves.toMatchObject({ ID: taskId, State: "completed" });
  await expect(handle.cancel({ timeoutSeconds: 7 })).resolves.toMatchObject({ ID: taskId, State: "canceled" });
  expect(rpc.getBeaconTaskContent).toHaveBeenCalledTimes(2);
  expect(cancel).toHaveBeenCalledWith(taskId, { timeoutSeconds: 7, signal: expect.any(AbortSignal) });
});

test("pre-aborted cancellation does not dispatch a remote cancellation", async () => {
  const { handle, cancel } = setup();
  const controller = new AbortController();
  controller.abort();
  await expect(handle.cancel({ signal: controller.signal })).rejects.toBeInstanceOf(OperationAbortedError);
  expect(cancel).not.toHaveBeenCalled();
});

test("disconnected status and bound cancellation fail without a remote mutation", async () => {
  const { handle, cancel } = setup({ getRpc: () => undefined });
  await expect(handle.status()).rejects.toThrow("SliverClient is not connected");
  await expect(handle.cancel()).rejects.toThrow("SliverClient is not connected");
  expect(cancel).not.toHaveBeenCalled();
});

test("cancel still verifies the returned mutation response", async () => {
  const { handle } = setup({ cancel: async () => task({ ID: "wrong-id" }) });
  await expect(handle.cancel()).rejects.toBeInstanceOf(BeaconTaskIdentityError);
});

test.each([{ ID: "other-task" }, { BeaconID: "other-beacon" }])(
  "mismatched task metadata %j prevents remote cancellation",
  async (fields) => {
    const { handle, rpc, cancel } = setup();
    rpc.getBeaconTaskContent.mockResolvedValue(task(fields));
    await expect(handle.cancel()).rejects.toBeInstanceOf(BeaconTaskIdentityError);
    expect(cancel).not.toHaveBeenCalled();
  },
);

test("cancellation identity lookup uses the current RPC client", async () => {
  const old = { getBeaconTaskContent: jest.fn(async () => task({ BeaconID: "stale-beacon" })) };
  const replacement = { getBeaconTaskContent: jest.fn(async () => task()) };
  let current = old;
  const { handle, cancel } = setup({ getRpc: () => current });
  current = replacement;
  await expect(handle.cancel()).resolves.toMatchObject({ State: "canceled" });
  expect(old.getBeaconTaskContent).not.toHaveBeenCalled();
  expect(replacement.getBeaconTaskContent).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledTimes(1);
});

test("identity lookup and cancellation share one whole-operation deadline", async () => {
  jest.useFakeTimers();
  let lookupSignal: AbortSignal | undefined;
  let mutationSignal: AbortSignal | undefined;
  const cancel = jest.fn((_id: string, options: unknown) => {
    mutationSignal = (options as { signal: AbortSignal }).signal;
    return new Promise<BeaconTask>(() => undefined);
  });
  const { handle, rpc } = setup({ cancel });
  rpc.getBeaconTaskContent.mockImplementation((_request, options) => {
    lookupSignal = options?.signal;
    return new Promise((resolve) => setTimeout(() => resolve(task()), 700));
  });
  const canceling = handle.cancel(1);
  const rejected = expect(canceling).rejects.toBeInstanceOf(OperationTimeoutError);
  await jest.advanceTimersByTimeAsync(700);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(mutationSignal).toBe(lookupSignal);
  expect(mutationSignal?.aborted).toBe(false);
  await jest.advanceTimersByTimeAsync(300);
  await rejected;
  expect(mutationSignal?.aborted).toBe(true);
  expect(jest.getTimerCount()).toBe(0);
});

test("a late identity lookup cannot dispatch cancellation after the caller aborts", async () => {
  let resolveLookup!: (value: BeaconTask) => void;
  const { handle, rpc, cancel } = setup();
  rpc.getBeaconTaskContent.mockImplementation(() => new Promise((resolve) => { resolveLookup = resolve; }));
  const controller = new AbortController();
  const canceling = handle.cancel({ signal: controller.signal });
  const rejected = expect(canceling).rejects.toBeInstanceOf(OperationAbortedError);
  controller.abort();
  await rejected;
  resolveLookup(task());
  await flush();
  expect(cancel).not.toHaveBeenCalled();
});

test("an unbound handle can cancel without fetching task content", async () => {
  const { handle, rpc, cancel } = setup({ beaconId: undefined });
  await expect(handle.cancel()).resolves.toMatchObject({ State: "canceled" });
  expect(rpc.getBeaconTaskContent).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledTimes(1);
});

test.each(["", " ", " task", "task ", "x".repeat(257)])("rejects invalid task id %j before using RPCs", (id) => {
  expect(() => setup({ taskId: id })).toThrow(TypeError);
});
