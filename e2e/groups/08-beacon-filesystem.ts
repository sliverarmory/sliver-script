import assert from "node:assert/strict";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { clientpb, commonpb, sliverpb } from "../../lib";
import type { E2ESuiteContext } from "../context";

const sliverScript = require("../../../lib") as typeof import("../../lib");

export const name = "08-beacon-filesystem";

const rpcTimeoutSeconds = 30;
const taskTimeoutMilliseconds = 2 * 60_000;

export async function run(context: E2ESuiteContext): Promise<void> {
  const implant = context.beacon;
  assert.ok(implant?.beacon, "shared beacon fixture must be registered by group 03");
  const beaconId = implant.beacon.ID;
  const commands = context.client.interactBeacon(beaconId);
  const completedTaskIds: string[] = [];

  const initialPwd = await context.runBeaconTask(
    beaconId,
    () => commands.pwd(rpcTimeoutSeconds),
    sliverScript.sliverpb.Pwd.decode,
    "beacon pwd",
  );
  assertResponseOk(initialPwd.queued.Response, "beacon pwd queue");
  assertResponseOk(initialPwd.response.Response, "beacon pwd response");
  await assertSamePath(initialPwd.response.Path, implant.root, "beacon initial working directory");
  completedTaskIds.push(initialPwd.task.ID);

  const workRoot = path.join(implant.root, "work");
  const nested = path.join(workRoot, "one", "two");
  assertWithinRoot(implant.root, workRoot);
  assertWithinRoot(implant.root, nested);
  const made = await context.runBeaconTask(
    beaconId,
    () => commands.mkdir(nested, rpcTimeoutSeconds),
    sliverScript.sliverpb.Mkdir.decode,
    "beacon mkdir",
  );
  assertResponseOk(made.queued.Response, "beacon mkdir queue");
  assertResponseOk(made.response.Response, "beacon mkdir response");
  await assertSamePath(made.response.Path, nested, "beacon mkdir path");
  assert.equal((await stat(nested)).isDirectory(), true, "beacon mkdir host result");
  completedTaskIds.push(made.task.ID);

  const relativeNested = path.relative(implant.root, nested);
  const changed = await context.runBeaconTask(
    beaconId,
    () => commands.cd(relativeNested, rpcTimeoutSeconds),
    sliverScript.sliverpb.Pwd.decode,
    "beacon cd relative",
  );
  assertResponseOk(changed.queued.Response, "beacon cd queue");
  assertResponseOk(changed.response.Response, "beacon cd response");
  await assertSamePath(changed.response.Path, nested, "beacon relative cd path");
  completedTaskIds.push(changed.task.ID);

  try {
    const nestedPwd = await context.runBeaconTask(
      beaconId,
      () => commands.pwd(rpcTimeoutSeconds),
      sliverScript.sliverpb.Pwd.decode,
      "beacon nested pwd",
    );
    assertResponseOk(nestedPwd.queued.Response, "beacon nested pwd queue");
    assertResponseOk(nestedPwd.response.Response, "beacon nested pwd response");
    await assertSamePath(nestedPwd.response.Path, nested, "beacon nested working directory");
    completedTaskIds.push(nestedPwd.task.ID);
  } finally {
    const restored = await context.runBeaconTask(
      beaconId,
      () => commands.cd(implant.root, rpcTimeoutSeconds),
      sliverScript.sliverpb.Pwd.decode,
      "beacon restore cwd",
    );
    assertResponseOk(restored.queued.Response, "beacon restore cwd queue");
    assertResponseOk(restored.response.Response, "beacon restore cwd response");
    await assertSamePath(restored.response.Path, implant.root, "beacon restored working directory");
    completedTaskIds.push(restored.task.ID);
  }

  const uploadPath = path.join(workRoot, "uploaded.txt");
  assertWithinRoot(implant.root, uploadPath);
  const uploadPayload = Buffer.from("sliver-script beacon upload payload\n", "utf8");
  const expectedUpload = Buffer.from(uploadPayload);
  const uploaded = await context.runBeaconTask(
    beaconId,
    () => commands.upload(uploadPath, uploadPayload, rpcTimeoutSeconds),
    sliverScript.sliverpb.Upload.decode,
    "beacon upload",
  );
  assertResponseOk(uploaded.queued.Response, "beacon upload queue");
  assertResponseOk(uploaded.response.Response, "beacon upload response");
  await assertSamePath(uploaded.response.Path, uploadPath, "beacon upload path");
  assert.equal(uploaded.response.WrittenFiles, 1, "beacon upload written-file count");
  assert.equal(uploaded.response.UnwriteableFiles, 0, "beacon upload unwritable-file count");
  assert.deepEqual(uploadPayload, expectedUpload, "beacon upload must preserve caller bytes");
  assert.deepEqual(await readFile(uploadPath), expectedUpload, "beacon upload host bytes");
  completedTaskIds.push(uploaded.task.ID);

  const downloaded = await commands.download(uploadPath, rpcTimeoutSeconds);
  assert.deepEqual(downloaded, expectedUpload, "interactive beacon download round trip");

  const listed = await runBeaconLs(context, beaconId, workRoot);
  assertResponseOk(listed.response.Response, "beacon ls response");
  assert.equal(listed.response.Exists, true, "beacon ls path exists");
  await assertSamePath(listed.response.Path, workRoot, "beacon ls path");
  assert.ok(
    listed.response.Files.some((file) => path.basename(file.Name) === "uploaded.txt" && file.Size === String(expectedUpload.length)),
    "beacon ls must contain the uploaded file and exact size",
  );
  assert.ok(
    listed.response.Files.some((file) => path.basename(file.Name) === "one" && file.IsDir),
    "beacon ls must contain the created directory",
  );
  completedTaskIds.push(listed.task.ID);

  const removedFile = await context.runBeaconTask(
    beaconId,
    () => commands.rm(uploadPath, false, false, rpcTimeoutSeconds),
    sliverScript.sliverpb.Rm.decode,
    "beacon rm file",
  );
  assertResponseOk(removedFile.queued.Response, "beacon rm file queue");
  assertResponseOk(removedFile.response.Response, "beacon rm file response");
  await assertSamePath(removedFile.response.Path, uploadPath, "beacon removed file path");
  await assertMissing(uploadPath, "beacon removed file");
  completedTaskIds.push(removedFile.task.ID);

  const removedTree = await context.runBeaconTask(
    beaconId,
    () => commands.rm(workRoot, true, false, rpcTimeoutSeconds),
    sliverScript.sliverpb.Rm.decode,
    "beacon rm tree",
  );
  assertResponseOk(removedTree.queued.Response, "beacon rm tree queue");
  assertResponseOk(removedTree.response.Response, "beacon rm tree response");
  await assertSamePath(removedTree.response.Path, workRoot, "beacon removed tree path");
  await assertMissing(workRoot, "beacon removed tree");
  completedTaskIds.push(removedTree.task.ID);

  assert.equal(
    await readFile(path.join(implant.root, "outside-test-sentinel.txt"), "utf8"),
    "must-survive\n",
    "filesystem operations must preserve the fixture sentinel",
  );

  const facadeListing = await context.client.interactBeacon(beaconId).ls(implant.root, rpcTimeoutSeconds);
  assertResponseOk(facadeListing.Response, "interactive beacon ls response");
  assert.equal(facadeListing.Exists, true, "interactive beacon ls root exists");
  await assertSamePath(facadeListing.Path, implant.root, "interactive beacon ls root path");
  assert.ok(
    facadeListing.Files.some((file) => path.basename(file.Name) === "outside-test-sentinel.txt"),
    "interactive beacon ls must contain the sentinel",
  );

  const history = await context.client.getBeaconTasks(beaconId, rpcTimeoutSeconds);
  for (const taskId of completedTaskIds) assertCompletedHistoryTask(history, taskId);
}

async function runBeaconLs(
  context: E2ESuiteContext,
  beaconId: string,
  targetPath: string,
): Promise<{ task: clientpb.BeaconTask; response: sliverpb.Ls }> {
  const cursor = context.eventCursor();
  const queued = await context.client.interactBeacon(beaconId).lsTask(targetPath, rpcTimeoutSeconds);
  assert.ok(queued.id, "beacon ls queued task ID");

  await context.waitForEvent(
    cursor,
    (event) => {
      if (event.EventType !== sliverScript.SliverClient.EVENT_BEACON_TASKRESULT) return false;
      try {
        const task = sliverScript.clientpb.BeaconTask.decode(event.Data);
        return task.ID === queued.id && task.BeaconID === beaconId;
      } catch {
        return false;
      }
    },
    taskTimeoutMilliseconds,
    "beacon ls task result",
  );

  const task = await context.client.fetchBeaconTask(queued.id, rpcTimeoutSeconds);
  assert.equal(task.ID, queued.id, "beacon ls fetched task ID");
  assert.equal(task.BeaconID, beaconId, "beacon ls fetched beacon ID");
  assert.equal(task.State, "completed", "beacon ls task state");
  assert.ok(BigInt(task.SentAt) > 0n, "beacon ls sent timestamp");
  assert.ok(BigInt(task.CompletedAt) > 0n, "beacon ls completion timestamp");
  return { task, response: sliverScript.sliverpb.Ls.decode(task.Response) };
}

function assertResponseOk(response: commonpb.Response | undefined, label: string): void {
  assert.equal(response?.Err ?? "", "", `${label} error`);
}

async function assertSamePath(actual: string, expected: string, label: string): Promise<void> {
  assert.equal(await canonicalPath(actual), await canonicalPath(expected), label);
}

async function canonicalPath(value: string): Promise<string> {
  const original = path.resolve(value);
  let ancestor = original;
  const missingSegments: string[] = [];
  while (true) {
    try {
      const canonicalAncestor = await realpath(ancestor);
      const canonical = path.normalize(path.join(canonicalAncestor, ...missingSegments));
      return process.platform === "win32" ? canonical.toLowerCase() : canonical;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        const normalized = path.normalize(original);
        return process.platform === "win32" ? normalized.toLowerCase() : normalized;
      }
      missingSegments.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

function assertWithinRoot(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  assert.ok(
    relative && relative !== ".." && !relative.startsWith(`..${path.sep}`),
    `beacon filesystem path must remain inside fixture root: ${candidate}`,
  );
  assert.equal(path.isAbsolute(relative), false, `beacon filesystem path must not escape its root: ${candidate}`);
}

async function assertMissing(targetPath: string, label: string): Promise<void> {
  try {
    await stat(targetPath);
    assert.fail(`${label} still exists at ${targetPath}`);
  } catch (error) {
    assert.equal((error as NodeJS.ErrnoException).code, "ENOENT", `${label} stat error`);
  }
}

function assertCompletedHistoryTask(history: clientpb.BeaconTasks, taskId: string): void {
  const summary = history.Tasks.find((task) => task.ID === taskId);
  assert.ok(summary, `beacon filesystem task history must contain ${taskId}`);
  assert.equal(summary.State, "completed", `${taskId} history state`);
  assert.equal(summary.Request.length, 0, `${taskId} history request bytes must be omitted`);
  assert.equal(summary.Response.length, 0, `${taskId} history response bytes must be omitted`);
}
