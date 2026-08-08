const createChannel = jest.fn();
const createClient = jest.fn();
const createSliverRpcCredentials = jest.fn();
const startWireGuardProxy = jest.fn();

jest.mock("nice-grpc", () => ({
  createChannel: (...args: unknown[]) => createChannel(...args),
  createClient: (...args: unknown[]) => createClient(...args),
}));

jest.mock("../internal/credentials", () => ({
  createSliverRpcCredentials: (...args: unknown[]) => createSliverRpcCredentials(...args),
}));

jest.mock("../internal/wgProxy", () => ({
  hasWireGuardWrapper: (config: { wg?: unknown }) => config.wg !== undefined,
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
      server_pub_key: "server",
      client_private_key: "private",
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
      server_pub_key: "server",
      client_private_key: "private",
      client_ip: "100.65.0.2",
    },
  });

  await expect(client.connect()).rejects.toThrow("auth failed");
  expect(proxyStop).toHaveBeenCalledTimes(1);
});
