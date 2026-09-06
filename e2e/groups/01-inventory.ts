import assert from "node:assert/strict";

import type { clientpb } from "../../lib";

import { loadE2EEnvironment, withConnectedClient } from "../support";

export const name = "01-inventory";

export async function run(): Promise<void> {
  const environment = loadE2EEnvironment();

  await withConnectedClient(environment, async ({ client }) => {
    const sessionInventory: clientpb.Sessions = await client.getSessions();
    assert.ok(Array.isArray(sessionInventory.Sessions), "GetSessions response must contain an array");
    assert.deepEqual(sessionInventory.Sessions, [], "fresh server session inventory");

    const sessions: clientpb.Session[] = await client.sessions();
    assert.ok(Array.isArray(sessions), "sessions helper must return an array");
    assert.deepEqual(sessions, sessionInventory.Sessions, "sessions helper response");

    const beaconInventory: clientpb.Beacons = await client.getBeacons();
    assert.ok(Array.isArray(beaconInventory.Beacons), "GetBeacons response must contain an array");
    assert.deepEqual(beaconInventory.Beacons, [], "fresh server beacon inventory");

    const beacons: clientpb.Beacon[] = await client.beacons();
    assert.ok(Array.isArray(beacons), "beacons helper must return an array");
    assert.deepEqual(beacons, beaconInventory.Beacons, "beacons helper response");

    const jobInventory: clientpb.Jobs = await client.getJobs();
    assert.ok(Array.isArray(jobInventory.Active), "GetJobs response must contain an array");
    assert.deepEqual(jobInventory.Active, [], "daemon listener must not appear as a managed job");

    const jobs: clientpb.Job[] = await client.jobs();
    assert.ok(Array.isArray(jobs), "jobs helper must return an array");
    assert.deepEqual(jobs, jobInventory.Active, "jobs helper response");
  });
}

void run().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
