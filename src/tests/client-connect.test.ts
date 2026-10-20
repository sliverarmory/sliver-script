const createChannel = jest.fn();
const createClient = jest.fn();
const createSliverRpcCredentials = jest.fn();

jest.mock("nice-grpc", () => ({
  createChannel: (...args: unknown[]) => createChannel(...args),
  createClient: (...args: unknown[]) => createClient(...args),
}));

jest.mock("../internal/credentials", () => ({
  createSliverRpcCredentials: (...args: unknown[]) => createSliverRpcCredentials(...args),
}));

import { SliverClient } from "../client";
import type { SliverClientConfig } from "../config";
import { OperationAbortedError, OperationTimeoutError } from "../internal/timeout";

function emptyStream<T>(): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: async function* () {
      return;
    },
  };
}

function dummyConfig(): SliverClientConfig {
  return {
    operator: "test",
    token: "token",
    lhost: "localhost",
    lport: 31337,
    ca_certificate: "ca",
    certificate: "cert",
    private_key: "key",
  };
}

beforeEach(() => {
  jest.clearAllMocks();

  createSliverRpcCredentials.mockReturnValue({ kind: "creds" });
  createChannel.mockReturnValue({ close: jest.fn() });
  createClient.mockReturnValue({
    getVersion: jest.fn(async () => ({})),
    events: jest.fn(() => emptyStream()),
    tunnelData: jest.fn(() => emptyStream()),
  });
});

test("SliverClient.connect() uses the direct operator endpoint", async () => {
  const client = new SliverClient(dummyConfig());

  await client.connect();

  expect(createSliverRpcCredentials).toHaveBeenCalledTimes(1);
  expect(createChannel).toHaveBeenCalledTimes(6);
  for (const [, credentials] of createChannel.mock.calls) {
    expect(credentials).toBe(createSliverRpcCredentials.mock.results[0]!.value);
  }
  expect(createChannel).toHaveBeenCalledWith(
    "localhost:31337",
    { kind: "creds" },
    expect.objectContaining({
      "grpc.max_send_message_length": expect.any(Number),
      "grpc.max_receive_message_length": expect.any(Number),
    }),
  );

  await client.disconnect();
});

test("SliverClient rejects operator WireGuard before creating credentials or channels", () => {
  expect(() => new SliverClient({
    ...dummyConfig(),
    wg: { enabled: true },
  })).toThrow(
    "WireGuard operator transport is not supported; use a direct mTLS operator config",
  );
  expect(createSliverRpcCredentials).not.toHaveBeenCalled();
  expect(createChannel).not.toHaveBeenCalled();
});

test("SliverClient.connect() cleans up direct channels when startup fails", async () => {
  const close = jest.fn();
  createChannel.mockReturnValue({ close });
  createClient.mockReturnValue({
    getVersion: jest.fn(async () => {
      throw new Error("auth failed");
    }),
    events: jest.fn(() => emptyStream()),
    tunnelData: jest.fn(() => emptyStream()),
  });

  const client = new SliverClient(dummyConfig());

  await expect(client.connect()).rejects.toThrow("auth failed");
  expect(close).toHaveBeenCalledTimes(6);
  expect(client.isConnected).toBe(false);
});

test("SliverClient serializes concurrent connect and disconnect operations", async () => {
  let resolveVersion!: (value: object) => void;
  let reportVersionStarted!: () => void;
  const versionStarted = new Promise<void>((resolve) => {
    reportVersionStarted = resolve;
  });
  const getVersion = jest.fn(() => {
    reportVersionStarted();
    return new Promise<object>((resolve) => {
      resolveVersion = resolve;
    });
  });
  createClient.mockImplementation(() => ({
    getVersion,
    events: jest.fn(() => emptyStream()),
    tunnelData: jest.fn(() => emptyStream()),
  }));

  const client = new SliverClient(dummyConfig());

  const firstConnect = client.connect();
  const secondConnect = client.connect();
  await versionStarted;
  const disconnect = client.disconnect();

  expect(createSliverRpcCredentials).toHaveBeenCalledTimes(1);

  resolveVersion({});
  await Promise.all([firstConnect, secondConnect, disconnect]);

  expect(createSliverRpcCredentials).toHaveBeenCalledTimes(1);
  expect(client.isConnected).toBe(false);
});

test("pre-aborted connect never creates credentials or channels", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(new SliverClient(dummyConfig()).connect({ signal: controller.signal }))
    .rejects.toBeInstanceOf(OperationAbortedError);
  expect(createSliverRpcCredentials).not.toHaveBeenCalled();
  expect(createChannel).not.toHaveBeenCalled();
});

test("connect deadline includes reconciliation and closes old channels before a queued reconnect", async () => {
  jest.useFakeTimers();
  const channels: Array<{ close: jest.Mock }> = [];
  const ordering: string[] = [];
  createChannel.mockImplementation(() => {
    const index = channels.length;
    ordering.push(`create-${index}`);
    const channel = { close: jest.fn(() => ordering.push(`close-${index}`)) };
    channels.push(channel);
    return channel;
  });
  const getRportFwdListeners = jest.fn()
    .mockImplementationOnce((_request: unknown, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }))
    .mockResolvedValue({ Listeners: [] });
  createClient.mockImplementation(() => ({
    getVersion: jest.fn(async () => ({})),
    getRportFwdListeners,
    events: jest.fn(() => emptyStream()),
    tunnelData: jest.fn(() => emptyStream()),
  }));
  const client = new SliverClient(dummyConfig());
  const forward = { id: 1, sessionId: "session", markDetached: jest.fn(), reconcile: jest.fn() };
  (client as unknown as { managedReversePortForwards: Map<string, typeof forward> })
    .managedReversePortForwards.set("fixture", forward);
  try {
    const first = client.connect(1);
    const firstRejected = expect(first).rejects.toBeInstanceOf(OperationTimeoutError);
    await jest.advanceTimersByTimeAsync(0);
    expect(getRportFwdListeners).toHaveBeenCalledTimes(1);
    const reconnected = client.connect(0);
    await jest.advanceTimersByTimeAsync(1_000);
    await firstRejected;
    await expect(reconnected).resolves.toBe(client);
    expect(client.isConnected).toBe(true);
    expect(channels).toHaveLength(12);
    expect(channels.slice(0, 6).every((channel) => channel.close.mock.calls.length === 1)).toBe(true);
    expect(channels.slice(6).every((channel) => channel.close.mock.calls.length === 0)).toBe(true);
    expect(ordering.indexOf("close-5")).toBeLessThan(ordering.indexOf("create-6"));
    expect(getRportFwdListeners).toHaveBeenCalledTimes(2);
  } finally {
    await client.disconnect();
    jest.useRealTimers();
  }
});
