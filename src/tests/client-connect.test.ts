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
