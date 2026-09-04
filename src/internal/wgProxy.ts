import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { rmSync } from "node:fs";
import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

import type { SliverClientConfig, SliverClientWireGuardConfig } from "../config";
import { validateWireGuardKey, wireGuardAddressFamily } from "./wireGuardConfig";

const HELPER_BINARY_ENV = "SLIVER_SCRIPT_WG_PROXY_BINARY";
const HELPER_STARTUP_TIMEOUT_MILLISECONDS = 30_000;
const HELPER_BUILD_TIMEOUT_MILLISECONDS = 120_000;
const HELPER_OUTPUT_MAX_CHARACTERS = 64 * 1024;
// A regular CommonJS install has a trustworthy package-relative source root.
// Bundlers may erase __dirname; in that mode we fail closed unless the host
// supplies an explicit absolute helper path rather than trusting process.cwd().
export function packageRootForDirectory(directory: string | undefined): string | null {
  return directory === undefined ? null : path.resolve(directory, "../..");
}

export function wireGuardHelperBuildEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    CGO_ENABLED: "0",
    GOTOOLCHAIN: environment.GOTOOLCHAIN ?? "local",
    GOWORK: "off",
  };
}

export function wireGuardHelperRuntimeEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const allowed = platform === "win32"
    ? new Set(["SYSTEMROOT", "WINDIR", "TEMP", "TMP"])
    : new Set(["TMPDIR"]);
  const runtime: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    const canonical = key.toUpperCase();
    if (allowed.has(canonical) && value !== undefined) {
      runtime[canonical] = value;
    }
  }
  return runtime;
}

const packageRoot = packageRootForDirectory(typeof __dirname === "string" ? __dirname : undefined);
const helperRoot = packageRoot === null ? null : path.join(packageRoot, "wireguard-proxy");
const helperExecutableName = process.platform === "win32" ? "sliver-script-wgproxy.exe" : "sliver-script-wgproxy";
const helperSourcePaths = helperRoot === null
  ? []
  : ["go.mod", "go.sum", "main.go", "netstack.go"].map((name) => path.join(helperRoot, name));

interface ProxyReadyMessage {
  listen_host: string;
  listen_port: number;
}

export interface WireGuardProxySession {
  rpcHost(): string;
  stop(): Promise<void>;
}

let helperBinaryPromise: Promise<string> | null = null;
let helperBuildDirectory: string | null = null;

// Source builds are process-private and are retained only while this Node
// process can launch them. The synchronous exit hook also covers process.exit()
// where promises and other asynchronous cleanup cannot run.
process.once("exit", () => {
  if (helperBuildDirectory) {
    try {
      rmSync(helperBuildDirectory, { recursive: true, force: true });
    } catch {
      // Exit cleanup is best-effort; the directory is already process-private.
    }
  }
});

export function hasWireGuardWrapper(config: SliverClientConfig): boolean {
  return config.wg?.enabled === true;
}

export function serializeWireGuardHelperConfig(config: SliverClientConfig): Buffer {
  if (!config.wg) {
    throw new Error("WireGuard proxy requested without a wg config block");
  }
  return Buffer.from(`${JSON.stringify({
    lhost: config.lhost,
    lport: config.lport,
    wg: {
      server_pub_key: config.wg.server_pub_key,
      client_private_key: config.wg.client_private_key,
      ...(config.wg.preshared_key === undefined ? {} : { preshared_key: config.wg.preshared_key }),
      client_ip: config.wg.client_ip,
      ...(config.wg.server_ip === undefined ? {} : { server_ip: config.wg.server_ip }),
    },
  })}\n`, "utf8");
}

export async function startWireGuardProxy(config: SliverClientConfig): Promise<WireGuardProxySession> {
  if (!config.wg) {
    throw new Error("WireGuard proxy requested without a wg config block");
  }

  validateWireGuardConfig(config.wg);

  // The operator config also contains the RPC token and mTLS private key. Keep
  // the helper boundary deliberately narrower than SliverClientConfig.
  const serializedConfig = serializeWireGuardHelperConfig(config);

  let binaryPath: string;
  try {
    binaryPath = await resolveHelperBinary();
  } catch (error) {
    serializedConfig.fill(0);
    throw error;
  }

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(binaryPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: wireGuardHelperRuntimeEnvironment(),
    });
  } catch (error) {
    serializedConfig.fill(0);
    throw error;
  }

  const stderr = collectText(child.stderr);
  const ready = waitForReady(child, stderr);
  const inputWritten = new Promise<void>((resolve, reject) => {
    let settled = false;
    child.stdin.on("error", () => {
      serializedConfig.fill(0);
      if (settled) return;
      settled = true;
      reject(new Error("WireGuard helper closed its configuration input before startup"));
    });
    child.stdin.write(serializedConfig, () => {
      serializedConfig.fill(0);
      if (settled) return;
      settled = true;
      resolve();
    });
  });

  let message: ProxyReadyMessage;
  try {
    [message] = await Promise.all([ready, inputWritten]);
  } catch (error) {
    serializedConfig.fill(0);
    await stopChild(child);
    throw error;
  }
  return {
    rpcHost: () => `${message.listen_host}:${message.listen_port}`,
    stop: async () => {
      await stopChild(child);
    },
  };
}

function validateWireGuardConfig(config: SliverClientWireGuardConfig): void {
  const missing: string[] = [];

  if (!hasText(config.server_pub_key)) {
    missing.push("server_pub_key");
  }
  if (!hasText(config.client_private_key)) {
    missing.push("client_private_key");
  }
  if (!hasText(config.client_ip)) {
    missing.push("client_ip");
  }

  if (missing.length !== 0) {
    throw new Error(`Invalid sliver config: incomplete wg block (missing ${missing.join(", ")})`);
  }

  validateWireGuardKey(config.server_pub_key, "server_pub_key");
  validateWireGuardKey(config.client_private_key, "client_private_key");
  if (config.client_pub_key !== undefined) {
    validateWireGuardKey(config.client_pub_key, "client_pub_key");
  }
  if (config.preshared_key !== undefined) {
    validateWireGuardKey(config.preshared_key, "preshared_key");
  }

  const clientFamily = wireGuardAddressFamily(config.client_ip, "client_ip");
  const serverFamily = config.server_ip === undefined
    ? 4
    : wireGuardAddressFamily(config.server_ip, "server_ip");
  if (clientFamily !== serverFamily) {
    throw new Error("Invalid sliver config: wg.client_ip and wg.server_ip must use the same address family");
  }
}

function hasText(value: string | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

async function resolveHelperBinary(): Promise<string> {
  const configuredBinary = process.env[HELPER_BINARY_ENV];
  if (configuredBinary) {
    if (!path.isAbsolute(configuredBinary) || !(await isRegularFile(configuredBinary))) {
      throw new Error(`Configured WireGuard helper does not exist: ${configuredBinary}`);
    }
    return configuredBinary;
  }

  if (helperRoot === null) {
    throw new Error(`Bundled WireGuard support requires an absolute ${HELPER_BINARY_ENV} path`);
  }

  if (!helperBinaryPromise) {
    helperBinaryPromise = buildHelperBinary();
  }

  try {
    return await helperBinaryPromise;
  } catch (error) {
    helperBinaryPromise = null;
    throw error;
  }
}

async function buildHelperBinary(): Promise<string> {
  if (helperRoot === null) {
    throw new Error(`Bundled WireGuard support requires an absolute ${HELPER_BINARY_ENV} path`);
  }
  for (const sourcePath of helperSourcePaths) {
    if (!(await isRegularFile(sourcePath))) {
      throw new Error(`WireGuard helper source is missing: ${sourcePath}`);
    }
  }

  const stagedDir = await mkdtemp(path.join(os.tmpdir(), "sliver-script-wgproxy-"));
  await chmod(stagedDir, 0o700);
  const stagedBinaryPath = path.join(stagedDir, helperExecutableName);

  try {
    await runCommand(
      "go",
      ["build", "-mod=readonly", "-trimpath", "-buildvcs=false", "-o", stagedBinaryPath, "."],
      helperRoot,
      HELPER_BUILD_TIMEOUT_MILLISECONDS,
    );
    helperBuildDirectory = stagedDir;
    return stagedBinaryPath;
  } catch (error) {
    await rm(stagedDir, { recursive: true, force: true });
    throw error;
  }
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink()) return false;
    return info.isFile();
  } catch {
    return false;
  }
}

function collectText(stream: NodeJS.ReadableStream): () => string {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer = (buffer + chunk).slice(-HELPER_OUTPUT_MAX_CHARACTERS);
  });
  return () => buffer.trim();
}

function waitForReady(
  child: ChildProcessWithoutNullStreams,
  stderr: () => string,
): Promise<ProxyReadyMessage> {
  return new Promise<ProxyReadyMessage>((resolve, reject) => {
    let settled = false;
    const lines = readline.createInterface({ input: child.stdout });
    const timer = setTimeout(() => {
      rejectWith(`WireGuard helper did not become ready within ${HELPER_STARTUP_TIMEOUT_MILLISECONDS}ms`);
    }, HELPER_STARTUP_TIMEOUT_MILLISECONDS);

    const cleanup = () => {
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      lines.close();
    };

    const rejectWith = (message: string) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error(message));
    };

    const onError = (error: Error) => {
      rejectWith(`Failed to start WireGuard helper: ${error.message}`);
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const stderrText = stderr();
      const reason = stderrText
        ? `WireGuard helper exited before startup: ${stderrText}`
        : `WireGuard helper exited before startup (code=${String(code)}, signal=${String(signal)})`;
      rejectWith(reason);
    };

    lines.once("line", (line) => {
      let message: Partial<ProxyReadyMessage>;
      try {
        message = JSON.parse(line) as Partial<ProxyReadyMessage>;
      } catch {
        rejectWith("WireGuard helper returned invalid startup JSON");
        return;
      }

      const listenHost = message.listen_host;
      const listenPort = message.listen_port;
      if (
        (listenHost !== "127.0.0.1" && listenHost !== "::1") ||
        typeof listenPort !== "number" ||
        !Number.isSafeInteger(listenPort) ||
        listenPort < 1 ||
        listenPort > 65_535
      ) {
        rejectWith("WireGuard helper returned an invalid startup payload");
        return;
      }

      settled = true;
      cleanup();
      resolve({ listen_host: listenHost, listen_port: listenPort });
    });

    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const exited = waitForExit(child);
  child.kill();

  const timeout = new Promise<void>((resolve) => {
    setTimeout(resolve, 2_000);
  });

  await Promise.race([exited, timeout]);

  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
  });
}

function runCommand(command: string, args: string[], cwd: string, timeoutMilliseconds: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: wireGuardHelperBuildEnvironment(),
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill();
      forceTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 2_000);
    }, timeoutMilliseconds);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-HELPER_OUTPUT_MAX_CHARACTERS);
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-HELPER_OUTPUT_MAX_CHARACTERS);
    });

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      reject(timedOut
        ? new Error(`'${command} ${args.join(" ")}' exceeded ${timeoutMilliseconds}ms`)
        : new Error(`Failed to run '${command}': ${error.message}`));
    });

    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (timedOut) {
        reject(new Error(`'${command} ${args.join(" ")}' exceeded ${timeoutMilliseconds}ms`));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }

      const output = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
      const reason = output || `code=${String(code)} signal=${String(signal)}`;
      reject(new Error(`'${command} ${args.join(" ")}' failed: ${reason}`));
    });
  });
}
