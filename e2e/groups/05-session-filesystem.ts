import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { E2ESuiteContext, LiveImplant } from "../context";

export const name = "05-session-filesystem";

const RPC_TIMEOUT_SECONDS = 120;
const SEED_CONTENT = "alpha\nbeta\ngamma\n";
const CHILD_CONTENT = "child-marker\n";

export async function run(context: E2ESuiteContext): Promise<void> {
  const implant = requireSession(context);
  const sessionId = implant.session!.ID;
  const root = implant.root;
  const knownDir = path.join(root, "known");
  const nestedDir = path.join(knownDir, "nested");
  const seedPath = path.join(knownDir, "seed.txt");
  const childPath = path.join(nestedDir, "child.txt");
  const workRoot = path.join(root, "work");
  const workDir = path.join(workRoot, "one", "two");
  const uploadDir = path.join(root, "uploaded-tree");
  const sentinelPath = path.join(root, "outside-test-sentinel.txt");

  for (const candidate of [knownDir, nestedDir, seedPath, childPath, workRoot, workDir, uploadDir, sentinelPath]) {
    assertWithinRoot(root, candidate);
  }

  const pwd = await context.client.pwdSession(sessionId, RPC_TIMEOUT_SECONDS);
  assertImplantSuccess(pwd, "session pwd");
  assert.equal(await pathsEqual(pwd.Path, root), true, "initial session working directory");

  const mkdir = await context.client.mkdirSession(sessionId, workDir, RPC_TIMEOUT_SECONDS);
  assertImplantSuccess(mkdir, "session mkdir");
  assert.equal(await pathsEqual(mkdir.Path, workDir), true, "created directory path");
  assert.equal((await stat(workDir)).isDirectory(), true, "nested work directory must exist");

  await verifyListings(context, sessionId, knownDir);
  await verifyInteractiveFilesystem(context, sessionId, root);
  await verifyChangeDirectory(context, sessionId, root, knownDir, nestedDir);
  await verifyUploads(context, sessionId, root, uploadDir);
  await verifyDownloads(context, sessionId, seedPath);
  await verifyGrep(context, sessionId, seedPath, childPath, knownDir);

  const copiedPath = path.join(workRoot, "copied.txt");
  const movedPath = path.join(workRoot, "moved.txt");
  assertWithinRoot(root, copiedPath);
  assertWithinRoot(root, movedPath);

  const copied = await context.client.cpSession(sessionId, childPath, copiedPath, RPC_TIMEOUT_SECONDS);
  assertImplantSuccess(copied, "session copy");
  assert.equal(copied.BytesWritten, String(Buffer.byteLength(CHILD_CONTENT)), "copied byte count");
  assert.equal(await readFile(copiedPath, "utf8"), CHILD_CONTENT, "copied file contents");

  const moved = await context.client.mvSession(sessionId, copiedPath, movedPath, RPC_TIMEOUT_SECONDS);
  assertImplantSuccess(moved, "session move");
  assert.equal(await exists(copiedPath), false, "move source must be absent");
  assert.equal(await readFile(movedPath, "utf8"), CHILD_CONTENT, "moved file contents");

  const fixtureTime = 1_700_000_123;
  const changedTimes = await context.client.chtimesSession(
    sessionId,
    movedPath,
    String(fixtureTime),
    String(fixtureTime),
    RPC_TIMEOUT_SECONDS,
  );
  assertImplantSuccess(changedTimes, "session chtimes");
  const changedStat = await stat(movedPath);
  assert.equal(Math.trunc(changedStat.mtimeMs / 1_000), fixtureTime, "file modification time");
  assert.equal(Math.trunc(changedStat.atimeMs / 1_000), fixtureTime, "file access time");

  if (process.platform !== "win32") {
    await verifyUnixMetadata(context, sessionId, nestedDir, childPath);
  }

  const removedFile = await context.client.rmSession(sessionId, movedPath, false, false, RPC_TIMEOUT_SECONDS);
  assertImplantSuccess(removedFile, "session remove file");
  assert.equal(await exists(movedPath), false, "removed file must be absent");

  const removedUpload = await context.client.rmSession(sessionId, uploadDir, true, true, RPC_TIMEOUT_SECONDS);
  assertImplantSuccess(removedUpload, "session remove uploaded directory");
  assert.equal(await exists(uploadDir), false, "removed uploaded directory must be absent");

  const removedWork = await context.client.rmSession(sessionId, workRoot, true, true, RPC_TIMEOUT_SECONDS);
  assertImplantSuccess(removedWork, "session remove work directory");
  assert.equal(await exists(workRoot), false, "removed work directory must be absent");
  assert.equal(await readFile(sentinelPath, "utf8"), "must-survive\n", "fixture sentinel must survive deletion tests");
}

async function verifyInteractiveFilesystem(
  context: E2ESuiteContext,
  sessionId: string,
  root: string,
): Promise<void> {
  const commands = context.client.interactSession(sessionId);
  const directory = path.join(root, "interactive-facade");
  const filePath = path.join(directory, "round-trip.txt");
  const payload = Buffer.from("interactive session round trip\n", "utf8");
  assertWithinRoot(root, directory);
  assertWithinRoot(root, filePath);

  const made = await commands.mkdir(directory, RPC_TIMEOUT_SECONDS);
  assertImplantSuccess(made, "interactive session mkdir");
  const changed = await commands.cd(directory, RPC_TIMEOUT_SECONDS);
  assertImplantSuccess(changed, "interactive session cd");
  assert.equal(await pathsEqual(changed.Path, directory), true, "interactive session cd path");
  const pwd = await commands.pwd(RPC_TIMEOUT_SECONDS);
  assertImplantSuccess(pwd, "interactive session pwd");
  assert.equal(await pathsEqual(pwd.Path, directory), true, "interactive session pwd path");

  const uploaded = await commands.upload(filePath, payload, RPC_TIMEOUT_SECONDS);
  assertImplantSuccess(uploaded, "interactive session upload");
  assert.deepEqual(payload, Buffer.from("interactive session round trip\n"), "interactive upload caller bytes");
  const listed = await commands.ls(directory, RPC_TIMEOUT_SECONDS);
  assertImplantSuccess(listed, "interactive session ls");
  assert.ok(listed.Files.some((file) => file.Name === "round-trip.txt"), "interactive session listed upload");
  const downloaded = await commands.download(filePath, RPC_TIMEOUT_SECONDS);
  assert.deepEqual(downloaded, payload, "interactive session download round trip");

  const restored = await commands.cd(root, RPC_TIMEOUT_SECONDS);
  assertImplantSuccess(restored, "restore interactive session cwd");
  const removed = await commands.rm(directory, true, true, RPC_TIMEOUT_SECONDS);
  assertImplantSuccess(removed, "interactive session remove fixture");
  assert.equal(await exists(directory), false, "interactive session fixture must be removed");
}

async function verifyListings(
  context: E2ESuiteContext,
  sessionId: string,
  knownDir: string,
): Promise<void> {
  const directory = await context.client.lsSession(sessionId, knownDir, RPC_TIMEOUT_SECONDS);
  assertImplantSuccess(directory, "session directory listing");
  assert.equal(directory.Exists, true, "known directory must exist");
  assert.ok(directory.Files.some((file) => file.Name === "seed.txt" && !file.IsDir), "directory listing seed file");
  assert.ok(directory.Files.some((file) => file.Name === "nested" && file.IsDir), "directory listing nested directory");

  const wildcard = await context.client.lsSession(
    sessionId,
    path.join(knownDir, "*.txt"),
    RPC_TIMEOUT_SECONDS,
  );
  assertImplantSuccess(wildcard, "session wildcard listing");
  assert.equal(wildcard.Files.length, 1, "wildcard listing count");
  assert.equal(wildcard.Files[0]?.Name, "seed.txt", "wildcard listing file name");
  assert.equal(wildcard.Files[0]?.Size, String(Buffer.byteLength(SEED_CONTENT)), "wildcard listing file size");
}

async function verifyChangeDirectory(
  context: E2ESuiteContext,
  sessionId: string,
  root: string,
  knownDir: string,
  nestedDir: string,
): Promise<void> {
  try {
    const relative = await context.client.cdSession(
      sessionId,
      path.join("known", "nested"),
      RPC_TIMEOUT_SECONDS,
    );
    assertImplantSuccess(relative, "session relative cd");
    assert.equal(await pathsEqual(relative.Path, nestedDir), true, "relative cd path");

    const parent = await context.client.cdSession(sessionId, "..", RPC_TIMEOUT_SECONDS);
    assertImplantSuccess(parent, "session parent cd");
    assert.equal(await pathsEqual(parent.Path, knownDir), true, "parent cd path");

    await assert.rejects(
      context.client.cdSession(
        sessionId,
        path.join(root, "does-not-exist"),
        RPC_TIMEOUT_SECONDS,
      ),
      (error: unknown) => {
        assert.match(String(error), /FAILED_PRECONDITION/u, "missing-directory cd status");
        assert.match(String(error), /does-not-exist/u, "missing-directory cd path");
        return true;
      },
      "cd to a missing path must fail",
    );
    const afterFailure = await context.client.pwdSession(sessionId, RPC_TIMEOUT_SECONDS);
    assertImplantSuccess(afterFailure, "pwd after failed session cd");
    assert.equal(await pathsEqual(afterFailure.Path, knownDir), true, "failed cd must preserve working directory");
  } finally {
    const restored = await context.client.cdSession(sessionId, root, RPC_TIMEOUT_SECONDS);
    assertImplantSuccess(restored, "restore session working directory");
    assert.equal(await pathsEqual(restored.Path, root), true, "restored session working directory");
  }
}

async function verifyUploads(
  context: E2ESuiteContext,
  sessionId: string,
  root: string,
  uploadDir: string,
): Promise<void> {
  const uploadedPath = path.join(root, "work", "uploaded.txt");
  assertWithinRoot(root, uploadedPath);
  const first = Buffer.from("first upload payload with more bytes\n");
  const firstUpload = await context.client.uploadSession(
    sessionId,
    path.dirname(uploadedPath),
    first,
    { fileName: path.basename(uploadedPath), overwrite: false },
    RPC_TIMEOUT_SECONDS,
  );
  assertImplantSuccess(firstUpload, "session first file upload");
  assert.equal(firstUpload.WrittenFiles, 1, "first upload written file count");
  assert.equal(firstUpload.UnwriteableFiles, 0, "first upload unwriteable file count");

  const replacement = Buffer.from("short\n");
  const overwrite = await context.client.uploadSession(
    sessionId,
    uploadedPath,
    replacement,
    { fileName: path.basename(uploadedPath), overwrite: true },
    RPC_TIMEOUT_SECONDS,
  );
  assertImplantSuccess(overwrite, "session overwrite file upload");
  assert.equal(overwrite.WrittenFiles, 1, "overwrite written file count");
  assert.equal(await readFile(uploadedPath, "utf8"), replacement.toString(), "overwritten file contents");

  const initialTree = makeTar({
    "bundle/item.txt": Buffer.from("this is deliberately longer than the replacement\n"),
    "bundle/nested/child.txt": Buffer.from("directory-upload-child\n"),
  });
  const directoryUpload = await context.client.uploadSession(
    sessionId,
    uploadDir,
    initialTree,
    { isDirectory: true, overwrite: false },
    RPC_TIMEOUT_SECONDS,
  );
  assertImplantSuccess(directoryUpload, "session directory upload");
  assert.equal(directoryUpload.WrittenFiles, 2, "directory upload written file count");
  assert.equal(directoryUpload.UnwriteableFiles, 0, "directory upload unwriteable file count");

  const directoryReplacement = Buffer.from("short\n");
  const overwriteTree = await context.client.uploadSession(
    sessionId,
    uploadDir,
    makeTar({ "bundle/item.txt": directoryReplacement }),
    { isDirectory: true, overwrite: true },
    RPC_TIMEOUT_SECONDS,
  );
  assertImplantSuccess(overwriteTree, "session directory overwrite");
  assert.equal(overwriteTree.WrittenFiles, 1, "directory overwrite written file count");
  assert.equal(
    await readFile(path.join(uploadDir, "bundle", "item.txt"), "utf8"),
    directoryReplacement.toString(),
    "directory overwrite must truncate stale bytes",
  );
}

async function verifyDownloads(
  context: E2ESuiteContext,
  sessionId: string,
  seedPath: string,
): Promise<void> {
  const full = await context.client.downloadFileSession(sessionId, seedPath, {}, RPC_TIMEOUT_SECONDS);
  assertImplantSuccess(full, "session full file download");
  assert.equal(full.Exists, true, "downloaded file must exist");
  assert.equal(full.IsDir, false, "downloaded path must be a file");
  assert.equal(full.Encoder, "", "download wrapper must decode the response");
  assert.equal(full.Data.toString(), SEED_CONTENT, "full download contents");

  const head = await context.client.downloadFileSession(
    sessionId,
    seedPath,
    { maxBytes: 5 },
    RPC_TIMEOUT_SECONDS,
  );
  assertImplantSuccess(head, "session bounded head download");
  assert.equal(head.Data.toString(), "alpha", "bounded head download");

  const tail = await context.client.downloadFileSession(
    sessionId,
    seedPath,
    { maxBytes: 6, fromEnd: true },
    RPC_TIMEOUT_SECONDS,
  );
  assertImplantSuccess(tail, "session bounded tail download");
  assert.equal(tail.Data.toString(), "gamma\n", "bounded tail download");

  const lines = await context.client.downloadFileSession(
    sessionId,
    seedPath,
    { maxLines: 2 },
    RPC_TIMEOUT_SECONDS,
  );
  assertImplantSuccess(lines, "session bounded line download");
  assert.equal(lines.Data.toString(), "alpha\nbeta\n", "bounded line download");
}

async function verifyGrep(
  context: E2ESuiteContext,
  sessionId: string,
  seedPath: string,
  childPath: string,
  knownDir: string,
): Promise<void> {
  const direct = await context.client.grepSession(
    sessionId,
    seedPath,
    "beta",
    { linesBefore: 1, linesAfter: 1 },
    RPC_TIMEOUT_SECONDS,
  );
  assertImplantSuccess(direct, "session direct grep");
  const directResult = await grepResultForPath(direct.Results, seedPath);
  assert.ok(directResult, "direct grep result path");
  assert.ok(
    directResult.FileResults.some((result) =>
      result.LineNumber === "2"
      && result.Positions.length > 0
      && result.Line.includes("beta")
      && arraysEqual(result.LinesBefore, ["alpha"])
      && arraysEqual(result.LinesAfter, ["gamma"])
    ),
    "direct grep must return exact match and context",
  );

  const recursive = await context.client.grepSession(
    sessionId,
    knownDir,
    "child-(marker|missing)",
    { recursive: true },
    RPC_TIMEOUT_SECONDS,
  );
  assertImplantSuccess(recursive, "session recursive grep");
  const recursiveResult = await grepResultForPath(recursive.Results, childPath);
  assert.ok(recursiveResult, "recursive grep result path");
  assert.ok(
    recursiveResult.FileResults.some((result) => result.LineNumber === "1" && result.Line.includes("child-marker")),
    "recursive grep exact child match",
  );
}

async function verifyUnixMetadata(
  context: E2ESuiteContext,
  sessionId: string,
  nestedDir: string,
  childPath: string,
): Promise<void> {
  const chmod = await context.client.chmodSession(
    sessionId,
    nestedDir,
    "0700",
    true,
    RPC_TIMEOUT_SECONDS,
  );
  assertImplantSuccess(chmod, "session recursive chmod");
  assert.equal((await stat(childPath)).mode & 0o777, 0o700, "recursive chmod file mode");

  const username = os.userInfo().username;
  const group = execFileSync("id", ["-gn"], { encoding: "utf8" }).trim();
  assert.ok(username, "current username for chown fixture");
  assert.ok(group, "current group for chown fixture");
  const chown = await context.client.chownSession(
    sessionId,
    nestedDir,
    username,
    group,
    true,
    RPC_TIMEOUT_SECONDS,
  );
  assertImplantSuccess(chown, "session recursive no-op chown");

  const expectedUid = process.getuid?.();
  const expectedGid = process.getgid?.();
  assert.notEqual(expectedUid, undefined, "current uid");
  assert.notEqual(expectedGid, undefined, "current gid");
  for (const candidate of [nestedDir, childPath]) {
    const metadata = await stat(candidate);
    assert.equal(metadata.uid, expectedUid, `chown uid for ${path.basename(candidate)}`);
    assert.equal(metadata.gid, expectedGid, `chown gid for ${path.basename(candidate)}`);
  }
}

function requireSession(context: E2ESuiteContext): LiveImplant {
  assert.ok(context.session, "listener/generation group must launch a session first");
  assert.ok(context.session.session, "session callback metadata is required");
  assert.ok(context.session.session.ID, "session callback ID is required");
  return context.session;
}

function assertImplantSuccess(
  response: { readonly Response?: { readonly Err: string } },
  label: string,
): void {
  assert.equal(response.Response?.Err ?? "", "", `${label} implant error`);
}

function assertWithinRoot(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`), `path must remain inside fixture root: ${candidate}`);
  assert.equal(path.isAbsolute(relative), false, `fixture path must not escape its root: ${candidate}`);
}

async function pathsEqual(left: string, right: string): Promise<boolean> {
  const normalize = async (candidate: string): Promise<string> => {
    let normalized = path.resolve(candidate);
    try {
      normalized = await realpath(normalized);
    } catch {
      // Some response paths are returned before a later operation creates them.
    }
    normalized = path.normalize(normalized);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return await normalize(left) === await normalize(right);
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function grepResultForPath<T>(results: Record<string, T>, expectedPath: string): Promise<T | undefined> {
  for (const [resultPath, result] of Object.entries(results)) {
    if (await pathsEqual(resultPath, expectedPath)) return result;
  }
  return undefined;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function makeTar(files: Readonly<Record<string, Buffer>>): Buffer {
  const chunks: Buffer[] = [];
  for (const name of Object.keys(files).sort()) {
    const normalized = name.replaceAll("\\", "/");
    assert.ok(!normalized.startsWith("/") && !normalized.includes("../"), `safe tar path: ${name}`);
    const data = files[name]!;
    const header = Buffer.alloc(512, 0);
    writeTarString(header, 0, 100, normalized);
    writeTarOctal(header, 100, 8, 0o600);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, data.length);
    writeTarOctal(header, 136, 12, 1_700_000_000);
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    writeTarString(header, 257, 6, "ustar\0");
    writeTarString(header, 263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    chunks.push(header, data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1_024));
  return Buffer.concat(chunks);
}

function writeTarString(target: Buffer, offset: number, length: number, value: string): void {
  const encoded = Buffer.from(value, "ascii");
  assert.ok(encoded.length <= length, `tar field must fit in ${length} bytes`);
  encoded.copy(target, offset);
}

function writeTarOctal(target: Buffer, offset: number, length: number, value: number): void {
  const encoded = `${value.toString(8).padStart(length - 1, "0")}\0`;
  writeTarString(target, offset, length, encoded);
}
