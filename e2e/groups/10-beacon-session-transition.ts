import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import type { E2ESuiteContext } from "../context";

const sliverScript = require("../../../lib") as typeof import("../../lib");

export const name = "10-beacon-session-transition";

export async function run(context: E2ESuiteContext): Promise<void> {
  const beacon = context.beacon?.beacon;
  assert.ok(beacon, "registered beacon fixture");
  assert.ok(context.listener, "mTLS listener fixture");

  const cursor = context.eventCursor();
  const completed = await context.runBeaconTask(
    beacon.ID,
    () => context.client.openSessionFromBeacon(
      beacon.ID,
      [context.listener!.c2Url],
      "0",
      120,
    ),
    (data) => sliverScript.sliverpb.OpenSession.decode(data),
    "open session from beacon",
    5 * 60_000,
  );
  assert.equal(completed.task.Response.length, 0, "open-session completion has an empty protobuf response");
  assert.deepEqual(completed.response.C2s, [], "open-session empty response decodes safely");

  const event = await context.waitForEvent(
    cursor,
    (candidate) => candidate.EventType === "session-connected"
      && candidate.Session?.Name === beacon.Name
      && candidate.Session.PID === beacon.PID,
    5 * 60_000,
    "beacon-created session callback",
  );
  const session = event.Session;
  assert.ok(session?.ID, "beacon-created session ID");
  assert.equal(session.OS, context.environment.expectedOS, "beacon-created session operating system");
  assert.equal(session.Arch, context.environment.expectedArch, "beacon-created session architecture");
  assert.equal(session.Transport.trim().toLowerCase(), "mtls", "beacon-created session transport");
  context.extraSessionIds.add(session.ID);

  const nonce = 1_003_019;
  const ping = await context.client.pingSession(session.ID, nonce, 120);
  assert.equal(ping.Nonce, nonce, "beacon-created session ping nonce");
  assert.equal(ping.Response?.Err ?? "", "", "beacon-created session ping error");
  assert.equal(ping.Response?.Async ?? false, false, "beacon-created session ping disposition");

  await context.client.closeSession(session.ID, 30);
  await waitForSessionAbsence(context, session.ID);
  context.extraSessionIds.delete(session.ID);

  const beacons = await context.client.beacons();
  assert.ok(beacons.some((candidate) => candidate.ID === beacon.ID), "beacon remains after closing its extra session");
}

async function waitForSessionAbsence(context: E2ESuiteContext, sessionId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const sessions = await context.client.sessions();
    if (!sessions.some((session) => session.ID === sessionId)) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for closed session ${sessionId} to leave inventory`);
}
