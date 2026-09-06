import assert from "node:assert/strict";

import type { clientpb, commonpb } from "../../lib";
import type { E2ESuiteContext } from "../context";

// Emitted groups live in e2e/dist/groups, so runtime imports must walk back to
// the package build at the repository root.
const sliverScript = require("../../../lib") as typeof import("../../lib");

export const name = "07-beacon-core";

const rpcTimeoutSeconds = 30;
const beaconIntervalNanoseconds = "10000000000";

export async function run(context: E2ESuiteContext): Promise<void> {
  const implant = context.beacon;
  assert.ok(implant?.beacon, "shared beacon fixture must be registered by group 03");
  const beacon = implant.beacon;

  assert.equal(beacon.Interval, beaconIntervalNanoseconds, "beacon callback interval");
  assert.equal(beacon.Jitter, "0", "beacon callback jitter");
  assert.equal(beacon.IsDead, false, "beacon must be live");
  assert.ok(BigInt(beacon.FirstContact) > 0n, "beacon first-contact timestamp");
  assert.ok(BigInt(beacon.LastCheckin) > 0n, "beacon last-checkin timestamp");

  const rawInventory: clientpb.Beacons = await context.client.getBeacons(rpcTimeoutSeconds);
  const rawBeacon = rawInventory.Beacons.find((candidate) => candidate.ID === beacon.ID);
  assert.ok(rawBeacon, "GetBeacons must contain the shared beacon");
  assert.equal(rawBeacon.PID, implant.pid, "GetBeacons beacon PID");
  assert.equal(rawBeacon.OS, context.environment.expectedOS, "GetBeacons beacon operating system");
  assert.equal(rawBeacon.Arch, context.environment.expectedArch, "GetBeacons beacon architecture");

  const helperInventory: clientpb.Beacon[] = await context.client.beacons(rpcTimeoutSeconds);
  assert.ok(helperInventory.some((candidate) => candidate.ID === beacon.ID), "beacons helper must contain the shared beacon");

  const originalName = rawBeacon.Name;
  const renamed = "sliverscripte2erenamedbeacon";
  await context.client.renameBeacon(beacon.ID, renamed, rpcTimeoutSeconds);
  try {
    const renamedInventory = await context.client.getBeacons(rpcTimeoutSeconds);
    assert.equal(
      renamedInventory.Beacons.find((candidate) => candidate.ID === beacon.ID)?.Name,
      renamed,
      "renamed beacon inventory name",
    );
  } finally {
    await context.client.renameBeacon(beacon.ID, originalName, rpcTimeoutSeconds);
  }

  const nonce = 0x5a17c0de;
  const derivedTaskEvents: clientpb.Event[] = [];
  const taskSubscription = context.client.taskResult$.subscribe((event) => derivedTaskEvents.push(event));
  let pingTaskId = "";
  try {
    const ping = await context.runBeaconTask(
      beacon.ID,
      () => context.client.pingBeacon(beacon.ID, nonce, rpcTimeoutSeconds),
      sliverScript.sliverpb.Ping.decode,
      "beacon ping",
    );
    assert.equal(ping.queued.Response?.Err, "", "beacon ping queue error");
    assert.equal(ping.response.Response?.Err ?? "", "", "beacon ping response error");
    assert.equal(ping.response.Nonce, nonce, "beacon ping nonce round trip");
    assert.ok(ping.task.Request.length > 0, "stored beacon ping request bytes");
    assert.ok(ping.task.Response.length > 0, "stored beacon ping response bytes");
    pingTaskId = ping.task.ID;
    assert.ok(
      derivedTaskEvents.some((event) => {
        try {
          return sliverScript.clientpb.BeaconTask.decode(event.Data).ID === pingTaskId;
        } catch {
          return false;
        }
      }),
      "derived task-result observable must emit the exact ping task",
    );
  } finally {
    taskSubscription.unsubscribe();
  }

  const interactiveNonce = nonce + 7;
  const interactivePing = await context.runBeaconTask(
    beacon.ID,
    () => context.client.interactBeacon(beacon.ID).ping(interactiveNonce, rpcTimeoutSeconds),
    sliverScript.sliverpb.Ping.decode,
    "interactive beacon ping",
  );
  assert.equal(interactivePing.response.Nonce, interactiveNonce, "interactive beacon ping nonce");
  assert.equal(interactivePing.response.Response?.Err ?? "", "", "interactive beacon ping response error");

  const reconfigured = await context.runBeaconTask(
    beacon.ID,
    () => context.client.reconfigureBeacon(
      beacon.ID,
      { intervalNanoseconds: beaconIntervalNanoseconds },
      rpcTimeoutSeconds,
    ),
    sliverScript.sliverpb.Reconfigure.decode,
    "beacon ten-second reconfigure",
  );
  assert.equal(reconfigured.queued.Response?.Err, "", "beacon reconfigure queue error");
  assert.equal(reconfigured.response.Response?.Err ?? "", "", "beacon reconfigure response error");

  const afterReconfigure = await context.client.getBeacons(rpcTimeoutSeconds);
  assert.equal(
    afterReconfigure.Beacons.find((candidate) => candidate.ID === beacon.ID)?.Interval,
    beaconIntervalNanoseconds,
    "reconfigured beacon interval in inventory",
  );

  // A completed result-only check-in is followed by the configured callback
  // delay. Queue and cancel immediately after the reconfigure result so this
  // task remains deterministically pending on the loopback fixture.
  const canceledQueue = await context.client.pingBeacon(beacon.ID, nonce + 1, rpcTimeoutSeconds);
  const canceledMetadata = requireQueuedResponse(canceledQueue.Response, beacon.ID, "canceled beacon ping");
  const canceled = await context.client.cancelBeaconTask(canceledMetadata.TaskID, rpcTimeoutSeconds);
  assert.equal(canceled.ID, canceledMetadata.TaskID, "canceled beacon task ID");
  assert.equal(canceled.BeaconID, beacon.ID, "canceled beacon ID");
  assert.equal(canceled.State, "canceled", "canceled beacon task state");
  assert.equal(canceled.SentAt, "0", "canceled beacon task sent timestamp");
  assert.equal(canceled.CompletedAt, "0", "canceled beacon task completion timestamp");
  assert.equal(canceled.Response.length, 0, "canceled beacon task response bytes");

  const storedCanceled = await context.client.fetchBeaconTask(canceled.ID, rpcTimeoutSeconds);
  assert.equal(storedCanceled.ID, canceled.ID, "fetched canceled task ID");
  assert.equal(storedCanceled.BeaconID, beacon.ID, "fetched canceled task beacon ID");
  assert.equal(storedCanceled.State, "canceled", "fetched canceled task state");

  const history: clientpb.BeaconTasks = await context.client.getBeaconTasks(beacon.ID, rpcTimeoutSeconds);
  assertTaskSummary(history, pingTaskId, "completed");
  assertTaskSummary(history, interactivePing.task.ID, "completed");
  assertTaskSummary(history, reconfigured.task.ID, "completed");
  assertTaskSummary(history, canceled.ID, "canceled");

  const counted = (await context.client.getBeacons(rpcTimeoutSeconds)).Beacons.find(
    (candidate) => candidate.ID === beacon.ID,
  );
  assert.ok(counted, "beacon inventory after core tasks");
  assert.ok(BigInt(counted.TasksCount) >= 4n, "beacon total task count");
  assert.ok(BigInt(counted.TasksCountCompleted) >= 3n, "beacon completed task count");
}

function requireQueuedResponse(
  response: commonpb.Response | undefined,
  beaconId: string,
  label: string,
): commonpb.Response {
  assert.ok(response, `${label} queue metadata`);
  assert.equal(response.Err, "", `${label} queue error`);
  assert.equal(response.Async, true, `${label} async state`);
  assert.equal(response.BeaconID, beaconId, `${label} beacon ID`);
  assert.ok(response.TaskID, `${label} task ID`);
  return response;
}

function assertTaskSummary(history: clientpb.BeaconTasks, taskId: string, expectedState: string): void {
  assert.ok(Array.isArray(history.Tasks), "beacon task history must contain an array");
  const summary = history.Tasks.find((task) => task.ID === taskId);
  assert.ok(summary, `beacon task history must contain ${taskId}`);
  assert.equal(summary.State, expectedState, `${taskId} history state`);
  assert.equal(summary.Request.length, 0, `${taskId} history request bytes must be omitted`);
  assert.equal(summary.Response.length, 0, `${taskId} history response bytes must be omitted`);
}
