const createChannel = jest.fn();
const createClient = jest.fn();
const createSliverRpcCredentials = jest.fn();
const startWireGuardProxy = jest.fn();
const SERVER_PUBLIC_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const CLIENT_PRIVATE_KEY = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

jest.mock("nice-grpc", () => ({
  createChannel: (...args: unknown[]) => createChannel(...args),
  createClient: (...args: unknown[]) => createClient(...args),
}));

jest.mock("../internal/credentials", () => ({
  createSliverRpcCredentials: (...args: unknown[]) => createSliverRpcCredentials(...args),
}));

jest.mock("../internal/wgProxy", () => ({
  hasWireGuardWrapper: (config: { wg?: { enabled?: boolean } }) => config.wg?.enabled === true,
  startWireGuardProxy: (...args: unknown[]) => startWireGuardProxy(...args),
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
  startWireGuardProxy.mockResolvedValue({
    rpcHost: () => "127.0.0.1:4444",
    stop: jest.fn(async () => {}),
  });
});

test("SliverClient.connect() uses the direct operator endpoint without wg", async () => {
  const client = new SliverClient(dummyConfig());

  await client.connect();

  expect(startWireGuardProxy).not.toHaveBeenCalled();
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

test("SliverClient.connect() routes through the WireGuard proxy when the config has a wg block", async () => {
  const proxyStop = jest.fn(async () => {});
  startWireGuardProxy.mockResolvedValue({
    rpcHost: () => "127.0.0.1:4444",
    stop: proxyStop,
  });

  const client = new SliverClient({
    ...dummyConfig(),
    wg: {
      enabled: true,
      server_pub_key: SERVER_PUBLIC_KEY,
      client_private_key: CLIENT_PRIVATE_KEY,
      client_ip: "100.65.0.2",
    },
  });

  await client.connect();

  expect(startWireGuardProxy).toHaveBeenCalledTimes(1);
  expect(createChannel).toHaveBeenCalledWith(
    "127.0.0.1:4444",
    { kind: "creds" },
    expect.objectContaining({
      "grpc.ssl_target_name_override": "localhost",
      "grpc.default_authority": "localhost",
    }),
  );

  await client.disconnect();
  expect(proxyStop).toHaveBeenCalledTimes(1);
});

test("SliverClient.connect() cleans up the WireGuard proxy when startup fails", async () => {
  const proxyStop = jest.fn(async () => {});
  startWireGuardProxy.mockResolvedValue({
    rpcHost: () => "127.0.0.1:4444",
    stop: proxyStop,
  });
  createClient.mockReturnValue({
    getVersion: jest.fn(async () => {
      throw new Error("auth failed");
    }),
    events: jest.fn(() => emptyStream()),
    tunnelData: jest.fn(() => emptyStream()),
  });

  const client = new SliverClient({
    ...dummyConfig(),
    wg: {
      enabled: true,
      server_pub_key: SERVER_PUBLIC_KEY,
      client_private_key: CLIENT_PRIVATE_KEY,
      client_ip: "100.65.0.2",
    },
  });

  await expect(client.connect()).rejects.toThrow("auth failed");
  expect(proxyStop).toHaveBeenCalledTimes(1);
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

  const proxyStop = jest.fn(async () => {});
  startWireGuardProxy.mockResolvedValue({
    rpcHost: () => "127.0.0.1:4444",
    stop: proxyStop,
  });
  const client = new SliverClient({
    ...dummyConfig(),
    wg: {
      enabled: true,
      server_pub_key: SERVER_PUBLIC_KEY,
      client_private_key: CLIENT_PRIVATE_KEY,
      client_ip: "100.65.0.2",
    },
  });

  const firstConnect = client.connect();
  const secondConnect = client.connect();
  await versionStarted;
  const disconnect = client.disconnect();

  expect(startWireGuardProxy).toHaveBeenCalledTimes(1);
  expect(proxyStop).not.toHaveBeenCalled();

  resolveVersion({});
  await Promise.all([firstConnect, secondConnect, disconnect]);

  expect(startWireGuardProxy).toHaveBeenCalledTimes(1);
  expect(proxyStop).toHaveBeenCalledTimes(1);
  expect(client.isConnected).toBe(false);
});
