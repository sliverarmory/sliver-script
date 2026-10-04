import assert from "node:assert/strict";

import type { clientpb } from "../../lib";
import type { E2ESuiteContext } from "../context";

export const name = "01-inventory";

export async function run({ client }: E2ESuiteContext): Promise<void> {
    const sessionInventory: clientpb.Sessions = await client.getSessions();
    assert.deepEqual(sessionInventory.Sessions, [], "fresh server session inventory");

    const sessions: clientpb.Session[] = await client.sessions();
    assert.deepEqual(sessions, sessionInventory.Sessions, "sessions helper response");

    const beaconInventory: clientpb.Beacons = await client.getBeacons();
    assert.deepEqual(beaconInventory.Beacons, [], "fresh server beacon inventory");

    const beacons: clientpb.Beacon[] = await client.beacons();
    assert.deepEqual(beacons, beaconInventory.Beacons, "beacons helper response");

    const jobInventory: clientpb.Jobs = await client.getJobs();
    assert.deepEqual(jobInventory.Active, [], "daemon listener must not appear as a managed job");

    const jobs: clientpb.Job[] = await client.jobs();
    assert.deepEqual(jobs, jobInventory.Active, "jobs helper response");
}
