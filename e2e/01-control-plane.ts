import * as path from "node:path";

import { filter, firstValueFrom, timeout } from "rxjs";

type SliverScriptModule = typeof import("..");
type SliverClientInstance = InstanceType<SliverScriptModule["SliverClient"]>;

const repoRoot = path.resolve(__dirname, "../..");
const configPath = process.env.SLIVER_CONFIG_FILE;
if (!configPath) throw new Error("SLIVER_CONFIG_FILE is required");

const sliver = require(path.join(repoRoot, "lib")) as SliverScriptModule;
const listenerHost = process.env.SLIVER_E2E_MTLS_BIND_HOST ?? "127.0.0.1";
const listenerPort = parsePort(process.env.SLIVER_E2E_MTLS_PORT, "SLIVER_E2E_MTLS_PORT");
const implantHost = process.env.SLIVER_E2E_MTLS_HOST ?? "localhost";

const rpcTimeoutSeconds = 30;
const generationTimeoutSeconds = 15 * 60;
const eventStreamTimeoutMilliseconds = 15_000;
const reconciliationTimeoutMilliseconds = 15_000;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function parsePort(value: string | undefined, name: string): number {
  const port = Number.parseInt(value ?? "", 10);
  assert(Number.isInteger(port) && port >= 1 && port <= 65_535, `Invalid ${name}: ${value ?? ""}`);
  return port;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMilliseconds = reconciliationTimeoutMilliseconds,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(`Timed out after ${timeoutMilliseconds}ms waiting for ${label}`);
}

async function cleanup(label: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    console.warn(`control-plane cleanup failed (${label})`, error);
  }
}

function nativeExecutableTarget(compiler: Awaited<ReturnType<SliverClientInstance["getCompiler"]>>) {
  return compiler.Targets.find((target) =>
    target.Format === sliver.clientpb.OutputFormat.EXECUTABLE
    && target.GOOS === compiler.GOOS
    && target.GOARCH === compiler.GOARCH
  ) ?? compiler.Targets.find((target) => target.Format === sliver.clientpb.OutputFormat.EXECUTABLE);
}

function implantConfig(goos: string, goarch: string) {
  return sliver.clientpb.ImplantConfig.create({
    GOOS: goos,
    GOARCH: goarch,
    C2: [{ URL: `mtls://${implantHost}:${listenerPort}` }],
    HTTPC2ConfigName: "default",
    Debug: false,
    ObfuscateSymbols: false,
    IsBeacon: false,
    IncludeMTLS: true,
    IncludeHTTP: false,
    IncludeWG: false,
    Format: sliver.clientpb.OutputFormat.EXECUTABLE,
    IsSharedLib: false,
    IsService: false,
    IsShellcode: false,
  });
}

async function main(): Promise<void> {
  const config = await sliver.ParseConfigFile(configPath!);
  const client = new sliver.SliverClient(config);
  const suffix = `${Date.now().toString(36)}-${process.pid}`;
  const buildName = `sliver-script-e2e-build-${suffix}`;
  const profileName = `sliver-script-e2e-profile-${suffix}`;
  const eventTypes: string[] = [];
  let listenerJobId: number | undefined;
  let generatedBuildName: string | undefined;
  let generatedBytes: Buffer | undefined;
  let profileCreated = false;
  let connected = false;
  let subscription: { unsubscribe(): void } | undefined;

  try {
    await client.connect();
    connected = true;
    subscription = client.event$.subscribe((event) => eventTypes.push(event.EventType));
    const eventStreamConnected = firstValueFrom(client.eventStreamState$.pipe(
      filter((state) => state.status === "connected"),
      timeout(eventStreamTimeoutMilliseconds),
    ));
    // The client marks the stream connected only after its first real event.
    // Give the subscription time to reach the server, then let the listener's
    // job-started event prove both readiness and delivery.
    await sleep(250);

    const [, started] = await Promise.all([
      eventStreamConnected,
      client.startMTLSListener(listenerHost, listenerPort, rpcTimeoutSeconds),
    ]);
    listenerJobId = started.JobID;
    await waitFor("the listener job to appear", async () =>
      (await client.jobs(rpcTimeoutSeconds)).some((job) => job.ID === listenerJobId));
    const activeJob = (await client.jobs(rpcTimeoutSeconds)).find((job) => job.ID === listenerJobId);
    assert(activeJob?.Port === listenerPort, `Listener job ${listenerJobId} did not retain port ${listenerPort}`);
    await waitFor("job-started event", () => eventTypes.includes("job-started"));

    const stopped = await client.killJob(listenerJobId, rpcTimeoutSeconds);
    assert(stopped.Success, `Listener job ${listenerJobId} did not report a successful stop`);
    listenerJobId = undefined;
    await waitFor("the listener job to disappear", async () =>
      !(await client.jobs(rpcTimeoutSeconds)).some((job) => job.ID === stopped.ID));
    await waitFor("job-stopped event", () => eventTypes.includes("job-stopped"));
    console.log("listener lifecycle reconciled", {
      jobId: stopped.ID,
      port: listenerPort,
      events: ["job-started", "job-stopped"],
    });

    const compiler = await client.getCompiler(rpcTimeoutSeconds);
    const target = nativeExecutableTarget(compiler);
    assert(target !== undefined, "Compiler returned no executable target");
    const buildConfig = implantConfig(target.GOOS, target.GOARCH);
    const generated = await client.generateImplant(buildConfig, buildName, generationTimeoutSeconds);
    generatedBuildName = generated.ImplantName;
    generatedBytes = generated.File?.Data;
    assert(generated.ImplantName === buildName, `Generated implant name mismatch: ${generated.ImplantName}`);
    assert(generated.ImplantBuildID.trim() !== "", "Generated implant build ID is empty");
    assert((generatedBytes?.length ?? 0) > 1_000, "Generated implant artifact is unexpectedly small");

    let builds = await client.implantBuilds(rpcTimeoutSeconds);
    assert(builds.Configs[generated.ImplantName] !== undefined, "Generated implant is absent from build inventory");
    await client.stageImplantBuild([generated.ImplantName], rpcTimeoutSeconds);
    builds = await client.implantBuilds(rpcTimeoutSeconds);
    assert(builds.staged[generated.ImplantName] === true, "Generated implant was not staged");

    const saved = await client.saveImplantProfile(
      sliver.clientpb.ImplantProfile.create({ ID: "", Name: profileName, Config: buildConfig }),
      rpcTimeoutSeconds,
    );
    profileCreated = true;
    assert(saved.Name === profileName, `Saved profile name mismatch: ${saved.Name}`);
    let profiles = await client.implantProfiles(rpcTimeoutSeconds);
    const profile = profiles.Profiles.find((candidate) => candidate.Name === profileName);
    assert(profile !== undefined, "Saved profile is absent from profile inventory");
    assert(profile.Config?.GOOS === target.GOOS, "Saved profile GOOS does not match its compiler target");
    assert(profile.Config?.GOARCH === target.GOARCH, "Saved profile GOARCH does not match its compiler target");
    assert(profile.Config?.Format === sliver.clientpb.OutputFormat.EXECUTABLE, "Saved profile format is not executable");

    await client.deleteImplantProfile(profileName, rpcTimeoutSeconds);
    profileCreated = false;
    profiles = await client.implantProfiles(rpcTimeoutSeconds);
    assert(!profiles.Profiles.some((candidate) => candidate.Name === profileName), "Deleted profile remains in inventory");

    await client.stageImplantBuild([], rpcTimeoutSeconds);
    await client.deleteImplantBuild(generated.ImplantName, rpcTimeoutSeconds);
    generatedBuildName = undefined;
    builds = await client.implantBuilds(rpcTimeoutSeconds);
    assert(builds.Configs[generated.ImplantName] === undefined, "Deleted implant build remains in inventory");
    console.log("build and profile lifecycle verified", {
      target: `${target.GOOS}/${target.GOARCH}`,
      build: generated.ImplantName,
      buildId: generated.ImplantBuildID,
      profile: profileName,
    });
  } finally {
    subscription?.unsubscribe();
    generatedBytes?.fill(0);
    if (profileCreated) {
      await cleanup(`profile ${profileName}`, () => client.deleteImplantProfile(profileName, rpcTimeoutSeconds));
    }
    if (generatedBuildName !== undefined) {
      await cleanup("staged builds", () => client.stageImplantBuild([], rpcTimeoutSeconds));
      await cleanup(`build ${generatedBuildName}`, () =>
        client.deleteImplantBuild(generatedBuildName!, rpcTimeoutSeconds));
    }
    if (listenerJobId !== undefined) {
      await cleanup(`listener job ${listenerJobId}`, () => client.killJob(listenerJobId!, rpcTimeoutSeconds));
    }
    if (connected) await cleanup("client disconnect", () => client.disconnect());
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
