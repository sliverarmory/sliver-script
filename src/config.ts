import { readdir, readFile } from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";

import { validateWireGuardKey, wireGuardAddressFamily } from "./internal/wireGuardConfig";

export interface SliverClientWireGuardConfig {
  enabled?: boolean;
  server_pub_key: string;
  client_private_key: string;
  client_pub_key?: string;
  preshared_key?: string;
  client_ip: string;
  server_ip?: string;
}

export interface SliverClientConfig {
  operator: string;
  lhost: string;
  lport: number;
  ca_certificate: string;
  certificate: string;
  private_key: string;
  token: string;
  wg?: SliverClientWireGuardConfig;
}

export async function parseConfigFile(filePath: string): Promise<SliverClientConfig> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Config file does not exist: ${filePath}`);
  }
  const data = await readFile(filePath);
  return parseConfig(data);
}

export function parseConfig(data: Buffer): SliverClientConfig {
  const raw = JSON.parse(data.toString("utf8")) as Partial<SliverClientConfig>;
  validateConfig(raw);
  return raw as SliverClientConfig;
}

export async function listConfigs(configDir: string): Promise<SliverClientConfig[]> {
  try {
    const items = await readdir(configDir);
    const configs: SliverClientConfig[] = [];

    for (const item of items) {
      const filePath = path.join(configDir, item);
      if (!fs.existsSync(filePath) || fs.lstatSync(filePath).isDirectory()) {
        continue;
      }
      try {
        configs.push(await parseConfigFile(filePath));
      } catch {
        // Best-effort: ignore invalid config files in the directory.
      }
    }

    return configs;
  } catch {
    return [];
  }
}

function validateConfig(config: Partial<SliverClientConfig>): asserts config is SliverClientConfig {
  const mustBeString = [
    "operator",
    "lhost",
    "ca_certificate",
    "certificate",
    "private_key",
    "token",
  ] as const;

  for (const key of mustBeString) {
    if (typeof config[key] !== "string") {
      throw new Error(`Invalid sliver config: missing/invalid ${key}`);
    }
  }
  if (!config.ca_certificate?.trim()) {
    throw new Error("Invalid sliver config: missing/invalid ca_certificate");
  }
  if (
    typeof config.lport !== "number"
    || !Number.isSafeInteger(config.lport)
    || config.lport < 1
    || config.lport > 65_535
  ) {
    throw new Error("Invalid sliver config: missing/invalid lport");
  }

  if (config.wg !== undefined) {
    if (!config.wg || typeof config.wg !== "object" || Array.isArray(config.wg)) {
      throw new Error("Invalid sliver config: missing/invalid wg");
    }

    const wgKeys = [
      "server_pub_key",
      "client_private_key",
      "client_pub_key",
      "preshared_key",
      "client_ip",
      "server_ip",
    ] as const;

    if (config.wg.enabled !== undefined && typeof config.wg.enabled !== "boolean") {
      throw new Error("Invalid sliver config: missing/invalid wg.enabled");
    }

    for (const key of wgKeys) {
      const value = config.wg[key];
      if (value !== undefined && typeof value !== "string") {
        throw new Error(`Invalid sliver config: missing/invalid wg.${key}`);
      }
    }

    for (const key of ["server_pub_key", "client_private_key", "client_ip"] as const) {
      if (!config.wg[key]?.trim()) {
        throw new Error(`Invalid sliver config: missing/invalid wg.${key}`);
      }
    }

    for (const key of ["server_pub_key", "client_private_key", "client_pub_key", "preshared_key"] as const) {
      const value = config.wg[key];
      if (value !== undefined) {
        validateWireGuardKey(value, key);
      }
    }

    let clientFamily: 4 | 6 | undefined;
    if (config.wg.client_ip !== undefined) {
      clientFamily = wireGuardAddressFamily(config.wg.client_ip, "client_ip");
    }
    let serverFamily: 4 | 6 | undefined;
    if (config.wg.server_ip !== undefined) {
      serverFamily = wireGuardAddressFamily(config.wg.server_ip, "server_ip");
    } else if (config.wg.enabled === true) {
      serverFamily = 4;
    }
    if (clientFamily !== undefined && serverFamily !== undefined && clientFamily !== serverFamily) {
      throw new Error("Invalid sliver config: wg.client_ip and wg.server_ip must use the same address family");
    }
  }
}


// Back-compat exports (v1.x API)
export const ParseConfigFile = parseConfigFile;
export const ParseConfig = parseConfig;
export const ListConfigs = listConfigs;
