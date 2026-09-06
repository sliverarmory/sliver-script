import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import type {
  SliverClient as SliverClientInstance,
  SliverClientConfig,
  clientpb,
} from "../lib";

// This file is emitted to e2e/dist/support.js. Load the package built at the
// repository root while retaining compile-time checks against its declarations.
const sliverScript = require("../../lib") as typeof import("../lib");

export interface E2EEnvironment {
  readonly configFile: string;
  readonly sliverSha: string;
  readonly expectedOS: "darwin" | "linux" | "windows";
  readonly expectedArch: "amd64" | "arm64";
  readonly operator: string;
}

export interface ConnectedE2EClient {
  readonly client: SliverClientInstance;
  readonly config: SliverClientConfig;
  readonly environment: E2EEnvironment;
}

export function loadE2EEnvironment(): E2EEnvironment {
  const configFile = requiredEnvironmentVariable("SLIVER_E2E_CONFIG_FILE");
  const sliverSha = requiredEnvironmentVariable("SLIVER_E2E_SLIVER_SHA");
  const expectedOS = requiredEnvironmentVariable("SLIVER_E2E_EXPECTED_OS");
  const expectedArch = requiredEnvironmentVariable("SLIVER_E2E_EXPECTED_ARCH");
  const operator = requiredEnvironmentVariable("SLIVER_E2E_OPERATOR");

  assert.match(
    sliverSha,
    /^[0-9a-f]{40}$/u,
    "SLIVER_E2E_SLIVER_SHA must be a full lowercase Git commit SHA",
  );
  assert.ok(
    expectedOS === "darwin" || expectedOS === "linux" || expectedOS === "windows",
    "SLIVER_E2E_EXPECTED_OS must be darwin, linux, or windows",
  );
  assert.ok(
    expectedArch === "amd64" || expectedArch === "arm64",
    "SLIVER_E2E_EXPECTED_ARCH must be amd64 or arm64",
  );
  assert.match(
    operator,
    /^[A-Za-z0-9]+$/u,
    "SLIVER_E2E_OPERATOR must contain only alphanumeric characters",
  );

  return {
    configFile,
    sliverSha,
    expectedOS,
    expectedArch,
    operator,
  };
}

export async function withConnectedClient<T>(
  environment: E2EEnvironment,
  operation: (context: ConnectedE2EClient) => Promise<T>,
): Promise<T> {
  const config = await sliverScript.parseConfigFile(environment.configFile);
  assert.equal(config.operator, environment.operator, "operator profile identity");
  assert.equal(config.lhost, "127.0.0.1", "operator profile must use loopback");
  assert.ok(Number.isSafeInteger(config.lport), "operator profile port must be an integer");
  assert.ok(config.lport >= 1 && config.lport <= 65_535, "operator profile port must be valid");
  assert.equal(
    Object.prototype.hasOwnProperty.call(config, "wg"),
    false,
    "operator profile must use direct mTLS",
  );

  const client = new sliverScript.SliverClient(config);
  assert.equal(client.isConnected, false, "client must begin disconnected");
  assert.equal(client.rpcHost(), `127.0.0.1:${config.lport}`, "client endpoint");

  try {
    const connected = await client.connect();
    assert.equal(connected, client, "connect must resolve to the client instance");
    assert.equal(client.isConnected, true, "client must report a connected state");
    return await operation({ client, config, environment });
  } finally {
    await client.disconnect();
    assert.equal(client.isConnected, false, "client must report a disconnected state");
  }
}

export async function waitForOnlineOperator(
  client: SliverClientInstance,
  operatorName: string,
  timeoutMilliseconds = 15_000,
): Promise<clientpb.Operator> {
  const deadline = Date.now() + timeoutMilliseconds;
  let observed: clientpb.Operator[] = [];

  while (Date.now() < deadline) {
    observed = (await client.getOperators(2)).Operators;
    const operator = observed.find((candidate) => candidate.Name === operatorName);
    if (operator?.Online) return operator;
    await delay(100);
  }

  const summary = observed.map((operator) => `${operator.Name}:${operator.Online}`).join(", ") || "none";
  throw new Error(`Timed out waiting for online operator ${operatorName}; observed ${summary}`);
}

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} is required`);
  return value;
}
