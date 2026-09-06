import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

import type { clientpb, commonpb, sliverpb } from "../../lib";
import type { E2ESuiteContext } from "../context";

const sliverScript = require("../../../lib") as typeof import("../../lib");

export const name = "09-beacon-process-network";

const rpcTimeoutSeconds = 30;

export async function run(context: E2ESuiteContext): Promise<void> {
  const implant = context.beacon;
  assert.ok(implant?.beacon, "shared beacon fixture must be registered by group 03");
  const beaconId = implant.beacon.ID;
  const commands = context.client.interactBeacon(beaconId);
  const completedTaskIds: string[] = [];

  // A full-info process list can legitimately exceed the public 64 KiB
  // decoded beacon-task budget on a busy runner. The synchronous session group
  // validates full-info metadata; keep this asynchronous call within the
  // reviewed task-content boundary and verify the live implant is present.
  const processes = await context.runBeaconTask(
    beaconId,
    () => commands.ps(false, rpcTimeoutSeconds),
    sliverScript.sliverpb.Ps.decode,
    "beacon basic process list",
  );
  assertResponseOk(processes.queued.Response, "beacon basic process-list queue");
  assertResponseOk(processes.response.Response, "beacon basic process-list response");
  const selfProcess: commonpb.Process | undefined = processes.response.Processes.find(
    (candidate) => candidate.Pid === implant.pid,
  );
  assert.ok(selfProcess, "beacon basic process list must contain the implant PID");
  completedTaskIds.push(processes.task.ID);

  const interfaces = await context.runBeaconTask(
    beaconId,
    () => commands.ifconfig(rpcTimeoutSeconds),
    sliverScript.sliverpb.Ifconfig.decode,
    "beacon ifconfig",
  );
  assertResponseOk(interfaces.queued.Response, "beacon ifconfig queue");
  assertResponseOk(interfaces.response.Response, "beacon ifconfig response");
  assert.ok(interfaces.response.NetInterfaces.length > 0, "beacon interface inventory must not be empty");
  let foundLoopback = false;
  for (const networkInterface of interfaces.response.NetInterfaces) {
    assert.ok(networkInterface.Name.trim(), "beacon interface name");
    for (const address of networkInterface.IPAddresses) {
      const ip = addressIP(address);
      assert.notEqual(isIP(ip), 0, `beacon interface address must be parseable: ${address}`);
      if (ip === "::1" || ip.startsWith("127.")) foundLoopback = true;
    }
  }
  assert.equal(foundLoopback, true, "beacon interface inventory must include loopback");
  completedTaskIds.push(interfaces.task.ID);

  const sockets = await context.runBeaconTask(
    beaconId,
    () => commands.netstat(rpcTimeoutSeconds),
    sliverScript.sliverpb.Netstat.decode,
    "beacon netstat default filters",
  );
  assertResponseOk(sockets.queued.Response, "beacon netstat queue");
  assertResponseOk(sockets.response.Response, "beacon netstat response");
  assert.ok(Array.isArray(sockets.response.Entries), "beacon netstat entries must be an array");
  completedTaskIds.push(sockets.task.ID);

  await exerciseEnvironment(context, beaconId, completedTaskIds);
  await exerciseOwnedHelper(context, beaconId, completedTaskIds);
  if (process.platform === "win32") {
    await exerciseWindowsReads(context, beaconId, completedTaskIds);
  }

  const history = await context.client.getBeaconTasks(beaconId, rpcTimeoutSeconds);
  for (const taskId of completedTaskIds) assertCompletedHistoryTask(history, taskId);
}

async function exerciseEnvironment(
  context: E2ESuiteContext,
  beaconId: string,
  completedTaskIds: string[],
): Promise<void> {
  const allVariables = await context.runBeaconTask(
    beaconId,
    () => context.client.getEnvBeacon(beaconId, "", rpcTimeoutSeconds),
    sliverScript.sliverpb.EnvInfo.decode,
    "beacon enumerate environment",
  );
  assertResponseOk(allVariables.queued.Response, "beacon environment enumeration queue");
  assertResponseOk(allVariables.response.Response, "beacon environment enumeration response");
  assert.ok(allVariables.response.Variables.length > 0, "beacon environment enumeration must not be empty");
  assert.equal(
    envValue(allVariables.response.Variables, "SLIVER_SCRIPT_E2E"),
    "1",
    "beacon enumerated environment marker",
  );
  completedTaskIds.push(allVariables.task.ID);

  const marker = await context.runBeaconTask(
    beaconId,
    () => context.client.getEnvBeacon(beaconId, "SLIVER_SCRIPT_E2E", rpcTimeoutSeconds),
    sliverScript.sliverpb.EnvInfo.decode,
    "beacon get isolated environment marker",
  );
  assertResponseOk(marker.queued.Response, "beacon marker GetEnv queue");
  assertResponseOk(marker.response.Response, "beacon marker GetEnv response");
  assert.equal(envValue(marker.response.Variables, "SLIVER_SCRIPT_E2E"), "1", "beacon isolated environment marker");
  completedTaskIds.push(marker.task.ID);

  const key = "SLIVER_SCRIPT_E2E_MUTABLE_BEACON";
  const value = `${context.environment.expectedOS}-${context.environment.expectedArch}-${process.pid}`;
  let variableSet = false;
  try {
    const set = await context.runBeaconTask(
      beaconId,
      () => context.client.setEnvBeacon(beaconId, key, value, rpcTimeoutSeconds),
      sliverScript.sliverpb.SetEnv.decode,
      "beacon set environment",
    );
    variableSet = true;
    assertResponseOk(set.queued.Response, "beacon SetEnv queue");
    assertResponseOk(set.response.Response, "beacon SetEnv response");
    completedTaskIds.push(set.task.ID);

    const fetched = await context.runBeaconTask(
      beaconId,
      () => context.client.getEnvBeacon(beaconId, key, rpcTimeoutSeconds),
      sliverScript.sliverpb.EnvInfo.decode,
      "beacon get named environment",
    );
    assertResponseOk(fetched.queued.Response, "beacon named GetEnv queue");
    assertResponseOk(fetched.response.Response, "beacon named GetEnv response");
    assert.equal(envValue(fetched.response.Variables, key), value, "beacon named environment value");
    completedTaskIds.push(fetched.task.ID);
  } finally {
    if (variableSet) {
      const unset = await context.runBeaconTask(
        beaconId,
        () => context.client.unsetEnvBeacon(beaconId, key, rpcTimeoutSeconds),
        sliverScript.sliverpb.UnsetEnv.decode,
        "beacon unset environment",
      );
      assertResponseOk(unset.queued.Response, "beacon UnsetEnv queue");
      assertResponseOk(unset.response.Response, "beacon UnsetEnv response");
      completedTaskIds.push(unset.task.ID);
    }
  }

  const afterUnset = await context.runBeaconTask(
    beaconId,
    () => context.client.getEnvBeacon(beaconId, key, rpcTimeoutSeconds),
    sliverScript.sliverpb.EnvInfo.decode,
    "beacon verify unset environment",
  );
  assertResponseOk(afterUnset.queued.Response, "beacon post-unset GetEnv queue");
  assertResponseOk(afterUnset.response.Response, "beacon post-unset GetEnv response");
  assert.equal(afterUnset.response.Variables.length, 1, "beacon named GetEnv result after unset");
  assert.equal(envValue(afterUnset.response.Variables, key), "", "beacon environment value after unset");
  completedTaskIds.push(afterUnset.task.ID);
}

async function exerciseWindowsReads(
  context: E2ESuiteContext,
  beaconId: string,
  completedTaskIds: string[],
): Promise<void> {
  const owner = await context.runBeaconTask(
    beaconId,
    () => context.client.currentTokenOwnerBeacon(beaconId, rpcTimeoutSeconds),
    sliverScript.sliverpb.CurrentTokenOwner.decode,
    "beacon current token owner",
  );
  assertResponseOk(owner.queued.Response, "beacon current-token-owner queue");
  assertResponseOk(owner.response.Response, "beacon current-token-owner response");
  assert.ok(owner.response.Output.trim(), "beacon current token owner must not be empty");
  completedTaskIds.push(owner.task.ID);

  const privileges = await context.runBeaconTask(
    beaconId,
    () => context.client.getPrivsBeacon(beaconId, rpcTimeoutSeconds),
    sliverScript.sliverpb.GetPrivs.decode,
    "beacon privilege inventory",
  );
  assertResponseOk(privileges.queued.Response, "beacon privilege inventory queue");
  assertResponseOk(privileges.response.Response, "beacon privilege inventory response");
  assert.ok(privileges.response.ProcessName.trim(), "beacon privilege inventory process name");
  assert.ok(privileges.response.PrivInfo.length > 0, "beacon privilege inventory entries");
  completedTaskIds.push(privileges.task.ID);
}

async function exerciseOwnedHelper(
  context: E2ESuiteContext,
  beaconId: string,
  completedTaskIds: string[],
): Promise<void> {
  const helperPath = path.join(__dirname, "..", "exec-helper.js");
  await access(helperPath);
  const marker = `beacon-${context.environment.expectedOS}-${context.environment.expectedArch}-${process.pid}`;

  const synchronous = await context.runBeaconTask(
    beaconId,
    () => context.client.executeBeacon(
      beaconId,
      {
        path: process.execPath,
        args: [helperPath],
        output: true,
        envInheritance: true,
        env: {
          SLIVER_E2E_HELPER: "sync",
          SLIVER_E2E_EXEC_MARKER: marker,
        },
      },
      rpcTimeoutSeconds,
    ),
    sliverScript.sliverpb.Execute.decode,
    "beacon execute synchronous helper",
  );
  assertResponseOk(synchronous.queued.Response, "beacon synchronous Execute queue");
  assertResponseOk(synchronous.response.Response, "beacon synchronous Execute response");
  assert.equal(synchronous.response.Status, 7, "beacon synchronous helper exit status");
  assert.match(synchronous.response.Stdout.toString("utf8"), new RegExp(`stdout:${escapeRegExp(marker)}`), "beacon helper stdout");
  assert.match(synchronous.response.Stderr.toString("utf8"), new RegExp(`stderr:${escapeRegExp(marker)}`), "beacon helper stderr");
  completedTaskIds.push(synchronous.task.ID);

  let childPid: number | undefined;
  try {
    const background = await context.runBeaconTask(
      beaconId,
      () => context.client.executeBeacon(
        beaconId,
        {
          path: process.execPath,
          args: [helperPath],
          background: true,
          envInheritance: true,
          env: {
            SLIVER_E2E_HELPER: "child",
            SLIVER_E2E_EXEC_MARKER: marker,
          },
        },
        rpcTimeoutSeconds,
      ),
      sliverScript.sliverpb.Execute.decode,
      "beacon execute background helper",
    );
    assertResponseOk(background.queued.Response, "beacon background Execute queue");
    assertResponseOk(background.response.Response, "beacon background Execute response");
    assert.ok(Number.isSafeInteger(background.response.Pid) && background.response.Pid > 1, "beacon helper child PID");
    childPid = background.response.Pid;
    completedTaskIds.push(background.task.ID);

    const children = await context.runBeaconTask(
      beaconId,
      () => context.client.executeChildrenBeacon(beaconId, rpcTimeoutSeconds),
      sliverScript.sliverpb.ExecuteChildren.decode,
      "beacon execute children",
    );
    assertResponseOk(children.queued.Response, "beacon ExecuteChildren queue");
    assertResponseOk(children.response.Response, "beacon ExecuteChildren response");
    requireLiveOwnedChild(children.response.Children, childPid, process.execPath, helperPath);
    completedTaskIds.push(children.task.ID);

    // Re-check the exact tracked path immediately before the only termination
    // request made by this group.
    const beforeTerminate = await context.runBeaconTask(
      beaconId,
      () => context.client.executeChildrenBeacon(beaconId, rpcTimeoutSeconds),
      sliverScript.sliverpb.ExecuteChildren.decode,
      "beacon verify child before terminate",
    );
    assertResponseOk(beforeTerminate.queued.Response, "beacon pre-terminate ExecuteChildren queue");
    assertResponseOk(beforeTerminate.response.Response, "beacon pre-terminate ExecuteChildren response");
    requireLiveOwnedChild(beforeTerminate.response.Children, childPid, process.execPath, helperPath);
    completedTaskIds.push(beforeTerminate.task.ID);

    const terminated = await context.runBeaconTask(
      beaconId,
      () => context.client.interactBeacon(beaconId).terminate(childPid!, false, rpcTimeoutSeconds),
      sliverScript.sliverpb.Terminate.decode,
      "beacon terminate owned helper",
    );
    assertResponseOk(terminated.queued.Response, "beacon Terminate queue");
    assertResponseOk(terminated.response.Response, "beacon Terminate response");
    assert.equal(terminated.response.Pid, childPid, "beacon terminated helper PID");
    completedTaskIds.push(terminated.task.ID);

    const afterTerminate = await context.runBeaconTask(
      beaconId,
      () => context.client.executeChildrenBeacon(beaconId, rpcTimeoutSeconds),
      sliverScript.sliverpb.ExecuteChildren.decode,
      "beacon verify terminated child",
    );
    assertResponseOk(afterTerminate.queued.Response, "beacon post-terminate ExecuteChildren queue");
    assertResponseOk(afterTerminate.response.Response, "beacon post-terminate ExecuteChildren response");
    const stopped = afterTerminate.response.Children.find((child) => child.Pid === childPid);
    assert.ok(stopped, "terminated beacon helper must remain in tracked child history");
    assert.equal(stopped.Exited, true, "terminated beacon helper tracked exit state");
    completedTaskIds.push(afterTerminate.task.ID);
    childPid = undefined;
  } finally {
    if (childPid !== undefined) await stopOwnedHelper(context, beaconId, childPid);
  }
}

async function stopOwnedHelper(context: E2ESuiteContext, beaconId: string, pid: number): Promise<void> {
  try {
    await context.runBeaconTask(
      beaconId,
      () => context.client.interactBeacon(beaconId).terminate(pid, true, rpcTimeoutSeconds),
      sliverScript.sliverpb.Terminate.decode,
      "cleanup beacon helper child",
    );
    return;
  } catch (taskError) {
    try {
      process.kill(pid, "SIGKILL");
      return;
    } catch (killError) {
      if ((killError as NodeJS.ErrnoException).code === "ESRCH") return;
      throw new AggregateError([taskError, killError], `Unable to stop exact test-owned helper PID ${pid}`);
    }
  }
}

function requireLiveOwnedChild(
  children: sliverpb.ExecuteChild[],
  pid: number,
  executable: string,
  helperPath: string,
): sliverpb.ExecuteChild {
  const child = children.find((candidate) => candidate.Pid === pid);
  assert.ok(child, `tracked helper child ${pid}`);
  assert.equal(child.Exited, false, `tracked helper child ${pid} live state`);
  assert.equal(samePath(child.Path, executable), true, `tracked helper child ${pid} executable`);
  assert.ok(
    child.Args.some((argument) => samePath(argument, helperPath)),
    `tracked helper child ${pid} arguments must contain the exact helper path`,
  );
  return child;
}

function envValue(variables: commonpb.EnvVar[], key: string): string | undefined {
  return variables.find((variable) => variable.Key.toLowerCase() === key.toLowerCase())?.Value;
}

function addressIP(address: string): string {
  const withoutPrefix = address.trim().split("/", 1)[0] ?? "";
  const withoutZone = withoutPrefix.split("%", 1)[0] ?? "";
  return withoutZone.replace(/^\[|\]$/gu, "");
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value).replace(/[\\/]+$/u, "");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function assertResponseOk(response: commonpb.Response | undefined, label: string): void {
  assert.equal(response?.Err ?? "", "", `${label} error`);
}

function assertCompletedHistoryTask(history: clientpb.BeaconTasks, taskId: string): void {
  const summary = history.Tasks.find((task) => task.ID === taskId);
  assert.ok(summary, `beacon process/network task history must contain ${taskId}`);
  assert.equal(summary.State, "completed", `${taskId} history state`);
  assert.equal(summary.Request.length, 0, `${taskId} history request bytes must be omitted`);
  assert.equal(summary.Response.length, 0, `${taskId} history response bytes must be omitted`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
