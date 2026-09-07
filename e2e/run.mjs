#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, opendir, readFile, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const sliverDir = path.join(repoRoot, "sliver");
const operatorName = "sliverscripte2e";
// A cold daemon start extracts the embedded Go/Zig toolchains before binding.
// Match Sliver's own E2E startup allowance on uncached hosted runners.
const startupTimeoutMilliseconds = 10 * 60_000;
const shutdownTimeoutMilliseconds = 10_000;
const forcedShutdownTimeoutMilliseconds = 5_000;
const defaultCommandTimeoutMilliseconds = 2 * 60_000;
const buildCommandTimeoutMilliseconds = 45 * 60_000;
// Match Sliver's comprehensive native E2E allowance. Implant generation can
// legitimately take several minutes per mode on a cold hosted runner.
const suiteTimeoutMilliseconds = 3.5 * 60 * 60_000;
const commandOutputLimit = 2_000_000;
const activeCommands = new Map();
let cancellationSignal;

function log(message) {
  console.log(`[e2e] ${message}`);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function appendBounded(current, chunk) {
  const combined = current + chunk.toString();
  return combined.length <= commandOutputLimit
    ? combined
    : combined.slice(combined.length - commandOutputLimit);
}

function mergedEnv(overrides = {}) {
  return { ...process.env, ...overrides };
}

function isolatedServerEnv(overrides = {}) {
  const env = {};
  for (const key of [
    "PATH",
    "Path",
    "COMSPEC",
    "PATHEXT",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "WINDIR",
    "LANG",
    "LC_ALL",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, ...overrides };
}

async function runCommand(command, args, options = {}) {
  const {
    cwd = repoRoot,
    env = {},
    inheritEnv = true,
    quiet = false,
    timeoutMilliseconds = defaultCommandTimeoutMilliseconds,
  } = options;

  if (cancellationSignal) throw new Error(`E2E run cancelled by ${cancellationSignal}`);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: inheritEnv ? mergedEnv(env) : env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error.stdout ??= stdout;
      error.stderr ??= stderr;
      reject(error);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr });
    };
    const controller = {
      cancel(error) {
        fail(error);
        // The main cleanup path verifies termination and reports any failure.
        void forceStopCommand(child).catch(() => {});
      },
    };
    activeCommands.set(child, controller);
    timer = setTimeout(() => {
      controller.cancel(new Error(
        `${command} ${args.join(" ")} exceeded ${timeoutMilliseconds}ms`,
      ));
    }, timeoutMilliseconds);

    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
      if (!quiet) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
      if (!quiet) process.stderr.write(chunk);
    });
    child.once("error", (error) => {
      activeCommands.delete(child);
      fail(error);
    });
    child.once("close", (code, signal) => {
      activeCommands.delete(child);
      if (code === 0) {
        succeed();
        return;
      }
      const suffix = signal ? ` (signal ${signal})` : "";
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      const error = new Error(
        `${command} ${args.join(" ")} exited with ${code ?? "no status"}${suffix}`
          + (output ? `\n${output}` : ""),
      );
      fail(error);
    });
  });
}

async function runTaskkill(pid, force) {
  return new Promise((resolve) => {
    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");
    const child = spawn("taskkill.exe", args, {
      stdio: "ignore",
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, forcedShutdownTimeoutMilliseconds);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

async function forceStopCommand(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const killed = await runTaskkill(child.pid, true);
    if (!killed) child.kill();
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") child.kill("SIGKILL");
  }
}

async function stopActiveCommands(reason = new Error("E2E command cleanup")) {
  const commands = [...activeCommands.entries()];
  for (const [, controller] of commands) controller.cancel(reason);
  const outcomes = await Promise.allSettled(commands.map(async ([child]) => {
    await forceStopCommand(child);
    const exited = await Promise.race([
      waitForProcessExit(child).then(() => true),
      sleep(forcedShutdownTimeoutMilliseconds).then(() => false),
    ]);
    if (!exited && child.exitCode === null && child.signalCode === null) {
      throw new Error(`Child process ${child.pid} did not exit after forced termination`);
    }
  }));
  const errors = outcomes
    .filter((outcome) => outcome.status === "rejected")
    .map((outcome) => outcome.reason);
  if (errors.length > 0) throw new AggregateError(errors, "Failed to stop active E2E commands");
}

function mergeFailure(primary, secondary, context) {
  const error = secondary instanceof Error ? secondary : new Error(String(secondary));
  if (!primary) return new Error(`${context}: ${error.message}`, { cause: error });
  return new AggregateError(
    [primary, error],
    `${primary instanceof Error ? primary.message : String(primary)}; ${context}: ${error.message}`,
  );
}

async function fileHasContent(filePath) {
  try {
    return (await stat(filePath)).size > 0;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function nativeAssetPaths(goos, goarch) {
  const platformDir = path.join(sliverDir, "server", "assets", "fs", goos, goarch);
  const platformFiles = goos === "windows"
    ? ["go.zip", "garble.exe", "zig.zip"]
    : ["go.zip", "garble", "zig.tar.xz"];
  return [
    path.join(sliverDir, "server", "assets", "fs", "src.zip"),
    ...platformFiles.map((file) => path.join(platformDir, file)),
  ];
}

function nativeAssetStampPath(goos, goarch) {
  // Platform asset directories are intentionally ignored by the Sliver
  // submodule, so the cache marker never dirties the pinned source checkout.
  return path.join(
    sliverDir,
    "server",
    "assets",
    "fs",
    goos,
    goarch,
    ".sliver-script-e2e-assets.json",
  );
}

async function nativeAssetsAreCurrent(assetPaths, stampPath, sliverSha, goVersion) {
  if ((await Promise.all(assetPaths.map(fileHasContent))).some((present) => !present)) return false;
  try {
    const stamp = JSON.parse(await readFile(stampPath, "utf8"));
    return stamp.sliverSha === sliverSha && stamp.goVersion === goVersion && stamp.schema === 1;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
}

async function nativeGoPlatform(buildEnv) {
  const { stdout } = await runCommand("go", ["env", "GOOS", "GOARCH"], {
    cwd: sliverDir,
    env: buildEnv,
    quiet: true,
  });
  const values = stdout.trim().split(/\s+/);
  if (values.length !== 2) throw new Error(`Unexpected 'go env GOOS GOARCH' output: ${stdout.trim()}`);
  return { goos: values[0], goarch: values[1] };
}

function validateNativePlatform(goos, goarch) {
  const nodeGoos = process.platform === "win32" ? "windows" : process.platform;
  const nodeGoarch = process.arch === "x64" ? "amd64" : process.arch;
  const expectedGoos = process.env.SLIVER_E2E_EXPECTED_OS || nodeGoos;
  const expectedGoarch = process.env.SLIVER_E2E_EXPECTED_ARCH || nodeGoarch;

  if (nodeGoos !== expectedGoos || nodeGoarch !== expectedGoarch) {
    throw new Error(
      `Node runner mismatch: got ${nodeGoos}/${nodeGoarch}, expected ${expectedGoos}/${expectedGoarch}`,
    );
  }
  if (goos !== expectedGoos || goarch !== expectedGoarch) {
    throw new Error(`Go runner mismatch: got ${goos}/${goarch}, expected ${expectedGoos}/${expectedGoarch}`);
  }
}

function resolveSliverSourceMode() {
  const mode = process.env.SLIVER_E2E_SLIVER_SOURCE?.trim() || "pinned";
  if (mode !== "pinned" && mode !== "working-tree") {
    throw new Error(
      `Unsupported SLIVER_E2E_SLIVER_SOURCE=${JSON.stringify(mode)}; expected pinned or working-tree`,
    );
  }
  if (mode === "working-tree") {
    const ciVariables = ["CI", "GITHUB_ACTIONS"].filter(
      (name) => process.env[name]?.trim().toLowerCase() === "true",
    );
    if (ciVariables.length > 0) {
      throw new Error(
        `SLIVER_E2E_SLIVER_SOURCE=working-tree is local-only and cannot run when ${ciVariables.join("/")} is true`,
      );
    }
  }
  return mode;
}

function hashRecord(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

function parseNullTerminatedPaths(output) {
  if (output.length === 0) return [];
  if (!output.endsWith("\0")) {
    throw new Error("git ls-files returned a non-NUL-terminated untracked path list");
  }
  const paths = output.slice(0, -1).split("\0");
  if (paths.some((entry) => entry.length === 0)) {
    throw new Error("git ls-files returned an empty untracked path");
  }
  return paths.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function checkedUntrackedPath(relativePath) {
  const components = relativePath.split(/[\\/]/u);
  if (
    relativePath.length === 0
    || path.isAbsolute(relativePath)
    || components.includes("")
    || components.includes(".")
    || components.includes("..")
  ) {
    throw new Error(`Cannot fingerprint unsafe Sliver untracked path ${JSON.stringify(relativePath)}`);
  }
  const absolutePath = path.resolve(sliverDir, relativePath);
  const containedPath = path.relative(sliverDir, absolutePath);
  if (containedPath.startsWith("..") || path.isAbsolute(containedPath)) {
    throw new Error(`Sliver untracked path escapes the source tree: ${JSON.stringify(relativePath)}`);
  }
  return { absolutePath, relativePath };
}

function statIdentity(fileStat) {
  return [
    fileStat.dev,
    fileStat.ino,
    fileStat.mode,
    fileStat.size,
    fileStat.mtimeNs,
    fileStat.ctimeNs,
  ].join(":");
}

async function hashUntrackedEntry(hash, untrackedPath) {
  const { absolutePath, relativePath } = checkedUntrackedPath(untrackedPath);
  const before = await lstat(absolutePath, { bigint: true });
  const mode = Number(before.mode & 0o7777n).toString(8).padStart(4, "0");
  hashRecord(hash, relativePath);
  hashRecord(hash, mode);

  if (before.isFile()) {
    hashRecord(hash, "file");
    hashRecord(hash, before.size.toString());
    let bytesRead = 0n;
    for await (const chunk of createReadStream(absolutePath)) {
      if (cancellationSignal) throw new Error(`E2E run cancelled by ${cancellationSignal}`);
      bytesRead += BigInt(chunk.length);
      hash.update(chunk);
    }
    if (bytesRead !== before.size) {
      throw new Error(`Sliver untracked file changed while fingerprinting: ${relativePath}`);
    }
  } else if (before.isSymbolicLink()) {
    const rawTarget = await readlink(absolutePath, { encoding: "buffer" });
    const target = Buffer.isBuffer(rawTarget) ? rawTarget : Buffer.from(rawTarget);
    hashRecord(hash, "symlink");
    hashRecord(hash, target);
  } else {
    throw new Error(
      `Cannot fingerprint non-file Sliver untracked entry ${JSON.stringify(relativePath)}`,
    );
  }

  const after = await lstat(absolutePath, { bigint: true });
  if (statIdentity(after) !== statIdentity(before)) {
    throw new Error(`Sliver untracked entry changed while fingerprinting: ${relativePath}`);
  }
}

async function fingerprintSliverWorkingTree(testRoot) {
  const hash = createHash("sha256");
  hashRecord(hash, "sliver-script-e2e-working-tree-v1");

  const diffPath = path.join(testRoot, "sliver-working-tree.patch");
  try {
    await runCommand("git", [
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-textconv",
      `--output=${diffPath}`,
      "HEAD",
      "--",
    ], { cwd: sliverDir, quiet: true });
    const diffStat = await stat(diffPath, { bigint: true });
    hashRecord(hash, "tracked-diff");
    hashRecord(hash, diffStat.size.toString());
    for await (const chunk of createReadStream(diffPath)) hash.update(chunk);
  } finally {
    await rm(diffPath, { force: true });
  }

  const { stdout: untrackedOutput } = await runCommand(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { cwd: sliverDir, quiet: true },
  );
  if (untrackedOutput.length >= commandOutputLimit) {
    throw new Error("Sliver untracked path metadata exceeds the E2E fingerprint limit");
  }
  const untrackedPaths = parseNullTerminatedPaths(untrackedOutput);
  hashRecord(hash, "untracked-entry-count");
  hashRecord(hash, untrackedPaths.length);
  for (const untrackedPath of untrackedPaths) {
    await hashUntrackedEntry(hash, untrackedPath);
  }
  return hash.digest("hex");
}

async function resolveSliverSource(testRoot) {
  const mode = resolveSliverSourceMode();
  const [submoduleRevision, gitlinkRevision] = await Promise.all([
    runCommand("git", ["rev-parse", "HEAD"], { cwd: sliverDir, quiet: true }),
    runCommand("git", ["rev-parse", "HEAD:sliver"], { cwd: repoRoot, quiet: true }),
  ]);
  const sliverSha = submoduleRevision.stdout.trim();
  const gitlinkSha = gitlinkRevision.stdout.trim();
  if (sliverSha !== gitlinkSha) {
    throw new Error(`Sliver submodule mismatch: checkout ${sliverSha}, gitlink ${gitlinkSha}`);
  }

  const integrationLock = JSON.parse(await readFile(path.join(repoRoot, "integration.lock.json"), "utf8"));
  if (integrationLock.sliver?.sourceCommit !== sliverSha) {
    throw new Error(
      `Sliver integration lock mismatch: ${String(integrationLock.sliver?.sourceCommit)} != ${sliverSha}`,
    );
  }

  const { stdout: status } = await runCommand(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: sliverDir, quiet: true },
  );
  const dirty = status.length > 0;
  if (mode === "pinned") {
    if (dirty) {
      throw new Error("Sliver submodule has source modifications; refusing an ambiguous E2E build");
    }
    return { sha: sliverSha, mode, dirty: false };
  }
  if (!dirty) {
    throw new Error(
      "SLIVER_E2E_SLIVER_SOURCE=working-tree requires Sliver source modifications; use the default pinned mode for a clean checkout",
    );
  }

  const patchSha256 = await fingerprintSliverWorkingTree(testRoot);
  log(
    `Using local-only Sliver working tree at ${sliverSha}; expected dirty=true; patch sha256=${patchSha256}`,
  );
  return { sha: sliverSha, mode, dirty: true, patchSha256 };
}

async function verifySliverSourceUnchanged(source, testRoot) {
  const { stdout: revision } = await runCommand("git", ["rev-parse", "HEAD"], {
    cwd: sliverDir,
    quiet: true,
  });
  if (revision.trim() !== source.sha) {
    throw new Error(
      `Sliver source changed during the E2E build: checkout ${revision.trim()}, expected ${source.sha}`,
    );
  }
  const { stdout: status } = await runCommand(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: sliverDir, quiet: true },
  );
  if (!source.dirty) {
    if (status.length > 0) {
      throw new Error("Sliver source changed during the E2E build; the pinned checkout is now dirty");
    }
    return;
  }
  if (status.length === 0) {
    throw new Error("Sliver source changed during the E2E build; the working tree is now clean");
  }
  const patchSha256 = await fingerprintSliverWorkingTree(testRoot);
  if (patchSha256 !== source.patchSha256) {
    throw new Error(
      `Sliver source changed during the E2E build: patch sha256 ${patchSha256} != ${source.patchSha256}`,
    );
  }
}

async function buildSliverServer(testRoot, source) {
  const sliverSha = source.sha;
  const assetSourceKey = source.dirty
    ? `${sliverSha}-working-tree-${source.patchSha256}`
    : sliverSha;
  const goTmp = path.join(testRoot, "go-tmp");
  await mkdir(goTmp, { recursive: true });
  const goMod = await readFile(path.join(sliverDir, "go.mod"), "utf8");
  const requiredGoVersion = goMod.match(/^go\s+(\d+\.\d+(?:\.\d+)?)\s*$/mu)?.[1];
  if (!requiredGoVersion) throw new Error("Pinned Sliver go.mod does not declare a Go version");
  const buildEnv = {
    GOTMPDIR: goTmp,
    GOTOOLCHAIN: process.env.SLIVER_E2E_GOTOOLCHAIN || `go${requiredGoVersion}`,
  };
  if (process.env.SLIVER_E2E_GOCACHE) {
    buildEnv.GOCACHE = process.env.SLIVER_E2E_GOCACHE;
    await mkdir(buildEnv.GOCACHE, { recursive: true });
  } else if (process.env.CI !== "true") {
    buildEnv.GOCACHE = path.join(testRoot, "go-build-cache");
    await mkdir(buildEnv.GOCACHE, { recursive: true });
  }
  const { goos, goarch } = await nativeGoPlatform(buildEnv);
  validateNativePlatform(goos, goarch);

  const assetPaths = nativeAssetPaths(goos, goarch);
  const assetStampPath = nativeAssetStampPath(goos, goarch);
  if (!await nativeAssetsAreCurrent(assetPaths, assetStampPath, assetSourceKey, requiredGoVersion)) {
    log(`Downloading Sliver build assets for ${source.dirty ? "the fingerprinted working tree" : "the pinned submodule"}`);
    await runCommand("go", [
      "run",
      "-buildvcs=false",
      "-mod=vendor",
      "./util/cmd/assets",
      "--no-colors",
    ], {
      cwd: sliverDir,
      env: buildEnv,
      timeoutMilliseconds: buildCommandTimeoutMilliseconds,
    });
    await writeFile(
      assetStampPath,
      `${JSON.stringify({ schema: 1, sliverSha: assetSourceKey, goVersion: requiredGoVersion })}\n`,
      "utf8",
    );
  } else {
    log("Using cached Sliver build assets");
  }

  const binDir = path.join(testRoot, "bin");
  await mkdir(binDir, { recursive: true });
  const binaryName = goos === "windows" ? "sliver-server.exe" : "sliver-server";
  const binaryPath = path.join(binDir, binaryName);
  const compiledAt = String(Math.floor(Date.now() / 1_000));
  log(
    `Compiling native Sliver server ${sliverSha}${source.dirty ? ` (working tree ${source.patchSha256})` : ""} for ${goos}/${goarch}`,
  );
  const dirtyLdflag = source.dirty
    ? " -X github.com/bishopfox/sliver/server/version.GitDirty=Dirty"
    : "";
  await runCommand("go", [
    "build",
    "-buildvcs=false",
    "-mod=vendor",
    "-trimpath",
    "-tags",
    "go_sqlite,server",
    "-ldflags",
    `-X github.com/bishopfox/sliver/server/version.GitCommit=${sliverSha} `
      + `-X github.com/bishopfox/sliver/server/version.CompiledAt=${compiledAt}`
      + dirtyLdflag,
    "-o",
    binaryPath,
    "./server",
  ], {
    cwd: sliverDir,
    env: {
      ...buildEnv,
      CGO_ENABLED: "0",
      GOOS: goos,
      GOARCH: goarch,
    },
    timeoutMilliseconds: buildCommandTimeoutMilliseconds,
  });
  return { binaryPath, goos, goarch };
}

async function allocateLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback TCP port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function startDaemon(binaryPath, port, env) {
  const child = spawn(binaryPath, [
    "daemon",
    "--lhost",
    "127.0.0.1",
    "--lport",
    String(port),
    "--force",
  ], {
    cwd: sliverDir,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  let spawnError;
  child.once("error", (error) => {
    spawnError = error;
  });
  child.stdout.on("data", (chunk) => {
    output = appendBounded(output, chunk);
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output = appendBounded(output, chunk);
    process.stderr.write(chunk);
  });
  return {
    child,
    getOutput: () => output,
    getSpawnError: () => spawnError,
    stopPromise: undefined,
  };
}

function waitForProcessExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

async function stopDaemon(daemon) {
  if (!daemon) return;
  daemon.stopPromise ??= stopDaemonOnce(daemon);
  await daemon.stopPromise;
}

async function stopDaemonOnce(daemon) {
  if (!daemon || daemon.child.exitCode !== null || daemon.child.signalCode !== null) return;
  const { child } = daemon;

  if (process.platform === "win32") {
    await runTaskkill(child.pid, false);
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }

  const exited = await Promise.race([
    waitForProcessExit(child).then(() => true),
    sleep(shutdownTimeoutMilliseconds).then(() => false),
  ]);
  if (exited || child.exitCode !== null || child.signalCode !== null) return;

  log("Sliver daemon did not stop within the grace period; forcing cleanup");
  if (process.platform === "win32") {
    const killed = await runTaskkill(child.pid, true);
    if (!killed) child.kill();
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  const forcedExit = await Promise.race([
    waitForProcessExit(child).then(() => true),
    sleep(forcedShutdownTimeoutMilliseconds).then(() => false),
  ]);
  if (!forcedExit && child.exitCode === null && child.signalCode === null) {
    throw new Error(`Sliver daemon process ${child.pid} did not exit after forced termination`);
  }
}

async function waitForTCP(port, daemon) {
  const deadline = Date.now() + startupTimeoutMilliseconds;
  while (Date.now() < deadline) {
    if (cancellationSignal) throw new Error(`E2E run cancelled by ${cancellationSignal}`);
    if (daemon.getSpawnError()) throw daemon.getSpawnError();
    if (daemon.child.exitCode !== null || daemon.child.signalCode !== null) {
      throw new Error(
        `Sliver daemon exited during startup with ${daemon.child.exitCode ?? daemon.child.signalCode}`,
      );
    }

    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(1_000);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => resolve(false));
    });
    if (connected) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for the Sliver daemon on 127.0.0.1:${port}`);
}

async function proveAuthenticatedReadiness(configPath, expected, daemon) {
  const sliver = require(path.join(repoRoot, "lib"));
  const config = await sliver.parseConfigFile(configPath);
  const deadline = Date.now() + startupTimeoutMilliseconds;
  let lastError;

  while (Date.now() < deadline) {
    if (cancellationSignal) throw new Error(`E2E run cancelled by ${cancellationSignal}`);
    if (daemon.getSpawnError()) throw daemon.getSpawnError();
    if (daemon.child.exitCode !== null || daemon.child.signalCode !== null) {
      throw new Error(
        `Sliver daemon exited before authenticated readiness with `
          + `${daemon.child.exitCode ?? daemon.child.signalCode}`,
      );
    }
    const client = new sliver.SliverClient(config);
    let version;
    try {
      await client.connect();
      version = await client.getVersion(15);
    } catch (error) {
      lastError = error;
    } finally {
      try {
        await client.disconnect();
      } catch {
        // Preserve the connection error, which is the useful readiness signal.
      }
    }
    if (version) {
      if (version.Commit !== expected.sha) {
        throw new Error(`Sliver commit mismatch: got ${version.Commit}, expected ${expected.sha}`);
      }
      if (version.OS !== expected.goos || version.Arch !== expected.goarch) {
        throw new Error(
          `Sliver server platform mismatch: got ${version.OS}/${version.Arch}, expected ${expected.goos}/${expected.goarch}`,
        );
      }
      if (version.Dirty !== expected.dirty) {
        throw new Error(
          `Sliver dirty-state mismatch: got ${version.Dirty}, expected ${expected.dirty}`,
        );
      }
      return;
    }
    await sleep(500);
  }
  throw new Error(
    `Timed out establishing an authenticated sliver-script connection: ${lastError?.message || lastError}`,
  );
}

async function collectGroups() {
  const groupDir = path.join(repoRoot, "e2e", "dist", "groups");
  const files = (await readdir(groupDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^\d{2}-.+\.js$/.test(entry.name))
    .map((entry) => ({
      name: entry.name.slice(0, -3),
      path: path.join(groupDir, entry.name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  const requested = (process.env.SLIVER_E2E_GROUPS || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (requested.length === 0) return files;

  const requestedSet = new Set(requested);
  if (requested.some((name) => /^(?:0[4-9]|1[01])-/.test(name))) {
    requestedSet.add("03-listener-generation-callbacks");
  }
  const selected = files.filter((group) => requestedSet.has(group.name));
  const unknown = requested.filter((name) => !files.some((group) => group.name === name));
  if (unknown.length > 0) throw new Error(`Unknown E2E group(s): ${unknown.join(", ")}`);
  return selected;
}

async function runGroups(groups, env, resultsDir, results) {
  log(`Running ${groups.length} logical groups in one stateful suite`);
  let commandError;
  try {
    const output = await runCommand(process.execPath, [path.join(repoRoot, "e2e", "dist", "suite.js")], {
      env: {
        ...env,
        SLIVER_E2E_GROUPS: groups.map((group) => group.name).join(","),
        SLIVER_E2E_RESULTS_DIR: resultsDir,
      },
      inheritEnv: false,
      timeoutMilliseconds: suiteTimeoutMilliseconds,
    });
    await writeFile(path.join(resultsDir, "suite.log"), `${output.stdout}${output.stderr}`, "utf8");
  } catch (error) {
    commandError = error;
    await writeFile(
      path.join(resultsDir, "suite.log"),
      `${error?.stdout || ""}${error?.stderr || ""}`,
      "utf8",
    );
  }

  try {
    const recorded = JSON.parse(await readFile(path.join(resultsDir, "group-results.json"), "utf8"));
    if (!Array.isArray(recorded)) throw new Error("group-results.json must contain an array");
    results.push(...recorded);
  } catch (error) {
    if (!commandError) throw error;
  }
  if (commandError) throw commandError;
}

async function preserveSliverLog(serverRoot, resultsDir, testRoot) {
  if (!serverRoot) return;
  const source = path.join(serverRoot, "logs", "sliver.log");
  try {
    const raw = await readFile(source, "utf8");
    const bounded = raw
      .slice(-500_000)
      .replaceAll(testRoot, "<isolated-e2e-root>")
      .replaceAll("sliver-script-e2e-password", "<e2e-credential-fixture>");
    await writeFile(path.join(resultsDir, "sliver.log"), bounded, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function makeTreeRemovable(directory) {
  try {
    await chmod(directory, 0o700);
    const entries = await opendir(directory);
    for await (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await makeTreeRemovable(entryPath);
      } else if (!entry.isSymbolicLink()) {
        await chmod(entryPath, 0o600);
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function main() {
  const testRoot = await mkdtemp(path.join(os.tmpdir(), "sliver-script-e2e-"));
  const resultsDir = path.resolve(
    repoRoot,
    process.env.SLIVER_E2E_RESULTS_DIR || path.join(testRoot, "results"),
  );
  await mkdir(resultsDir, { recursive: true });

  const startedAt = new Date().toISOString();
  let daemon;
  let groupResults = [];
  let platform = {};
  let sliverSource;
  let serverRoot = "";
  let failure;
  let signalHandler;
  let groups = [];

  signalHandler = (signal) => {
    if (cancellationSignal) return;
    cancellationSignal = signal;
    const error = new Error(`E2E run cancelled by ${signal}`);
    log(`Received ${signal}; cancelling child processes and cleaning up`);
    void stopActiveCommands(error).catch((cleanupError) => console.error(cleanupError));
    void stopDaemon(daemon).catch((cleanupError) => console.error(cleanupError));
  };
  process.once("SIGINT", signalHandler);
  process.once("SIGTERM", signalHandler);

  try {
    groups = await collectGroups();
    if (groups.length === 0) throw new Error("No compiled E2E groups were found");

    sliverSource = await resolveSliverSource(testRoot);
    let built;
    let buildFailure;
    try {
      built = await buildSliverServer(testRoot, sliverSource);
    } catch (error) {
      buildFailure = error;
    }
    try {
      await verifySliverSourceUnchanged(sliverSource, testRoot);
    } catch (error) {
      if (buildFailure) {
        throw new AggregateError(
          [buildFailure, error],
          "Sliver build failed and its source changed during the build",
        );
      }
      throw error;
    }
    if (buildFailure) throw buildFailure;
    platform = { os: built.goos, arch: built.goarch };

    const runtimeDirs = {
      server: path.join(testRoot, "server"),
      client: path.join(testRoot, "client"),
      home: path.join(testRoot, "home"),
      tmp: path.join(testRoot, "tmp"),
    };
    serverRoot = runtimeDirs.server;
    await Promise.all(Object.values(runtimeDirs).map((directory) => mkdir(directory, { recursive: true })));
    // Sliver's implant compiler logs its inherited environment after a failed
    // build. Give the daemon only platform essentials and isolated paths so
    // uploaded diagnostics cannot contain CI tokens or unrelated credentials.
    const runtimeEnv = isolatedServerEnv({
      HOME: runtimeDirs.home,
      USERPROFILE: runtimeDirs.home,
      TMPDIR: runtimeDirs.tmp,
      TMP: runtimeDirs.tmp,
      TEMP: runtimeDirs.tmp,
      SLIVER_ROOT_DIR: runtimeDirs.server,
      SLIVER_CLIENT_ROOT_DIR: runtimeDirs.client,
      // The embedded toolchain intentionally omits its VERSION file to reduce
      // assets. Prevent Go's auto mode from trying to redownload that same
      // toolchain while the server validates implant compiler targets.
      GOTOOLCHAIN: "local",
    });

    const port = await allocateLoopbackPort();
    const configPath = path.join(testRoot, "operator.cfg");
    log(`Starting native Sliver daemon on loopback for ${built.goos}/${built.goarch}`);
    daemon = startDaemon(built.binaryPath, port, runtimeEnv);
    await waitForTCP(port, daemon);

    log(`Generating isolated multiplayer profile for ${operatorName}`);
    const operatorResult = await runCommand(built.binaryPath, [
      "operator",
      "--name",
      operatorName,
      "--lhost",
      "127.0.0.1",
      "--lport",
      String(port),
      "--permissions",
      "all",
      "--save",
      configPath,
    ], { cwd: sliverDir, env: runtimeEnv, inheritEnv: false, quiet: true });
    if (!(await fileHasContent(configPath))) {
      throw new Error(
        `Sliver operator CLI did not create the profile${operatorResult.stdout || operatorResult.stderr
          ? `: ${(operatorResult.stdout + operatorResult.stderr).trim()}`
          : ""}`,
      );
    }

    const sliver = require(path.join(repoRoot, "lib"));
    const parsedConfig = await sliver.parseConfigFile(configPath);
    if (
      parsedConfig.operator !== operatorName
      || parsedConfig.lhost !== "127.0.0.1"
      || parsedConfig.lport !== port
      || Object.prototype.hasOwnProperty.call(parsedConfig, "wg")
    ) {
      throw new Error("Generated multiplayer profile did not match the requested direct-mTLS operator endpoint");
    }
    for (const field of ["ca_certificate", "certificate", "private_key", "token"]) {
      if (!parsedConfig[field]?.trim()) throw new Error(`Generated multiplayer profile is missing ${field}`);
    }

    await proveAuthenticatedReadiness(configPath, {
      sha: sliverSource.sha,
      goos: built.goos,
      goarch: built.goarch,
      dirty: sliverSource.dirty,
    }, daemon);
    log(
      `Authenticated sliver-script readiness check passed; expected dirty=${sliverSource.dirty}`
        + (sliverSource.patchSha256 ? `; patch sha256=${sliverSource.patchSha256}` : ""),
    );

    const groupEnv = {
      ...runtimeEnv,
      SLIVER_E2E_CONFIG_FILE: configPath,
      SLIVER_E2E_SLIVER_SHA: sliverSource.sha,
      SLIVER_E2E_EXPECTED_SLIVER_DIRTY: String(sliverSource.dirty),
      SLIVER_E2E_EXPECTED_OS: built.goos,
      SLIVER_E2E_EXPECTED_ARCH: built.goarch,
      SLIVER_E2E_OPERATOR: operatorName,
      SLIVER_E2E_PLATFORM: process.env.SLIVER_E2E_PLATFORM || `${built.goos}-${built.goarch}`,
      SLIVER_E2E_WORK_DIR: path.join(testRoot, "targets"),
    };
    if (sliverSource.patchSha256) {
      groupEnv.SLIVER_E2E_SLIVER_PATCH_SHA256 = sliverSource.patchSha256;
    }
    await runGroups(groups, groupEnv, resultsDir, groupResults);
    log(`All ${groupResults.length} E2E groups passed`);
  } catch (error) {
    failure = cancellationSignal ? new Error(`E2E run cancelled by ${cancellationSignal}`) : error;
  } finally {
    try {
      await stopActiveCommands();
    } catch (error) {
      failure = mergeFailure(failure, error, "active command cleanup failed");
    }
    try {
      await stopDaemon(daemon);
    } catch (error) {
      failure = mergeFailure(failure, error, "Sliver daemon cleanup failed");
    }
    if (cancellationSignal) failure ||= new Error(`E2E run cancelled by ${cancellationSignal}`);
    if (failure && daemon?.getOutput().trim()) {
      console.error("[e2e] Sliver daemon output tail:");
      console.error(daemon.getOutput().split(/\r?\n/).slice(-80).join("\n"));
    }
    try {
      if (daemon?.getOutput()) {
        await writeFile(path.join(resultsDir, "sliver-server.log"), daemon.getOutput(), "utf8");
      }
    } catch (error) {
      failure = mergeFailure(failure, error, "Sliver daemon diagnostic capture failed");
    }
    try {
      await preserveSliverLog(serverRoot, resultsDir, testRoot);
    } catch (error) {
      failure = mergeFailure(failure, error, "Sliver log capture failed");
    }
    try {
      await writeFile(path.join(resultsDir, "summary.json"), `${JSON.stringify({
        status: cancellationSignal ? "cancelled" : failure ? "failed" : "passed",
        startedAt,
        completedAt: new Date().toISOString(),
        platform,
        sliverSha: sliverSource?.sha || "",
        sliverSourceMode: sliverSource?.mode,
        expectedSliverDirty: sliverSource?.dirty,
        sliverPatchSha256: sliverSource?.patchSha256,
        groups: groupResults,
        error: failure instanceof Error ? failure.message : failure ? String(failure) : undefined,
      }, null, 2)}\n`, "utf8");
    } catch (error) {
      failure = mergeFailure(failure, error, "E2E summary capture failed");
    } finally {
      try {
        await makeTreeRemovable(testRoot);
        await rm(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (error) {
        failure = mergeFailure(failure, error, "isolated E2E secret cleanup failed");
      } finally {
        process.off("SIGINT", signalHandler);
        process.off("SIGTERM", signalHandler);
      }
    }
  }
  if (cancellationSignal) {
    if (failure) console.error(`[e2e] ${failure.stack || failure}`);
    process.exitCode = cancellationSignal === "SIGINT" ? 130 : 143;
    return;
  }
  if (failure) throw failure;
}

main().catch((error) => {
  console.error(`[e2e] ${error?.stack || error}`);
  process.exitCode = 1;
});
