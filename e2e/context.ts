import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { Subscription } from "rxjs";

import type {
  SliverClient as SliverClientInstance,
  SliverClientConfig,
  SliverEventStreamState,
  clientpb,
  commonpb,
} from "../lib";

import { loadE2EEnvironment, type E2EEnvironment } from "./support";

// This file is emitted to e2e/dist/context.js. Load the package built at the
// repository root while retaining compile-time checks against its declarations.
const sliverScript = require("../../lib") as typeof import("../lib");

const commandTimeoutSeconds = 120;
const callbackTimeoutMilliseconds = 5 * 60_000;
const processOutputLimit = 512_000;
const taskkillTimeoutMilliseconds = 5_000;

export interface ListenerState {
  readonly jobId: number;
  readonly port: number;
  readonly c2Url: string;
}

export type ImplantMode = "session" | "beacon";

export interface LiveImplant {
  readonly mode: ImplantMode;
  readonly name: string;
  readonly buildName: string;
  readonly buildId: string;
  readonly filePath: string;
  readonly root: string;
  readonly child: ChildProcess;
  readonly pid: number;
  stdout: string;
  stderr: string;
  session?: clientpb.Session;
  beacon?: clientpb.Beacon;
}

interface BeaconQueuedResponse {
  readonly Response?: commonpb.Response;
}

export interface CompletedBeaconTask<TQueued, TResponse> {
  readonly queued: TQueued;
  readonly task: clientpb.BeaconTask;
  readonly response: TResponse;
}

interface EventWaiter {
  readonly cursor: number;
  readonly predicate: (event: clientpb.Event) => boolean;
  readonly resolve: (event: clientpb.Event) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly signal?: AbortSignal;
  readonly abort?: () => void;
}

export class E2ESuiteContext {
  readonly buildNames = new Set<string>();
  readonly profileNames = new Set<string>();
  readonly extraSessionIds = new Set<string>();

  listener?: ListenerState;
  session?: LiveImplant;
  beacon?: LiveImplant;

  private readonly events: clientpb.Event[] = [];
  private readonly eventWaiters = new Set<EventWaiter>();
  private readonly subscriptions: Subscription[] = [];
  private latestEventState: SliverEventStreamState = { status: "stopped", attempt: 0 };
  private targetSequence = 0;
  private disposed = false;

  constructor(
    readonly client: SliverClientInstance,
    readonly config: SliverClientConfig,
    readonly environment: E2EEnvironment,
    readonly workDir: string,
    readonly resultsDir: string,
  ) {
    this.subscriptions.push(
      client.event$.subscribe((event) => this.recordEvent(event)),
      client.eventStreamState$.subscribe((state) => {
        this.latestEventState = state;
      }),
    );
  }

  eventCursor(): number {
    return this.events.length;
  }

  waitForEvent(
    cursor: number,
    predicate: (event: clientpb.Event) => boolean,
    timeoutMilliseconds: number,
    label: string,
  ): Promise<clientpb.Event> {
    return this.waitForEventInternal(cursor, predicate, timeoutMilliseconds, label);
  }

  allocateLoopbackPort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string" || address.port < 1 || address.port >= 65_535) {
          server.close();
          reject(new Error("Could not allocate a valid loopback TCP port"));
          return;
        }
        server.close((error) => error ? reject(error) : resolve(address.port));
      });
    });
  }

  async createTargetRoot(mode: ImplantMode): Promise<string> {
    this.targetSequence += 1;
    const root = path.join(this.workDir, `${mode}-${this.targetSequence}`);
    const knownNested = path.join(root, "known", "nested");
    await Promise.all([
      mkdir(knownNested, { recursive: true }),
      mkdir(path.join(root, "home"), { recursive: true }),
      mkdir(path.join(root, "tmp"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(root, "known", "seed.txt"), "alpha\nbeta\ngamma\n", { mode: 0o600 }),
      writeFile(path.join(knownNested, "child.txt"), "child-marker\n", { mode: 0o600 }),
      writeFile(path.join(knownNested, "another.log"), "log-marker\n", { mode: 0o600 }),
      writeFile(path.join(root, "outside-test-sentinel.txt"), "must-survive\n", { mode: 0o600 }),
    ]);
    return root;
  }

  async launchGeneratedImplant(
    mode: ImplantMode,
    generated: clientpb.Generate,
  ): Promise<LiveImplant> {
    assert.ok(this.listener, "mTLS listener must be running before an implant is launched");
    assert.ok(generated.File, `${mode} generation must return a file`);
    assert.ok(generated.File.Name.trim(), `${mode} generation file name`);
    assert.ok(generated.File.Data.length > 0, `${mode} generation file contents`);
    assert.ok(generated.ImplantName.trim(), `${mode} generated implant name`);
    assert.ok(generated.ImplantBuildID.trim(), `${mode} generated build ID`);

    const root = await this.createTargetRoot(mode);
    const fileName = path.basename(generated.File.Name);
    assert.notEqual(fileName, ".", `${mode} generated file basename`);
    assert.notEqual(fileName, "..", `${mode} generated file basename`);
    const filePath = path.join(root, fileName);
    try {
      await writeFile(filePath, generated.File.Data, { mode: 0o700 });
      if (process.platform !== "win32") await chmod(filePath, 0o700);
    } finally {
      generated.File.Data.fill(0);
    }

    this.buildNames.add(generated.ImplantName);
    const cursor = this.eventCursor();
    const child = spawn(filePath, [], {
      cwd: root,
      env: isolatedImplantEnvironment(root),
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    await waitForSpawn(child, mode);
    assert.ok(child.pid, `${mode} process must have a PID`);

    const implant: LiveImplant = {
      mode,
      name: generated.ImplantName,
      buildName: generated.ImplantName,
      buildId: generated.ImplantBuildID,
      filePath,
      root,
      child,
      pid: child.pid,
      stdout: "",
      stderr: "",
    };
    if (mode === "session") this.session = implant;
    else this.beacon = implant;

    child.stdout?.on("data", (chunk: Buffer) => {
      implant.stdout = appendBounded(implant.stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      implant.stderr = appendBounded(implant.stderr, chunk);
    });
    child.on("error", (error) => {
      implant.stderr = appendBounded(implant.stderr, Buffer.from(`\nprocess error: ${error.message}\n`));
    });

    const abort = new AbortController();
    const eventPromise = this.waitForEventInternal(
      cursor,
      (event) => {
        if (event.EventType === "job-stopped" && event.Job?.ID === this.listener?.jobId) return true;
        if (mode === "session") {
          return event.EventType === "session-connected"
            && event.Session?.Name === implant.name
            && event.Session.PID === implant.pid;
        }
        if (event.EventType !== SliverClientInstanceConstants.EVENT_BEACON_REGISTERED) return false;
        try {
          const beacon = sliverScript.clientpb.Beacon.decode(event.Data);
          return beacon.Name === implant.name && beacon.PID === implant.pid;
        } catch {
          return false;
        }
      },
      callbackTimeoutMilliseconds,
      `${mode} callback`,
      abort.signal,
    );

    let exitHandler: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    let errorHandler: ((error: Error) => void) | undefined;
    const earlyExit = new Promise<never>((_resolve, reject) => {
      exitHandler = (code, signal) => reject(new Error(
        `${mode} process ${implant.pid} exited before callback (${code ?? signal ?? "unknown"})`,
      ));
      errorHandler = reject;
      child.once("exit", exitHandler);
      child.once("error", errorHandler);
    });

    try {
      const event = await Promise.race([eventPromise, earlyExit]);
      if (event.EventType === "job-stopped") {
        throw new Error(`mTLS listener job ${this.listener.jobId} stopped before ${mode} callback: ${event.Err}`);
      }
      if (mode === "session") {
        assert.ok(event.Session, "session callback event payload");
        validateConnectedTarget(event.Session, implant, this.environment);
        implant.session = event.Session;
        const sessions = await this.client.getSessions(30);
        assert.ok(
          sessions.Sessions.some((session) => session.ID === event.Session?.ID && session.PID === implant.pid),
          "session inventory must contain the callback target",
        );
      } else {
        const beacon = sliverScript.clientpb.Beacon.decode(event.Data);
        validateConnectedTarget(beacon, implant, this.environment);
        assert.equal(beacon.Interval, "10000000000", "beacon callback interval");
        assert.equal(beacon.Jitter, "0", "beacon callback jitter");
        implant.beacon = beacon;
        const beacons = await this.client.getBeacons(30);
        assert.ok(
          beacons.Beacons.some((candidate) => candidate.ID === beacon.ID && candidate.PID === implant.pid),
          "beacon inventory must contain the registered target",
        );
      }
      return implant;
    } finally {
      abort.abort();
      if (exitHandler) child.off("exit", exitHandler);
      if (errorHandler) child.off("error", errorHandler);
    }
  }

  async stopImplant(implant: LiveImplant): Promise<void> {
    if (implant.child.exitCode !== null || implant.child.signalCode !== null) return;
    if (process.platform === "win32") {
      await taskkill(implant.pid, false).catch(() => undefined);
    } else {
      implant.child.kill("SIGTERM");
    }
    if (await waitForExit(implant.child, 2_000)) return;
    if (process.platform === "win32") {
      await taskkill(implant.pid, true).catch(() => implant.child.kill());
    } else {
      implant.child.kill("SIGKILL");
    }
    if (!await waitForExit(implant.child, 10_000)) {
      throw new Error(`${implant.mode} process ${implant.pid} did not exit after forced termination`);
    }
  }

  async runBeaconTask<TQueued extends BeaconQueuedResponse, TResponse>(
    beaconId: string,
    invoke: () => Promise<TQueued>,
    decode: (data: Buffer) => TResponse,
    label: string,
    timeoutMilliseconds = 2 * 60_000,
  ): Promise<CompletedBeaconTask<TQueued, TResponse>> {
    const cursor = this.eventCursor();
    const queued = await invoke();
    const metadata = queued.Response;
    assert.ok(metadata, `${label} queued response metadata`);
    assert.equal(metadata.Err, "", `${label} queue error`);
    assert.equal(metadata.Async, true, `${label} must queue asynchronously`);
    assert.equal(metadata.BeaconID, beaconId, `${label} queued beacon ID`);
    assert.ok(metadata.TaskID, `${label} queued task ID`);

    await this.waitForEvent(
      cursor,
      (event) => {
        if (event.EventType !== SliverClientInstanceConstants.EVENT_BEACON_TASKRESULT) return false;
        try {
          const task = sliverScript.clientpb.BeaconTask.decode(event.Data);
          return task.ID === metadata.TaskID && task.BeaconID === beaconId;
        } catch {
          return false;
        }
      },
      timeoutMilliseconds,
      `${label} task result`,
    );

    const task = await this.client.fetchBeaconTask(metadata.TaskID, commandTimeoutSeconds);
    assert.equal(task.ID, metadata.TaskID, `${label} fetched task ID`);
    assert.equal(task.BeaconID, beaconId, `${label} fetched beacon ID`);
    assert.equal(task.State, "completed", `${label} task state`);
    assert.ok(BigInt(task.SentAt) > 0n, `${label} task sent timestamp`);
    assert.ok(BigInt(task.CompletedAt) > 0n, `${label} task completion timestamp`);

    const response = decode(task.Response);
    const responseMetadata = responseMetadataOf(response);
    if (responseMetadata) assert.equal(responseMetadata.Err, "", `${label} implant error`);
    return { queued, task, response };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const errors: Error[] = [];
    const attempt = async (label: string, operation: () => Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        errors.push(new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
      }
    };

    for (const implant of [this.beacon, this.session]) {
      if (implant) await attempt(`stop ${implant.mode} process`, () => this.stopImplant(implant));
    }

    if (this.client.isConnected) {
      await attempt("remove beacon", async () => {
        const id = this.beacon?.beacon?.ID;
        if (id && (await this.client.getBeacons(15)).Beacons.some((beacon) => beacon.ID === id)) {
          await this.client.rmBeacon(id, 30);
        }
      });
      await attempt("close sessions", async () => {
        const sessionIds = new Set(this.extraSessionIds);
        if (this.session?.session?.ID) sessionIds.add(this.session.session.ID);
        const current = (await this.client.getSessions(15)).Sessions;
        for (const sessionId of sessionIds) {
          if (current.some((session) => session.ID === sessionId)) {
            await this.client.closeSession(sessionId, 30);
          }
        }
      });
      await attempt("delete implant builds", async () => {
        const builds = await this.client.implantBuilds(30);
        for (const buildName of this.buildNames) {
          if (Object.prototype.hasOwnProperty.call(builds.Configs, buildName)) {
            await this.client.deleteImplantBuild(buildName, 30);
          }
        }
      });
      await attempt("delete implant profiles", async () => {
        const profiles = await this.client.implantProfiles(30);
        for (const profileName of this.profileNames) {
          if (profiles.Profiles.some((profile) => profile.Name === profileName)) {
            await this.client.deleteImplantProfile(profileName, 30);
          }
        }
      });
      await attempt("stop mTLS listener", async () => {
        if (!this.listener) return;
        const jobs = await this.client.getJobs(15);
        if (!jobs.Active.some((job) => job.ID === this.listener?.jobId)) return;
        const result = await this.client.killJob(this.listener.jobId, 30);
        assert.equal(result.Success, true, "mTLS listener cleanup result");
      });
      await attempt("disconnect client", () => this.client.disconnect());
    }

    for (const subscription of this.subscriptions) subscription.unsubscribe();
    for (const waiter of this.eventWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("E2E suite context disposed while waiting for an event"));
    }
    this.eventWaiters.clear();

    if (errors.length > 0) throw new AggregateError(errors, "E2E suite cleanup failed");
  }

  private recordEvent(event: clientpb.Event): void {
    const index = this.events.length;
    this.events.push(event);
    for (const waiter of [...this.eventWaiters]) {
      if (index < waiter.cursor) continue;
      try {
        if (!waiter.predicate(event)) continue;
        this.finishWaiter(waiter);
        waiter.resolve(event);
      } catch (error) {
        this.finishWaiter(waiter);
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private waitForEventInternal(
    cursor: number,
    predicate: (event: clientpb.Event) => boolean,
    timeoutMilliseconds: number,
    label: string,
    signal?: AbortSignal,
  ): Promise<clientpb.Event> {
    assert.ok(Number.isSafeInteger(cursor) && cursor >= 0 && cursor <= this.events.length, "event cursor");
    assert.ok(Number.isSafeInteger(timeoutMilliseconds) && timeoutMilliseconds > 0, "event timeout");
    for (let index = cursor; index < this.events.length; index += 1) {
      const event = this.events[index];
      if (event && predicate(event)) return Promise.resolve(event);
    }

    return new Promise((resolve, reject) => {
      let waiter: EventWaiter;
      const timer = setTimeout(() => {
        this.finishWaiter(waiter);
        reject(new Error(
          `Timed out waiting for ${label}; event stream ${this.latestEventState.status}`
            + (this.latestEventState.error ? ` (${this.latestEventState.error})` : ""),
        ));
      }, timeoutMilliseconds);
      const abort = signal ? () => {
        this.finishWaiter(waiter);
        reject(new Error(`Cancelled wait for ${label}`));
      } : undefined;
      waiter = { cursor, predicate, resolve, reject, timer, signal, abort };
      if (signal?.aborted) {
        clearTimeout(timer);
        reject(new Error(`Cancelled wait for ${label}`));
        return;
      }
      if (signal && abort) signal.addEventListener("abort", abort, { once: true });
      this.eventWaiters.add(waiter);
    });
  }

  private finishWaiter(waiter: EventWaiter): void {
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort);
    this.eventWaiters.delete(waiter);
  }
}

// TypeScript does not allow static members to be read from an instance type.
const SliverClientInstanceConstants = sliverScript.SliverClient;

export async function createE2ESuiteContext(): Promise<E2ESuiteContext> {
  const environment = loadE2EEnvironment();
  const workDir = requiredEnvironmentVariable("SLIVER_E2E_WORK_DIR");
  const resultsDir = requiredEnvironmentVariable("SLIVER_E2E_RESULTS_DIR");
  await Promise.all([mkdir(workDir, { recursive: true }), mkdir(resultsDir, { recursive: true })]);

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
  const context = new E2ESuiteContext(client, config, environment, workDir, resultsDir);
  try {
    const connected = await client.connect();
    assert.equal(connected, client, "connect must resolve to the client instance");
    assert.equal(client.isConnected, true, "client must report a connected state");
    return context;
  } catch (error) {
    await context.dispose().catch(() => undefined);
    throw error;
  }
}

export async function waitForLoopbackTCP(port: number, timeoutMilliseconds = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(500);
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
    await delay(250);
  }
  throw new Error(`Timed out waiting for loopback listener 127.0.0.1:${port}`);
}

function appendBounded(current: string, chunk: Buffer): string {
  const combined = current + chunk.toString();
  return combined.length <= processOutputLimit
    ? combined
    : combined.slice(combined.length - processOutputLimit);
}

function validateConnectedTarget(
  target: clientpb.Session | clientpb.Beacon,
  implant: LiveImplant,
  environment: E2EEnvironment,
): void {
  assert.ok(target.ID, `${implant.mode} callback ID`);
  assert.equal(target.Name, implant.name, `${implant.mode} callback name`);
  assert.equal(target.PID, implant.pid, `${implant.mode} callback PID`);
  assert.equal(target.OS, environment.expectedOS, `${implant.mode} callback operating system`);
  assert.equal(target.Arch, environment.expectedArch, `${implant.mode} callback architecture`);
  assert.equal(target.Transport.trim().toLowerCase(), "mtls", `${implant.mode} callback transport`);
  if (target.ActiveC2.trim()) {
    assert.match(target.ActiveC2.trim().toLowerCase(), /^mtls:\/\//u, `${implant.mode} active C2`);
  }
}

function isolatedImplantEnvironment(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "COMSPEC", "PATHEXT", "SYSTEMDRIVE", "SYSTEMROOT", "WINDIR"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  env.HOME = path.join(root, "home");
  env.USERPROFILE = path.join(root, "home");
  env.TMPDIR = path.join(root, "tmp");
  env.TMP = path.join(root, "tmp");
  env.TEMP = path.join(root, "tmp");
  env.SLIVER_SCRIPT_E2E = "1";
  return env;
}

function responseMetadataOf(value: unknown): commonpb.Response | undefined {
  if (!value || typeof value !== "object" || !("Response" in value)) return undefined;
  const response = (value as { Response?: unknown }).Response;
  if (!response || typeof response !== "object") return undefined;
  return response as commonpb.Response;
}

async function waitForExit(child: ChildProcess, timeoutMilliseconds: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    delay(timeoutMilliseconds).then(() => false),
  ]);
}

async function waitForSpawn(child: ChildProcess, mode: ImplantMode): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onSpawn = (): void => {
      child.off("error", onError);
      resolve();
    };
    const onError = (error: Error): void => {
      child.off("spawn", onSpawn);
      reject(new Error(`Failed to start generated ${mode} process: ${error.message}`, { cause: error }));
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

async function taskkill(pid: number, force: boolean): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");
    const child = spawn("taskkill.exe", args, { stdio: "ignore", windowsHide: true });
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`taskkill for PID ${pid} exceeded ${taskkillTimeoutMilliseconds}ms`));
    }, taskkillTimeoutMilliseconds);
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code === 0 || code === 128) finish();
      else finish(new Error(`taskkill exited with ${code ?? "no status"}`));
    });
  });
}

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} is required`);
  return value;
}
