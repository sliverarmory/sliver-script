import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { randomInt } from "node:crypto";

type SliverScriptModule = typeof import("..");
type SliverClientInstance = InstanceType<SliverScriptModule["SliverClient"]>;
type SessionInfo = Awaited<ReturnType<SliverClientInstance["sessions"]>>[number];

function findRepoRoot(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return undefined;
}

function guessRepoRoot(): string {
  return findRepoRoot(process.cwd()) ?? findRepoRoot(__dirname) ?? process.cwd();
}

function loadLocalSliverScript(repoRoot: string): SliverScriptModule {
  const libDir = path.join(repoRoot, "lib");
  const entry = path.join(libDir, "index.js");
  if (!fs.existsSync(entry)) {
    throw new Error(`Missing built library entrypoint: ${entry}. Run: npm run build`);
  }

  // CJS build; load via require for compatibility with `tsc --module commonjs`.
  return require(libDir) as SliverScriptModule;
}

const REPO_ROOT = guessRepoRoot();
const CONFIG_PATH = process.env.SLIVER_CONFIG_FILE ?? path.join(REPO_ROOT, "localhost.cfg");
const WAIT_TASKS = process.env.SLIVER_WAIT_TASKS === "1";
const SESSION_TIMEOUT_SECONDS = 180;
const DEFAULT_HTTP_C2_PROFILE = "default";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function nodePlatformToGoOS(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      throw new Error(`Unsupported platform for e2e implant generation: ${platform}`);
  }
}

function nodeArchToGoArch(arch: string): string {
  switch (arch) {
    case "x64":
      return "amd64";
    case "arm64":
      return "arm64";
    case "arm":
      return "arm";
    default:
      throw new Error(`Unsupported arch for e2e implant generation: ${arch}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSession(
  client: SliverClientInstance,
  timeoutSeconds: number,
  predicate: (session: SessionInfo) => boolean,
): Promise<SessionInfo> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const sessions = await client.sessions(30);
    const match = sessions.find(predicate);
    if (match) {
      return match;
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for session (${timeoutSeconds}s)`);
}

function waitForChildExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    child.once("exit", (code) => resolve(code));
  });
}

async function terminateChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  const exited = await Promise.race([
    waitForChildExit(child).then(() => true),
    sleep(4000).then(() => false),
  ]);
  if (!exited && child.exitCode === null) {
    child.kill("SIGKILL");
    await waitForChildExit(child);
  }
}

function collectOutput(child: ChildProcess) {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    if (stdout.length > 20_000) {
      stdout = stdout.slice(-20_000);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    if (stderr.length > 20_000) {
      stderr = stderr.slice(-20_000);
    }
  });
  return {
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function printInfoSummary(session: SessionInfo): void {
  console.log("session info", {
    id: session.ID,
    name: session.Name,
    hostname: session.Hostname,
    username: session.Username,
    os: session.OS,
    arch: session.Arch,
    transport: session.Transport,
    activeC2: session.ActiveC2,
    pid: session.PID,
    remoteAddress: session.RemoteAddress,
  });
}

async function main() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Missing config file: ${CONFIG_PATH}`);
    process.exit(2);
  }

  const sliver = loadLocalSliverScript(REPO_ROOT);
  const config = await sliver.ParseConfigFile(CONFIG_PATH);
  const client = new sliver.SliverClient(config);
  const goos = nodePlatformToGoOS(process.platform);
  const goarch = nodeArchToGoArch(process.arch);
  const mtlsHost = process.env.SLIVER_E2E_MTLS_HOST ?? "localhost";
  const mtlsBindHost = process.env.SLIVER_E2E_MTLS_BIND_HOST ?? "127.0.0.1";
  const mtlsPort = Number.parseInt(process.env.SLIVER_E2E_MTLS_PORT ?? String(config.lport), 10);

  assert(Number.isInteger(mtlsPort) && mtlsPort > 0 && mtlsPort <= 65535, `Invalid mtls port: ${mtlsPort}`);
  const c2URL = `mtls://${mtlsHost}:${mtlsPort}`;
  const existingSessionIds = new Set<string>();

  let tempDir: string | undefined;
  let implantPath: string | undefined;
  let implantProc: ChildProcess | undefined;
  let implantOutput: ReturnType<typeof collectOutput> | undefined;
  let mtlsJobId: number | undefined;

  await client.connect();
  try {
    const version = await client.getVersion();
    console.log("version", `${version.Major}.${version.Minor}.${version.Patch}`, version.Commit);

    const operators = await client.operators();
    console.log("operators", operators.map((o) => o.Name));

    const sessions = await client.sessions();
    console.log("sessions", sessions.length);
    for (const session of sessions) {
      existingSessionIds.add(session.ID);
    }

    const beacons = await client.beacons();
    console.log("beacons", beacons.length);

    const mtlsListener = await client.startMTLSListener(mtlsBindHost, mtlsPort, 60);
    mtlsJobId = mtlsListener.JobID;
    console.log("mtls listener started", {
      bindHost: mtlsBindHost,
      host: mtlsHost,
      port: mtlsPort,
      jobId: mtlsJobId,
    });

    const implantName = `e2e-session-${goos}-${goarch}-${Date.now()}`;
    console.log("generate implant", { implantName, goos, goarch, c2URL });
    const implantConfig = sliver.clientpb.ImplantConfig.create({
      GOOS: goos,
      GOARCH: goarch,
      C2: [{ URL: c2URL }],
      HTTPC2ConfigName: DEFAULT_HTTP_C2_PROFILE,
      Debug: false,
      ObfuscateSymbols: false,
      IsBeacon: false,
      IncludeMTLS: true,
      Format: sliver.clientpb.OutputFormat.EXECUTABLE,
      IsSharedLib: false,
      IsService: false,
      IsShellcode: false,
    });
    const generated = await client.generate(implantConfig, 300);
    assert(generated !== undefined, "Generate returned no file");
    assert(generated.Data.length > 0, "Generated implant file is empty");

    tempDir = await mkdtemp(path.join(os.tmpdir(), "sliver-script-implant-"));
    const generatedName = generated.Name.trim() || implantName;
    const filename = path.basename(generatedName);
    implantPath = path.join(tempDir, filename);
    await writeFile(implantPath, generated.Data, { mode: 0o700 });
    if (process.platform !== "win32") {
      await chmod(implantPath, 0o700);
    }

    const spawnedImplant = spawn(implantPath, [], { stdio: ["ignore", "pipe", "pipe"] });
    implantProc = spawnedImplant;
    implantOutput = collectOutput(spawnedImplant);
    const implantPid = spawnedImplant.pid;
    assert(implantPid !== undefined, "Failed to start implant process");
    console.log("implant started", { path: implantPath, pid: implantPid });

    const session = await waitForSession(
      client,
      SESSION_TIMEOUT_SECONDS,
      (candidate) =>
        !existingSessionIds.has(candidate.ID) &&
        candidate.OS.toLowerCase() === goos &&
        candidate.Arch.toLowerCase() === goarch,
    );
    console.log("session created", { id: session.ID, pid: session.PID, transport: session.Transport });

    const interactiveSession = client.interactSession(session.ID);
    const nonce = randomInt(1, 2_000_000_000);
    const ping = await interactiveSession.ping(nonce, 60);
    assert(ping.Nonce === nonce, `Session ping nonce mismatch: expected ${nonce}, got ${ping.Nonce}`);

    const info = await waitForSession(client, 30, (candidate) => candidate.ID === session.ID);
    assert(info.ID === session.ID, "Session info did not return expected session id");
    assert(info.OS.toLowerCase() === goos, `Session info OS mismatch: expected ${goos}, got ${info.OS}`);
    assert(info.Arch.toLowerCase() === goarch, `Session info arch mismatch: expected ${goarch}, got ${info.Arch}`);
    assert(info.Transport.toLowerCase().includes("mtls"), `Expected mtls transport, got ${info.Transport}`);
    assert(info.ActiveC2.toLowerCase().includes("mtls://"), `Expected mtls c2, got ${info.ActiveC2}`);
    assert(info.PID === implantPid, `Session PID mismatch: expected ${implantPid}, got ${info.PID}`);
    printInfoSummary(info);

    if (beacons.length > 0) {
      const beacon = client.interactBeacon(beacons[0].ID);
      const task = await beacon.lsTask(".");
      console.log("beacon ls queued", task.id);

      if (WAIT_TASKS) {
        try {
          const ls = await task.wait(60);
          console.log("beacon ls result", { path: ls.Path, count: ls.Files.length });
        } catch (err) {
          console.error("beacon ls wait failed", err);
        }
      }
    }
  } finally {
    if (mtlsJobId !== undefined) {
      try {
        await client.killJob(mtlsJobId, 30);
      } catch (err) {
        console.error(`failed to stop mtls listener job ${mtlsJobId}`, err);
      }
    }
    if (implantProc) {
      await terminateChildProcess(implantProc);
      if (implantOutput) {
        const stdout = implantOutput.stdout().trim();
        const stderr = implantOutput.stderr().trim();
        if (stdout.length > 0) {
          console.log("implant stdout tail", stdout.split(/\r?\n/).slice(-10).join("\n"));
        }
        if (stderr.length > 0) {
          console.log("implant stderr tail", stderr.split(/\r?\n/).slice(-10).join("\n"));
        }
      }
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    await client.disconnect();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
