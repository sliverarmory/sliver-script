import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import type { clientpb as ClientPB } from "../../lib";
import type { E2ESuiteContext, ImplantMode } from "../context";
import { waitForLoopbackTCP } from "../context";

const sliverScript = require("../../../lib") as typeof import("../../lib");
const { clientpb } = sliverScript;

export const name = "03-listener-generation-callbacks";

const generationTimeoutSeconds = 45 * 60;

export async function run(context: E2ESuiteContext): Promise<void> {
  const { client, environment } = context;
  const port = await context.allocateLoopbackPort();
  const cursor = context.eventCursor();
  const derivedJobEvents: ClientPB.Event[] = [];
  const jobSubscription = client.job$.subscribe((event) => derivedJobEvents.push(event));
  let listener: ClientPB.ListenerJob | undefined;
  try {
    listener = await client.startMTLSListener("127.0.0.1", port, 30);
    assert.ok(Number.isSafeInteger(listener.JobID) && listener.JobID > 0, "mTLS listener job ID");
    context.listener = {
      jobId: listener.JobID,
      port,
      c2Url: `mtls://127.0.0.1:${port}`,
    };

    await Promise.all([
      waitForLoopbackTCP(port),
      context.waitForEvent(
        cursor,
        (event) => event.EventType === "job-started" && event.Job?.ID === listener?.JobID,
        30_000,
        "mTLS listener job-started event",
      ),
    ]);
  } finally {
    jobSubscription.unsubscribe();
  }
  assert.ok(listener, "mTLS listener response");
  assert.ok(
    derivedJobEvents.some((event) => event.EventType === "job-started" && event.Job?.ID === listener.JobID),
    "derived job observable must emit the mTLS start event",
  );
  const jobs = await client.jobs();
  const listedJob = jobs.find((job) => job.ID === listener.JobID);
  assert.ok(listedJob, "job inventory must contain the mTLS listener");
  assert.equal(listedJob.Name.trim().toLowerCase(), "mtls", "mTLS listener inventory name");
  assert.equal(listedJob.Protocol.trim().toLowerCase(), "tcp", "mTLS listener inventory protocol");
  assert.equal(listedJob.Port, port, "mTLS listener inventory port");

  const sessionName = "sliverscripte2esession";
  const generatedSession = await client.generateImplant(
    implantConfig(context, "session"),
    sessionName,
    generationTimeoutSeconds,
  );
  assert.equal(generatedSession.ImplantName, sessionName, "generated session implant name");
  assert.ok(generatedSession.File, "generated session file");
  const sessionDigest = createHash("sha256").update(generatedSession.File.Data).digest("hex");
  const derivedSessionEvents: ClientPB.Event[] = [];
  const sessionSubscription = client.session$.subscribe((event) => derivedSessionEvents.push(event));
  let session;
  try {
    session = await context.launchGeneratedImplant("session", generatedSession);
  } finally {
    sessionSubscription.unsubscribe();
  }
  assert.ok(session.session?.ID, "session callback must populate the shared fixture");
  assert.ok(
    derivedSessionEvents.some((event) => event.EventType === "session-connected"
      && event.Session?.ID === session.session?.ID),
    "derived session observable must emit the exact callback",
  );

  const regenerated = await client.regenerateImplant(session.buildName, 120);
  try {
    assert.equal(regenerated.ImplantName, session.buildName, "regenerated implant name");
    assert.equal(regenerated.ImplantBuildID, session.buildId, "regenerated implant build ID");
    assert.ok(regenerated.File, "regenerated implant file");
    assert.equal(
      createHash("sha256").update(regenerated.File.Data).digest("hex"),
      sessionDigest,
      "regenerated implant bytes",
    );
  } finally {
    regenerated.File?.Data.fill(0);
  }

  const beaconName = "sliverscripte2ebeacon";
  const generatedBeacon = await client.generateImplant(
    implantConfig(context, "beacon"),
    beaconName,
    generationTimeoutSeconds,
  );
  assert.equal(generatedBeacon.ImplantName, beaconName, "generated beacon implant name");
  const derivedBeaconEvents: ClientPB.Event[] = [];
  const beaconSubscription = client.beacon$.subscribe((event) => derivedBeaconEvents.push(event));
  let beacon;
  try {
    beacon = await context.launchGeneratedImplant("beacon", generatedBeacon);
  } finally {
    beaconSubscription.unsubscribe();
  }
  assert.ok(beacon.beacon?.ID, "beacon callback must populate the shared fixture");
  assert.ok(
    derivedBeaconEvents.some((event) => {
      try {
        return clientpb.Beacon.decode(event.Data).ID === beacon.beacon?.ID;
      } catch {
        return false;
      }
    }),
    "derived beacon observable must emit the exact callback",
  );

  const builds = await client.implantBuilds(30);
  assert.equal(builds.Configs[session.buildName]?.IsBeacon, false, "session build inventory mode");
  assert.equal(builds.Configs[beacon.buildName]?.IsBeacon, true, "beacon build inventory mode");
  assert.equal(builds.Configs[session.buildName]?.GOOS, environment.expectedOS, "session build operating system");
  assert.equal(builds.Configs[beacon.buildName]?.GOARCH, environment.expectedArch, "beacon build architecture");

  try {
    await client.stageImplantBuild([session.buildName, beacon.buildName], 30);
    const staged = await client.implantBuilds(30);
    assert.equal(staged.staged[session.buildName], true, "session build staged state");
    assert.equal(staged.staged[beacon.buildName], true, "beacon build staged state");
  } finally {
    await client.stageImplantBuild([], 30);
  }
  const unstaged = await client.implantBuilds(30);
  assert.equal(unstaged.staged[session.buildName] ?? false, false, "session build unstaged state");
  assert.equal(unstaged.staged[beacon.buildName] ?? false, false, "beacon build unstaged state");
}

function implantConfig(context: E2ESuiteContext, mode: ImplantMode): ClientPB.ImplantConfig {
  assert.ok(context.listener, "listener fixture");
  return clientpb.ImplantConfig.create({
    GOOS: context.environment.expectedOS,
    GOARCH: context.environment.expectedArch,
    TemplateName: "sliver",
    Debug: false,
    ObfuscateSymbols: false,
    IsBeacon: mode === "beacon",
    BeaconInterval: "10000000000",
    BeaconJitter: "0",
    Format: clientpb.OutputFormat.EXECUTABLE,
    C2: [clientpb.ImplantC2.create({ URL: context.listener.c2Url })],
    HTTPC2ConfigName: "default",
    ConnectionStrategy: "s",
    ReconnectInterval: "1000000000",
    PollTimeout: "1000000000",
    MaxConnectionErrors: 20,
    NetGoEnabled: true,
    IncludeMTLS: true,
  });
}
