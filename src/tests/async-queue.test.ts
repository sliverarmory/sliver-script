import { AsyncQueue } from "../internal/asyncQueue";

function byteQueue(overrides: Partial<{
  maxItems: number;
  maxWeight: number;
  dispose: (value: Uint8Array) => void;
  onConsumerCancel: () => void;
}> = {}) {
  return new AsyncQueue<Uint8Array>({
    maxItems: overrides.maxItems ?? 2,
    maxWeight: overrides.maxWeight ?? 4,
    weight: (value) => value.byteLength,
    overflowError: () => new Error("reviewed queue budget exceeded"),
    dispose: overrides.dispose,
    onConsumerCancel: overrides.onConsumerCancel,
  });
}

describe("bounded AsyncQueue", () => {
  test("rejects missing or unsafe capacity limits", () => {
    expect(() => new AsyncQueue({
      maxItems: 0,
      maxWeight: 1,
      weight: () => 1,
      overflowError: () => new Error("overflow"),
    })).toThrow(/maxItems must be a positive safe integer/u);
    expect(() => new AsyncQueue({
      maxItems: 1,
      maxWeight: Number.MAX_SAFE_INTEGER + 1,
      weight: () => 1,
      overflowError: () => new Error("overflow"),
    })).toThrow(/maxWeight must be a positive safe integer/u);
  });

  test("atomically fails on overflow and clears both incoming and buffered bytes", async () => {
    const disposed: Uint8Array[] = [];
    const queue = byteQueue({
      maxItems: 2,
      maxWeight: 3,
      dispose: (value) => {
        disposed.push(value);
        value.fill(0);
      },
    });
    const first = Uint8Array.from([1, 2]);
    const overflow = Uint8Array.from([3, 4]);

    expect(queue.push(first)).toBe(true);
    expect(queue.push(overflow)).toBe(false);
    expect(queue.bufferedItems).toBe(0);
    expect(queue.bufferedWeight).toBe(0);
    expect(disposed).toEqual([overflow, first]);
    expect([...first]).toEqual([0, 0]);
    expect([...overflow]).toEqual([0, 0]);
    await expect(queue[Symbol.asyncIterator]().next()).rejects.toThrow("reviewed queue budget exceeded");
  });

  test("treats one item larger than the queue budget as isolated overflow", async () => {
    const oversized = Uint8Array.from([1, 2, 3, 4, 5]);
    const queue = byteQueue({ maxWeight: 4, dispose: (value) => value.fill(0) });
    const pending = queue[Symbol.asyncIterator]().next();

    expect(queue.push(oversized)).toBe(false);
    expect([...oversized]).toEqual([0, 0, 0, 0, 0]);
    expect(queue.bufferedItems).toBe(0);
    expect(queue.bufferedWeight).toBe(0);
    await expect(pending).rejects.toThrow("reviewed queue budget exceeded");
  });

  test("delivers a pending read without buffering and drains queued items before close", async () => {
    const queue = byteQueue();
    const iterator = queue[Symbol.asyncIterator]();
    const pending = iterator.next();
    const direct = Uint8Array.from([1, 2, 3]);

    expect(queue.push(direct)).toBe(true);
    await expect(pending).resolves.toEqual({ value: direct, done: false });
    expect(queue.bufferedItems).toBe(0);

    const buffered = Uint8Array.from([4]);
    expect(queue.push(buffered)).toBe(true);
    queue.close();
    await expect(iterator.next()).resolves.toEqual({ value: buffered, done: false });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  test("consumer cancellation securely disposes queued data and invokes cleanup once", async () => {
    const cancel = jest.fn();
    const queue = byteQueue({ dispose: (value) => value.fill(0), onConsumerCancel: cancel });
    const first = Uint8Array.from([1, 2]);
    const second = Uint8Array.from([3, 4]);
    queue.push(first);
    queue.push(second);

    const iterator = queue[Symbol.asyncIterator]();
    await expect(iterator.return!()).resolves.toEqual({ value: undefined, done: true });

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(queue.bufferedItems).toBe(0);
    expect(queue.bufferedWeight).toBe(0);
    expect([...first]).toEqual([0, 0]);
    expect([...second]).toEqual([0, 0]);
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  test.each(["close", "cancel", "fail"] as const)(
    "disposes data pushed after %s",
    (method) => {
      const queue = byteQueue({ dispose: (value) => value.fill(0) });
      if (method === "fail") {
        queue.fail(new Error("closed"));
      } else {
        queue[method]();
      }
      const late = Uint8Array.from([1, 2, 3]);

      expect(queue.push(late)).toBe(false);
      expect([...late]).toEqual([0, 0, 0]);
    },
  );

  test("rejects concurrent pending reads rather than creating an unbounded waiter list", async () => {
    const queue = byteQueue();
    const iterator = queue[Symbol.asyncIterator]();
    const firstRead = iterator.next();

    await expect(iterator.next()).rejects.toThrow("one pending consumer read");
    queue.cancel();
    await expect(firstRead).resolves.toEqual({ value: undefined, done: true });
  });
});
