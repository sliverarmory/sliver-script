import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { gunzip as gunzipCb } from "node:zlib";
import { promisify } from "node:util";

type SliverScriptModule = typeof import("..");
type SliverClientInstance = InstanceType<SliverScriptModule["SliverClient"]>;
type BeaconInfo = Awaited<ReturnType<SliverClientInstance["beacons"]>>[number];
type InteractiveBeaconInstance = ReturnType<SliverClientInstance["interactBeacon"]>;

type BeaconTransportName = "mtls" | "http" | "wg";

interface BeaconTransportSpec {
  name: BeaconTransportName;
  c2URL: string;
  expectedTransportToken: string;
  expectedActiveC2Token: string;
  bindHost: string;
  host: string;
  port: number;
  wgNPort?: number;
  wgKeyPort?: number;
}

const gunzip = promisify(gunzipCb);

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
  return require(libDir) as SliverScriptModule;
}

const REPO_ROOT = guessRepoRoot();
const CONFIG_PATH = process.env.SLIVER_CONFIG_FILE ?? path.join(REPO_ROOT, "localhost.cfg");
const DEFAULT_HTTP_C2_PROFILE = "default";
const BEACON_INTERVAL_SECONDS = 20;
const BEACON_INTERVAL_NS = String(BEACON_INTERVAL_SECONDS * 1_000_000_000);
const BEACON_TIMEOUT_SECONDS = 300;
const BEACON_TASK_POLL_RPC_TIMEOUT_SECONDS = 20;
const BEACON_TASK_CONTENT_RPC_TIMEOUT_SECONDS = 45;
const BEACON_DOWNLOAD_RPC_TIMEOUT_SECONDS = 45;
const BEACON_PER_TRANSPORT_OVERALL_TIMEOUT_SECONDS = 25 * 60;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function parsePort(rawValue: string, name: string): number {
  const parsed = Number.parseInt(rawValue, 10);
  assert(Number.isInteger(parsed) && parsed > 0 && parsed <= 65535, `Invalid ${name}: ${rawValue}`);
  return parsed;
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

async function withRpcTimeout<T>(
  timeoutSeconds: number,
  label: string,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    return await action(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`${label} timed out after ${timeoutSeconds}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForBeacon(
  client: SliverClientInstance,
  timeoutSeconds: number,
  predicate: (beacon: BeaconInfo) => boolean,
): Promise<BeaconInfo> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const beacons = await client.beacons(30);
    const match = beacons.find(predicate);
    if (match) {
      return match;
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for beacon (${timeoutSeconds}s)`);
}

async function waitForBeaconTaskComplete(
  client: SliverClientInstance,
  beaconID: string,
  taskID: string,
  timeoutSeconds: number,
): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    let tasks;
    try {
      tasks = await withRpcTimeout(
        BEACON_TASK_POLL_RPC_TIMEOUT_SECONDS,
        `getBeaconTasks(${beaconID})`,
        (signal) => client.rpc.getBeaconTasks({ ID: beaconID }, { signal }),
      );
    } catch (err) {
      if (Date.now() >= deadline) {
        throw err;
      }
      await sleep(1000);
      continue;
    }
    const task = tasks.Tasks.find((candidate) => candidate.ID === taskID);
    if (!task) {
      await sleep(1000);
      continue;
    }

    const state = task.State.toLowerCase();
    if (state === "completed") {
      return;
    }
    if (state === "failed" || state === "canceled" || state === "cancelled") {
      throw new Error(`Beacon task ${taskID} ${state}: ${task.Description}`);
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for beacon task completion (${timeoutSeconds}s): ${taskID}`);
}

function getQueuedTaskID(queued: { Response?: { Err?: string; TaskID?: string } }, label: string): string {
  const queueErr = queued.Response?.Err?.trim();
  assert(!queueErr, `${label} queue error: ${queueErr}`);
  const taskID = queued.Response?.TaskID?.trim() ?? "";
  assert(taskID.length > 0, `${label} queue response missing task id`);
  return taskID;
}

async function decodeBeaconTaskResponse<T extends { Response?: { Err: string } }>(
  client: SliverClientInstance,
  beaconID: string,
  queued: { Response?: { Err?: string; TaskID?: string } },
  decoder: (input: Uint8Array) => T,
  label: string,
  timeoutSeconds: number,
): Promise<T> {
  const taskID = getQueuedTaskID(queued, label);
  await waitForBeaconTaskComplete(client, beaconID, taskID, timeoutSeconds);
  const content = await withRpcTimeout(
    BEACON_TASK_CONTENT_RPC_TIMEOUT_SECONDS,
    `getBeaconTaskContent(${taskID})`,
    (signal) => client.rpc.getBeaconTaskContent({ ID: taskID }, { signal }),
  );
  assert(content.Response.length > 0, `${label} task returned no response bytes`);
  const decoded = decoder(content.Response);
  const err = decoded.Response?.Err?.trim();
  assert(!err, `${label} execution error: ${err}`);
  return decoded;
}

async function decodeDownloadData(download: { Encoder: string; Data: Buffer }): Promise<Buffer> {
  if (download.Encoder === "gzip") {
    return await gunzip(download.Data);
  }
  if (download.Encoder === "") {
    return download.Data;
  }
  throw new Error(`Unsupported download encoder: ${download.Encoder}`);
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

function md5Hex(data: Buffer): string {
  return createHash("md5").update(data).digest("hex");
}

function printBeaconInfoSummary(beacon: BeaconInfo): void {
  console.log("beacon info", {
    id: beacon.ID,
    name: beacon.Name,
    hostname: beacon.Hostname,
    username: beacon.Username,
    os: beacon.OS,
    arch: beacon.Arch,
    transport: beacon.Transport,
    activeC2: beacon.ActiveC2,
    pid: beacon.PID,
    remoteAddress: beacon.RemoteAddress,
    interval: beacon.Interval,
    nextCheckin: beacon.NextCheckin,
  });
}

function createBeaconImplantConfig(
  sliver: SliverScriptModule,
  goos: string,
  goarch: string,
  transport: BeaconTransportSpec,
) {
  return sliver.clientpb.ImplantConfig.create({
    GOOS: goos,
    GOARCH: goarch,
    C2: [{ URL: transport.c2URL }],
    HTTPC2ConfigName: DEFAULT_HTTP_C2_PROFILE,
    Debug: false,
    ObfuscateSymbols: false,
    IsBeacon: true,
    BeaconInterval: BEACON_INTERVAL_NS,
    BeaconJitter: "0",
    IncludeMTLS: transport.name === "mtls",
    IncludeHTTP: transport.name === "http",
    IncludeWG: transport.name === "wg",
    WGKeyExchangePort: transport.wgKeyPort ?? 0,
    WGTcpCommsPort: transport.wgNPort ?? 0,
    Format: sliver.clientpb.OutputFormat.EXECUTABLE,
    IsSharedLib: false,
    IsService: false,
    IsShellcode: false,
  });
}

async function startBeaconTransportListener(
  client: SliverClientInstance,
  transport: BeaconTransportSpec,
): Promise<number> {
  if (transport.name === "mtls") {
    const listener = await client.startMTLSListener(transport.bindHost, transport.port, 60);
    return listener.JobID;
  }

  if (transport.name === "http") {
    const listener = await client.startHTTPListener(transport.host, transport.bindHost, transport.port, "", false, 60);
    return listener.JobID;
  }

  assert(transport.wgNPort !== undefined, "wg nport is required");
  assert(transport.wgKeyPort !== undefined, "wg keyport is required");
  const listener = await client.startWGListener(
    transport.bindHost,
    transport.port,
    "100.64.0.1",
    transport.wgNPort,
    transport.wgKeyPort,
    60,
  );
  return listener.JobID;
}

async function runBeaconTransportChecks(
  sliver: SliverScriptModule,
  client: SliverClientInstance,
  transport: BeaconTransportSpec,
  goos: string,
  goarch: string,
  existingBeaconIDs: Set<string>,
): Promise<void> {
  let tempDir: string | undefined;
  let implantPath: string | undefined;
  let implantProc: ChildProcess | undefined;
  let implantOutput: ReturnType<typeof collectOutput> | undefined;
  let interactiveBeacon: InteractiveBeaconInstance | undefined;
  let remoteTransferDir: string | undefined;
  let beaconID: string | undefined;
  let listenerJobId: number | undefined;

  try {
    listenerJobId = await startBeaconTransportListener(client, transport);
    console.log("listener started", {
      transport: transport.name,
      bindHost: transport.bindHost,
      host: transport.host,
      port: transport.port,
      jobId: listenerJobId,
      wgNPort: transport.wgNPort,
      wgKeyPort: transport.wgKeyPort,
    });

    const implantName = `e2e-beacon-${transport.name}-${goos}-${goarch}-${Date.now()}`;
    console.log("generate beacon", {
      transport: transport.name,
      implantName,
      goos,
      goarch,
      c2URL: transport.c2URL,
      beaconIntervalSeconds: BEACON_INTERVAL_SECONDS,
    });

    const generated = await client.generate(createBeaconImplantConfig(sliver, goos, goarch, transport), 300);
    assert(generated !== undefined, "Generate returned no file");
    assert(generated.Data.length > 0, "Generated beacon file is empty");

    tempDir = await mkdtemp(path.join(os.tmpdir(), `sliver-script-beacon-${transport.name}-`));
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
    assert(implantPid !== undefined, "Failed to start beacon process");
    console.log("beacon implant started", { transport: transport.name, path: implantPath, pid: implantPid });

    const beacon = await waitForBeacon(
      client,
      BEACON_TIMEOUT_SECONDS,
      (candidate) =>
        !existingBeaconIDs.has(candidate.ID) &&
        candidate.OS.toLowerCase() === goos &&
        candidate.Arch.toLowerCase() === goarch &&
        candidate.Transport.toLowerCase().includes(transport.expectedTransportToken),
    );
    beaconID = beacon.ID;
    existingBeaconIDs.add(beacon.ID);
    interactiveBeacon = client.interactBeacon(beacon.ID);
    console.log("beacon created", {
      transport: transport.name,
      id: beacon.ID,
      pid: beacon.PID,
      beaconTransport: beacon.Transport,
      activeC2: beacon.ActiveC2,
    });

    const nonce = randomInt(1, 2_000_000_000);
    const pingQueued = await interactiveBeacon.ping(nonce, 120);
    const ping = await decodeBeaconTaskResponse(
      client,
      beacon.ID,
      pingQueued,
      sliver.sliverpb.Ping.decode,
      `beacon ping (${transport.name})`,
      180,
    );
    assert(ping.Nonce === nonce, `Beacon ping nonce mismatch: expected ${nonce}, got ${ping.Nonce}`);

    const executeNoEnvToken = `BEACON_EXEC_NOENV_${transport.name}_${Date.now()}_${randomInt(10_000, 99_999)}`;
    const executeNoEnvQueued = await interactiveBeacon.execute(
      "/bin/sh",
      ["-c", `printf '%s' '${executeNoEnvToken}'`],
      true,
      120,
    );
    const executeNoEnv = await decodeBeaconTaskResponse(
      client,
      beacon.ID,
      executeNoEnvQueued,
      sliver.sliverpb.Execute.decode,
      `beacon execute (no env, ${transport.name})`,
      180,
    );
    assert(executeNoEnv.Status === 0, `beacon execute(no env) non-zero status: ${executeNoEnv.Status}`);
    const executeNoEnvStdout = executeNoEnv.Stdout.toString("utf8");
    assert(
      executeNoEnvStdout === executeNoEnvToken,
      `beacon execute(no env) stdout mismatch: expected '${executeNoEnvToken}', got '${executeNoEnvStdout}'`,
    );

    const executeEnvValue = `BEACON_EXEC_ENV_${transport.name}_${Date.now()}_${randomInt(10_000, 99_999)}`;
    const executeWithEnvQueued = await withRpcTimeout(
      BEACON_DOWNLOAD_RPC_TIMEOUT_SECONDS,
      `beacon execute queue (with env, ${transport.name})`,
      (signal) =>
        client.rpc.execute(
          {
            Path: "/bin/sh",
            Args: ["-c", 'printf "%s" "$BEACON_E2E_EXEC_ENV"'],
            Output: true,
            EnvInheritance: false,
            Env: {
              BEACON_E2E_EXEC_ENV: executeEnvValue,
            },
            Request: {
              Async: true,
              Timeout: "180",
              BeaconID: beacon.ID,
              SessionID: "",
            },
          },
          { signal },
        ),
    );
    const executeWithEnv = await decodeBeaconTaskResponse(
      client,
      beacon.ID,
      executeWithEnvQueued,
      sliver.sliverpb.Execute.decode,
      `beacon execute (with env, ${transport.name})`,
      180,
    );
    assert(executeWithEnv.Status === 0, `beacon execute(with env) non-zero status: ${executeWithEnv.Status}`);
    const executeWithEnvStdout = executeWithEnv.Stdout.toString("utf8");
    assert(
      executeWithEnvStdout === executeEnvValue,
      `beacon execute(with env) stdout mismatch: expected '${executeEnvValue}', got '${executeWithEnvStdout}'`,
    );
    console.log("beacon execute rpc checks", {
      transport: transport.name,
      noEnvToken: executeNoEnvStdout,
      envToken: executeWithEnvStdout,
    });

    const pwdQueued = await interactiveBeacon.pwd(120);
    const pwd = await decodeBeaconTaskResponse(
      client,
      beacon.ID,
      pwdQueued,
      sliver.sliverpb.Pwd.decode,
      `beacon pwd (${transport.name})`,
      180,
    );
    assert(pwd.Path.trim().length > 0, "beacon pwd returned an empty path");

    const ls = await interactiveBeacon.ls(".", 180);
    assert(ls.Exists, `beacon ls reported missing path: ${ls.Path}`);
    assert(ls.Files.length > 0, `beacon ls returned no files for path: ${ls.Path}`);

    const psQueued = await interactiveBeacon.ps(false, 120);
    const ps = await decodeBeaconTaskResponse(
      client,
      beacon.ID,
      psQueued,
      sliver.sliverpb.Ps.decode,
      `beacon ps (${transport.name})`,
      180,
    );
    assert(ps.Processes.length > 0, "beacon ps returned no processes");
    const selfProcess = ps.Processes.find((proc) => proc.Pid === implantPid);
    assert(selfProcess !== undefined, `beacon ps output missing implant process pid ${implantPid}`);

    const ifconfigQueued = await interactiveBeacon.ifconfig(120);
    const ifconfig = await decodeBeaconTaskResponse(
      client,
      beacon.ID,
      ifconfigQueued,
      sliver.sliverpb.Ifconfig.decode,
      `beacon ifconfig (${transport.name})`,
      180,
    );
    assert(ifconfig.NetInterfaces.length > 0, "beacon ifconfig returned no interfaces");

    const lsFromPwd = await interactiveBeacon.ls(pwd.Path, 180);
    assert(lsFromPwd.Exists, `beacon ls on pwd path reported missing path: ${lsFromPwd.Path}`);

    let netstatEntries: number | undefined;
    try {
      const netstatQueued = await interactiveBeacon.netstat(30);
      const netstat = await decodeBeaconTaskResponse(
        client,
        beacon.ID,
        netstatQueued,
        sliver.sliverpb.Netstat.decode,
        `beacon netstat (${transport.name})`,
        60,
      );
      assert(Array.isArray(netstat.Entries), "beacon netstat entries were not returned as an array");
      if (netstat.Entries.length > 0) {
        assert(netstat.Entries[0].Protocol.trim().length > 0, "beacon netstat entry missing protocol");
      }
      netstatEntries = netstat.Entries.length;
    } catch (err) {
      console.warn("beacon netstat check skipped", err);
    }

    console.log("beacon command checks", {
      transport: transport.name,
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

    remoteTransferDir = path.join(
      pwd.Path,
      `.sliver-e2e-beacon-${transport.name}-transfer-${Date.now()}-${randomInt(10_000, 99_999)}`,
    );
    const mkdirQueued = await interactiveBeacon.mkdir(remoteTransferDir, 120);
    await decodeBeaconTaskResponse(
      client,
      beacon.ID,
      mkdirQueued,
      sliver.sliverpb.Mkdir.decode,
      `beacon mkdir transfer dir (${transport.name})`,
      180,
    );

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

      const uploadQueued = await interactiveBeacon.upload(remotePath, sourceFileData, 180);
      await decodeBeaconTaskResponse(
        client,
        beacon.ID,
        uploadQueued,
        sliver.sliverpb.Upload.decode,
        `beacon upload ${spec.name} (${transport.name})`,
        240,
      );

      const downloadQueued = await withRpcTimeout(
        BEACON_DOWNLOAD_RPC_TIMEOUT_SECONDS,
        `download queue ${spec.name} (${transport.name})`,
        (signal) =>
          client.rpc.download(
            {
              Path: remotePath,
              Request: {
                Async: true,
                Timeout: "180",
                BeaconID: beacon.ID,
                SessionID: "",
              },
            },
            { signal },
          ),
      );
      const download = await decodeBeaconTaskResponse(
        client,
        beacon.ID,
        downloadQueued,
        sliver.sliverpb.Download.decode,
        `beacon download ${spec.name} (${transport.name})`,
        240,
      );
      const downloadedData = await decodeDownloadData(download);
      const downloadedMd5 = md5Hex(downloadedData);
      assert(
        downloadedMd5 === sourceMd5,
        `beacon md5 mismatch for ${spec.name}: source=${sourceMd5}, downloaded=${downloadedMd5}`,
      );
      assert(
        downloadedData.equals(sourceFileData),
        `beacon byte mismatch for ${spec.name}: sourceLength=${sourceFileData.length}, downloadedLength=${downloadedData.length}`,
      );

      await writeFile(downloadedPath, downloadedData);
      const downloadedFileData = await readFile(downloadedPath);
      const downloadedFileMd5 = md5Hex(downloadedFileData);
      assert(
        downloadedFileMd5 === sourceMd5,
        `beacon saved downloaded file md5 mismatch for ${spec.name}: source=${sourceMd5}, saved=${downloadedFileMd5}`,
      );

      console.log("beacon file transfer verified", {
        transport: transport.name,
        file: spec.name,
        size: spec.size,
        md5: sourceMd5,
      });
    }

    const info = await waitForBeacon(client, 60, (candidate) => candidate.ID === beacon.ID);
    assert(info.ID === beacon.ID, "Beacon info did not return expected beacon id");
    assert(info.OS.toLowerCase() === goos, `Beacon info OS mismatch: expected ${goos}, got ${info.OS}`);
    assert(info.Arch.toLowerCase() === goarch, `Beacon info arch mismatch: expected ${goarch}, got ${info.Arch}`);
    assert(
      info.Transport.toLowerCase().includes(transport.expectedTransportToken),
      `Expected beacon ${transport.name} transport, got ${info.Transport}`,
    );
    assert(
      info.ActiveC2.toLowerCase().includes(transport.expectedActiveC2Token),
      `Expected beacon ${transport.expectedActiveC2Token} c2, got ${info.ActiveC2}`,
    );
    assert(info.PID === implantPid, `Beacon PID mismatch: expected ${implantPid}, got ${info.PID}`);
    printBeaconInfoSummary(info);
  } finally {
    if (interactiveBeacon && remoteTransferDir && beaconID) {
      try {
        const rmQueued = await interactiveBeacon.rm(remoteTransferDir, true, true, 120);
        await decodeBeaconTaskResponse(
          client,
          beaconID,
          rmQueued,
          sliver.sliverpb.Rm.decode,
          `beacon rm transfer dir (${transport.name})`,
          180,
        );
      } catch (err) {
        console.error(`failed to remove beacon remote transfer dir ${remoteTransferDir}`, err);
      }
    }
    if (listenerJobId !== undefined) {
      try {
        await client.killJob(listenerJobId, 30);
      } catch (err) {
        console.error(`failed to stop listener job ${listenerJobId}`, err);
      }
    }
    if (implantProc) {
      await terminateChildProcess(implantProc);
      if (implantOutput) {
        const stdout = implantOutput.stdout().trim();
        const stderr = implantOutput.stderr().trim();
        if (stdout.length > 0) {
          console.log("beacon implant stdout tail", stdout.split(/\r?\n/).slice(-10).join("\n"));
        }
        if (stderr.length > 0) {
          console.log("beacon implant stderr tail", stderr.split(/\r?\n/).slice(-10).join("\n"));
        }
      }
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
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
  const mtlsPort = parsePort(process.env.SLIVER_E2E_MTLS_PORT ?? String(config.lport), "SLIVER_E2E_MTLS_PORT");

  const httpHost = process.env.SLIVER_E2E_HTTP_HOST ?? "localhost";
  const httpBindHost = process.env.SLIVER_E2E_HTTP_BIND_HOST ?? "127.0.0.1";
  const httpPort = parsePort(process.env.SLIVER_E2E_HTTP_PORT ?? String(mtlsPort + 1), "SLIVER_E2E_HTTP_PORT");

  const wgHost = process.env.SLIVER_E2E_WG_HOST ?? "localhost";
  const wgBindHost = process.env.SLIVER_E2E_WG_BIND_HOST ?? "127.0.0.1";
  const wgPort = parsePort(process.env.SLIVER_E2E_WG_PORT ?? String(httpPort + 1), "SLIVER_E2E_WG_PORT");
  const wgNPort = parsePort(process.env.SLIVER_E2E_WG_NPORT ?? String(wgPort + 1), "SLIVER_E2E_WG_NPORT");
  const wgKeyPort = parsePort(process.env.SLIVER_E2E_WG_KEYPORT ?? String(wgPort + 2), "SLIVER_E2E_WG_KEYPORT");

  const uniquePorts = new Set<number>([mtlsPort, httpPort, wgPort, wgNPort, wgKeyPort]);
  assert(uniquePorts.size === 5, "Transport listener ports must be unique");

  const transportSpecs: BeaconTransportSpec[] = [
    {
      name: "mtls",
      c2URL: `mtls://${mtlsHost}:${mtlsPort}`,
      expectedTransportToken: "mtls",
      expectedActiveC2Token: "mtls://",
      bindHost: mtlsBindHost,
      host: mtlsHost,
      port: mtlsPort,
    },
    {
      name: "http",
      c2URL: `http://${httpHost}:${httpPort}`,
      expectedTransportToken: "http",
      expectedActiveC2Token: "http://",
      bindHost: httpBindHost,
      host: httpHost,
      port: httpPort,
    },
    {
      name: "wg",
      c2URL: `wg://${wgHost}:${wgPort}`,
      expectedTransportToken: "wg",
      expectedActiveC2Token: "wg://",
      bindHost: wgBindHost,
      host: wgHost,
      port: wgPort,
      wgNPort,
      wgKeyPort,
    },
  ];

  const overallTimeoutSeconds =
    BEACON_PER_TRANSPORT_OVERALL_TIMEOUT_SECONDS * transportSpecs.length + 5 * 60;
  const overallTimer = setTimeout(() => {
    console.error(`Beacon e2e exceeded ${overallTimeoutSeconds}s overall timeout`);
    process.exit(1);
  }, overallTimeoutSeconds * 1000);

  const existingBeaconIDs = new Set<string>();

  await client.connect();
  try {
    const version = await client.getVersion();
    console.log("version", `${version.Major}.${version.Minor}.${version.Patch}`, version.Commit);

    const operators = await client.operators();
    console.log("operators", operators.map((o) => o.Name));

    const sessions = await client.sessions();
    console.log("sessions", sessions.length);

    const beacons = await client.beacons();
    console.log("beacons", beacons.length);
    for (const beacon of beacons) {
      existingBeaconIDs.add(beacon.ID);
    }

    for (const transport of transportSpecs) {
      await runBeaconTransportChecks(sliver, client, transport, goos, goarch, existingBeaconIDs);
    }
  } finally {
    clearTimeout(overallTimer);
    await client.disconnect();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
