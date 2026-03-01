#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const sliverDir = path.join(repoRoot, "sliver");
const sliverServerPath = path.join(
  sliverDir,
  process.platform === "win32" ? "sliver-server.exe" : "sliver-server",
);
const cacheDir = path.join(repoRoot, "e2e", ".cache");
const sliverBuildStampPath = path.join(cacheDir, "sliver-server-submodule.sha");

const daemonStartupTimeoutMs = 60_000;
const daemonStopTimeoutMs = 10_000;
const portWaitIntervalMs = 200;
const e2eTempRootPrefix = "sliver-script-e2e-";

function log(message) {
  console.log(`[e2e] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isIpLiteral(value) {
  return net.isIP(value) !== 0;
}

function mergeEnv(overrides) {
  return { ...process.env, ...overrides };
}

function formatCommand(command, args) {
  return [command, ...args].join(" ");
}

async function runCommand(command, args, options = {}) {
  const { cwd = repoRoot, env = {}, capture = false } = options;
  const mergedEnv = mergeEnv(env);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: mergedEnv,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });

    let stdout = "";
    let stderr = "";

    if (capture) {
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
    }

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ code, stdout, stderr });
        return;
      }

      const commandLine = formatCommand(command, args);
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      reject(new Error(`Command failed (${code}): ${commandLine}${output ? `\n${output}` : ""}`));
    });
  });
}

async function runCommandWithRetry(command, args, options = {}) {
  const { retries = 3, retryDelayMs = 3_000 } = options;

  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await runCommand(command, args, options);
    } catch (error) {
      lastError = error;
      if (attempt === retries) {
        break;
      }
      log(
        `Command failed (attempt ${attempt}/${retries}): ${formatCommand(command, args)}\n` +
          `Retrying in ${retryDelayMs}ms ...`,
      );
      await sleep(retryDelayMs);
    }
  }

  throw lastError;
}

function startDaemon(command, args, options = {}) {
  const { cwd = repoRoot, env = {} } = options;
  const mergedEnv = mergeEnv(env);
  const child = spawn(command, args, {
    cwd,
    env: mergedEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let combinedOutput = "";
  const appendOutput = (chunk, target) => {
    const text = chunk.toString();
    combinedOutput += text;
    if (combinedOutput.length > 120_000) {
      combinedOutput = combinedOutput.slice(-120_000);
    }
    target.write(text);
  };

  child.stdout?.on("data", (chunk) => appendOutput(chunk, process.stdout));
  child.stderr?.on("data", (chunk) => appendOutput(chunk, process.stderr));

  return {
    child,
    getCombinedOutput: () => combinedOutput,
  };
}

async function getGitSubmoduleHead() {
  const result = await runCommand("git", ["-C", sliverDir, "rev-parse", "HEAD"], {
    capture: true,
  });
  return result.stdout.trim();
}

async function readCachedSubmoduleHead() {
  if (!(await pathExists(sliverBuildStampPath))) {
    return "";
  }
  const content = await readFile(sliverBuildStampPath, "utf8");
  return content.trim();
}

async function ensureSliverServerBuilt(sharedEnv) {
  await mkdir(cacheDir, { recursive: true });

  const currentHead = await getGitSubmoduleHead();
  const cachedHead = await readCachedSubmoduleHead();
  const binaryExists = await pathExists(sliverServerPath);
  const shouldBuild = !binaryExists || cachedHead !== currentHead;

  if (shouldBuild) {
    log(`Building sliver-server via make (submodule HEAD: ${currentHead})`);
    await runCommandWithRetry("make", [], {
      cwd: sliverDir,
      env: sharedEnv,
      retries: 3,
      retryDelayMs: 5_000,
    });
    await writeFile(sliverBuildStampPath, `${currentHead}\n`, "utf8");
    return;
  }

  log(`Reusing existing sliver-server build for submodule HEAD ${currentHead}`);
}

function attemptTcpConnect(host, port, timeoutMs = 1_000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });

    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function waitForDaemonPort(host, port, daemonChild) {
  const deadline = Date.now() + daemonStartupTimeoutMs;
  while (Date.now() < deadline) {
    if (daemonChild.exitCode !== null) {
      throw new Error(`sliver-server daemon exited before startup (code ${daemonChild.exitCode})`);
    }

    if (await attemptTcpConnect(host, port)) {
      return;
    }

    await sleep(portWaitIntervalMs);
  }
  throw new Error(`Timed out waiting for sliver-server daemon on ${host}:${port}`);
}

async function allocateFreePort(host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a free TCP port"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function onceProcessExit(child) {
  return new Promise((resolve) => {
    child.once("exit", resolve);
  });
}

async function stopProcess(child, name) {
  if (!child || child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  const exited = await Promise.race([
    onceProcessExit(child).then(() => true),
    sleep(daemonStopTimeoutMs).then(() => false),
  ]);

  if (!exited && child.exitCode === null) {
    log(`${name} did not exit after SIGTERM, sending SIGKILL`);
    child.kill("SIGKILL");
    await onceProcessExit(child);
  }
}

async function collectE2ETestFiles() {
  const distDir = path.join(repoRoot, "e2e", "dist");
  const entries = await readdir(distDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => path.join(distDir, entry.name))
    .sort();
}

async function cleanupStaleTestRoots(baseDir) {
  let entries = [];
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch {
    return;
  }

  const staleDirs = entries.filter(
    (entry) => entry.isDirectory() && entry.name.startsWith(e2eTempRootPrefix),
  );
  for (const entry of staleDirs) {
    const fullPath = path.join(baseDir, entry.name);
    try {
      await rm(fullPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      log(`Removed previous e2e temp dir: ${fullPath}`);
    } catch {
      // Ignore cleanup issues; they should not block test execution.
    }
  }
}

async function main() {
  const tmpBaseDir = os.tmpdir();
  await cleanupStaleTestRoots(tmpBaseDir);

  const testRoot = await mkdtemp(path.join(tmpBaseDir, e2eTempRootPrefix));
  const sliverRootDir = path.join(testRoot, "sliver");
  const sliverClientDir = path.join(testRoot, "sliver-client");
  const homeDir = path.join(testRoot, "home");
  const xdgConfigHome = path.join(testRoot, "xdg-config");
  const xdgCacheHome = path.join(testRoot, "xdg-cache");
  const xdgDataHome = path.join(testRoot, "xdg-data");
  const tmpDir = path.join(testRoot, "tmp");
  const goCacheDir = path.join(testRoot, "go-cache");
  const goTmpDir = path.join(testRoot, "go-tmp");
  const operatorConfigPath = path.join(testRoot, "operator.cfg");

  const sharedEnv = {
    SLIVER_ROOT_DIR: sliverRootDir,
    SLIVER_CLIENT_DIR: sliverClientDir,
    SLIVER_CLIENT_ROOT_DIR: sliverClientDir,
    HOME: homeDir,
    XDG_CONFIG_HOME: xdgConfigHome,
    XDG_CACHE_HOME: xdgCacheHome,
    XDG_DATA_HOME: xdgDataHome,
    TMPDIR: tmpDir,
    TMP: tmpDir,
    TEMP: tmpDir,
    GOCACHE: goCacheDir,
    GOTMPDIR: goTmpDir,
  };

  await Promise.all(
    [
      sliverRootDir,
      sliverClientDir,
      homeDir,
      xdgConfigHome,
      xdgCacheHome,
      xdgDataHome,
      tmpDir,
      goCacheDir,
      goTmpDir,
    ].map((dirPath) => mkdir(dirPath, { recursive: true })),
  );

  const daemonHost = process.env.SLIVER_E2E_DAEMON_HOST || "127.0.0.1";
  const requestedOperatorHost = process.env.SLIVER_E2E_LHOST || "localhost";
  const operatorHost = isIpLiteral(requestedOperatorHost) ? "localhost" : requestedOperatorHost;
  if (requestedOperatorHost !== operatorHost) {
    log(
      `Using '${operatorHost}' for operator config host because Node TLS SNI rejects IP literals (${requestedOperatorHost})`,
    );
  }

  const lport = process.env.SLIVER_E2E_LPORT
    ? Number.parseInt(process.env.SLIVER_E2E_LPORT, 10)
    : await allocateFreePort(daemonHost);
  if (!Number.isInteger(lport) || lport <= 0 || lport > 65535) {
    throw new Error(`Invalid SLIVER_E2E_LPORT value: ${process.env.SLIVER_E2E_LPORT}`);
  }

  const operatorName = process.env.SLIVER_E2E_OPERATOR || "e2e";

  let daemonProcess;
  let daemonOutputGetter = () => "";
  let runSucceeded = false;
  let cleanupStarted = false;

  const cleanup = async () => {
    if (cleanupStarted) {
      return;
    }
    cleanupStarted = true;
    await stopProcess(daemonProcess, "sliver-server daemon");
    await rm(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };

  const onSignal = async (signal) => {
    log(`Received ${signal}, cleaning up`);
    await cleanup();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    log(`Using isolated test root: ${testRoot}`);
    log(`Using daemon listener: ${daemonHost}:${lport}`);
    log(`Using operator config endpoint: ${operatorHost}:${lport}`);

    await ensureSliverServerBuilt(sharedEnv);

    log("Unpacking Sliver assets");
    await runCommand(sliverServerPath, ["unpack", "--force"], {
      cwd: sliverDir,
      env: sharedEnv,
    });

    log(`Generating operator config for '${operatorName}'`);
    await runCommand(
      sliverServerPath,
      [
        "operator",
        "--name",
        operatorName,
        "--lhost",
        operatorHost,
        "--lport",
        String(lport),
        "--permissions",
        "all",
        "--save",
        operatorConfigPath,
      ],
      {
        cwd: sliverDir,
        env: sharedEnv,
      },
    );

    if (!(await pathExists(operatorConfigPath))) {
      throw new Error(`Expected operator config was not created: ${operatorConfigPath}`);
    }

    log("Starting sliver-server daemon");
    const daemon = startDaemon(
      sliverServerPath,
      [
        "daemon",
        "--lhost",
        daemonHost,
        "--lport",
        String(lport),
      ],
      {
        cwd: sliverDir,
        env: sharedEnv,
      },
    );
    daemonProcess = daemon.child;
    daemonOutputGetter = daemon.getCombinedOutput;

    await waitForDaemonPort(daemonHost, lport, daemonProcess);
    log("Daemon is accepting connections");

    log("Building TypeScript library + e2e tests");
    await runCommand("npm", ["run", "build:examples"], {
      cwd: repoRoot,
      env: sharedEnv,
    });

    const testFiles = await collectE2ETestFiles();
    if (testFiles.length === 0) {
      throw new Error("No compiled e2e tests found in ./e2e/dist");
    }

    const testEnv = {
      ...sharedEnv,
      SLIVER_E2E: "1",
      SLIVER_CONFIG_FILE: operatorConfigPath,
    };
    if (process.env.SLIVER_WAIT_TASKS) {
      testEnv.SLIVER_WAIT_TASKS = process.env.SLIVER_WAIT_TASKS;
    }

    for (const testFile of testFiles) {
      log(`Running e2e test: ${path.relative(repoRoot, testFile)}`);
      await runCommand(process.execPath, [testFile], {
        cwd: repoRoot,
        env: testEnv,
      });
    }

    log("All e2e tests passed");
    runSucceeded = true;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);

    if (!runSucceeded) {
      const daemonLogPath = path.join(sliverRootDir, "logs", "sliver.log");
      if (await pathExists(daemonLogPath)) {
        const logContent = await readFile(daemonLogPath, "utf8");
        const logTail = logContent.split(/\r?\n/).slice(-80).join("\n");
        if (logTail.trim()) {
          console.error("[e2e] sliver.log tail:");
          console.error(logTail);
        }
      } else if (daemonOutputGetter().trim()) {
        console.error("[e2e] daemon output tail:");
        console.error(daemonOutputGetter().split(/\r?\n/).slice(-80).join("\n"));
      }
    }

    await cleanup();
  }
}

main().catch((error) => {
  console.error(`[e2e] ${error?.stack || error}`);
  process.exit(1);
});
