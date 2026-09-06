import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import type { E2ESuiteContext } from "../context";

export const name = "11-lifecycle-cleanup";

export async function run(context: E2ESuiteContext): Promise<void> {
  const sessionImplant = context.session;
  const session = sessionImplant?.session;
  assert.ok(sessionImplant && session, "live session fixture");

  const sessionCursor = context.eventCursor();
  await context.client.killSession(session.ID, true, 120);
  await Promise.all([
    requireNaturalExit(sessionImplant.child, 30_000, "session kill"),
    context.waitForEvent(
      sessionCursor,
      (event) => event.EventType === "session-disconnected" && event.Session?.ID === session.ID,
      30_000,
      "session-disconnected event",
    ),
  ]);
  await waitForInventoryAbsence(
    () => context.client.sessions().then((sessions) => sessions.some((candidate) => candidate.ID === session.ID)),
    "killed session",
  );

  const beaconImplant = context.beacon;
  const beacon = beaconImplant?.beacon;
  assert.ok(beaconImplant && beacon, "live beacon fixture");
  await context.client.killBeacon(beacon.ID, true, 120);
  await requireNaturalExit(beaconImplant.child, 45_000, "beacon kill");
  await context.client.rmBeacon(beacon.ID, 30);
  await waitForInventoryAbsence(
    () => context.client.beacons().then((beacons) => beacons.some((candidate) => candidate.ID === beacon.ID)),
    "removed beacon",
  );

  const buildNames = [...context.buildNames];
  for (const buildName of buildNames) {
    await context.client.deleteImplantBuild(buildName, 30);
    context.buildNames.delete(buildName);
  }
  const builds = await context.client.implantBuilds(30);
  for (const buildName of buildNames) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(builds.Configs, buildName),
      false,
      `deleted implant build ${buildName}`,
    );
  }

  assert.ok(context.listener, "mTLS listener fixture");
  const listener = context.listener;
  const listenerCursor = context.eventCursor();
  const killed = await context.client.killJob(listener.jobId, 30);
  assert.equal(killed.ID, listener.jobId, "killed listener job ID");
  assert.equal(killed.Success, true, "killed listener result");
  await context.waitForEvent(
    listenerCursor,
    (event) => event.EventType === "job-stopped" && event.Job?.ID === listener.jobId,
    30_000,
    "mTLS listener job-stopped event",
  );
  await waitForInventoryAbsence(
    () => context.client.jobs().then((jobs) => jobs.some((job) => job.ID === listener.jobId)),
    "stopped listener",
  );
  context.listener = undefined;

  assert.deepEqual(await context.client.sessions(), [], "terminal session inventory");
  assert.deepEqual(await context.client.beacons(), [], "terminal beacon inventory");
}

async function requireNaturalExit(
  child: ChildProcess,
  timeoutMilliseconds: number,
  label: string,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    delay(timeoutMilliseconds).then(() => false),
  ]);
  if (!exited) throw new Error(`${label} did not terminate process ${child.pid} within ${timeoutMilliseconds}ms`);
}

async function waitForInventoryAbsence(
  isPresent: () => Promise<boolean>,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!await isPresent()) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label} to leave server inventory`);
}
