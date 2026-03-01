import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { createHash, randomBytes, randomInt } from "node:crypto";

type SliverScriptModule = typeof import("..");
type SliverClientInstance = InstanceType<SliverScriptModule["SliverClient"]>;
type SessionInfo = Awaited<ReturnType<SliverClientInstance["sessions"]>>[number];
type InteractiveSessionInstance = ReturnType<SliverClientInstance["interactSession"]>;

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

function md5Hex(data: Buffer): string {
  return createHash("md5").update(data).digest("hex");
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
  let interactiveSession: InteractiveSessionInstance | undefined;
  let remoteTransferDir: string | undefined;
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

    interactiveSession = client.interactSession(session.ID);
    const nonce = randomInt(1, 2_000_000_000);
    const ping = await interactiveSession.ping(nonce, 60);
    assert(ping.Nonce === nonce, `Session ping nonce mismatch: expected ${nonce}, got ${ping.Nonce}`);

    const pwd = await interactiveSession.pwd(60);
    assert(pwd.Path.trim().length > 0, "pwd returned an empty path");

    const ls = await interactiveSession.ls(".", 60);
    assert(ls.Exists, `ls reported missing path: ${ls.Path}`);
    assert(ls.Files.length > 0, `ls returned no files for path: ${ls.Path}`);

    const ps = await interactiveSession.ps(false, 60);
    assert(ps.Processes.length > 0, "ps returned no processes");
    const selfProcess = ps.Processes.find((proc) => proc.Pid === implantPid);
    assert(selfProcess !== undefined, `ps output missing implant process pid ${implantPid}`);

    const ifconfig = await interactiveSession.ifconfig(60);
    assert(ifconfig.NetInterfaces.length > 0, "ifconfig returned no network interfaces");

    const lsFromPwd = await interactiveSession.ls(pwd.Path, 60);
    assert(lsFromPwd.Exists, `ls on pwd path reported missing path: ${lsFromPwd.Path}`);

    let netstatEntries: number | undefined;
    try {
      const netstat = await interactiveSession.netstat(15);
      assert(Array.isArray(netstat.Entries), "netstat entries were not returned as an array");
      if (netstat.Entries.length > 0) {
        assert(netstat.Entries[0].Protocol.trim().length > 0, "netstat entry missing protocol");
      }
      netstatEntries = netstat.Entries.length;
    } catch (err) {
      console.warn("netstat check skipped", err);
    }

    console.log("session command checks", {
      pwd: pwd.Path,
      lsPath: ls.Path,
      lsCount: ls.Files.length,
      lsFromPwdPath: lsFromPwd.Path,
      lsFromPwdCount: lsFromPwd.Files.length,
      psCount: ps.Processes.length,
      selfProcess: {
        pid: selfProcess.Pid,
        executable: selfProcess.Executable,
      },
      ifaces: ifconfig.NetInterfaces.map((iface) => iface.Name),
      netstatEntries,
    });

    const transferSourceDir = path.join(tempDir, "transfer-source");
    const transferDownloadedDir = path.join(tempDir, "transfer-downloaded");
    await Promise.all([
      mkdir(transferSourceDir, { recursive: true }),
      mkdir(transferDownloadedDir, { recursive: true }),
    ]);

    remoteTransferDir = path.join(pwd.Path, `.sliver-e2e-transfer-${Date.now()}-${randomInt(10_000, 99_999)}`);
    await interactiveSession.mkdir(remoteTransferDir, 60);

    const transferSpecs = [
      { name: "tiny.bin", size: 127 },
      { name: "small.bin", size: 4099 },
      { name: "medium.bin", size: 131072 },
      { name: "large.bin", size: 1048576 },
    ];

    for (const spec of transferSpecs) {
      const sourcePath = path.join(transferSourceDir, spec.name);
      const downloadedPath = path.join(transferDownloadedDir, spec.name);
      const remotePath = path.join(remoteTransferDir, spec.name);
      const sourceData = randomBytes(spec.size);
      await writeFile(sourcePath, sourceData);

      const sourceFileData = await readFile(sourcePath);
      const sourceMd5 = md5Hex(sourceFileData);
      await interactiveSession.upload(remotePath, sourceFileData, 120);

      const downloadedData = await interactiveSession.download(remotePath, 120);
      const downloadedMd5 = md5Hex(downloadedData);
      assert(
        downloadedMd5 === sourceMd5,
        `md5 mismatch for ${spec.name}: source=${sourceMd5}, downloaded=${downloadedMd5}`,
      );
      assert(
        downloadedData.equals(sourceFileData),
        `byte mismatch for ${spec.name}: sourceLength=${sourceFileData.length}, downloadedLength=${downloadedData.length}`,
      );

      await writeFile(downloadedPath, downloadedData);
      const downloadedFileData = await readFile(downloadedPath);
      const downloadedFileMd5 = md5Hex(downloadedFileData);
      assert(
        downloadedFileMd5 === sourceMd5,
        `saved downloaded file md5 mismatch for ${spec.name}: source=${sourceMd5}, saved=${downloadedFileMd5}`,
      );

      console.log("file transfer verified", {
        file: spec.name,
        size: spec.size,
        md5: sourceMd5,
      });
    }

    const info = await waitForSession(client, 30, (candidate) => candidate.ID === session.ID);
    assert(info.ID === session.ID, "Session info did not return expected session id");
    assert(info.OS.toLowerCase() === goos, `Session info OS mismatch: expected ${goos}, got ${info.OS}`);
    assert(info.Arch.toLowerCase() === goarch, `Session info arch mismatch: expected ${goarch}, got ${info.Arch}`);
    assert(info.Transport.toLowerCase().includes("mtls"), `Expected mtls transport, got ${info.Transport}`);
    assert(info.ActiveC2.toLowerCase().includes("mtls://"), `Expected mtls c2, got ${info.ActiveC2}`);
    assert(info.PID === implantPid, `Session PID mismatch: expected ${implantPid}, got ${info.PID}`);
    printInfoSummary(info);
  } finally {
    if (interactiveSession && remoteTransferDir) {
      try {
        await interactiveSession.rm(remoteTransferDir, true, true, 60);
      } catch (err) {
        console.error(`failed to remove remote transfer dir ${remoteTransferDir}`, err);
      }
    }
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
