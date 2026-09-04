import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(await readFile(join(repositoryRoot, "protobuf.lock.json"), "utf8"));
const mode = parseMode(process.argv.slice(2));
const sourceRoot = join(repositoryRoot, "sliver");
const protobufRoot = join(sourceRoot, "protobuf");
const checkedOutput = join(repositoryRoot, "src/pb");
const plugin = process.platform === "win32"
  ? join(repositoryRoot, "node_modules/.bin/protoc-gen-ts_proto.cmd")
  : join(repositoryRoot, "node_modules/ts-proto/protoc-gen-ts_proto");
const protocCommand = process.env.SLIVER_SCRIPT_PROTOC || "protoc";
const temporary = await mkdtemp(join(tmpdir(), "sliver-script-protobuf-"));

try {
  verifySource();
  await verifyInputs();
  await verifyToolchain();

  const generatedOutput = join(temporary, "pb");
  const descriptorPath = join(temporary, "sliver.pb");
  await mkdir(generatedOutput, { recursive: true });

  const protoFiles = lock.protobuf.files.map((entry) => entry.path);
  execFileSync(
    protocCommand,
    [
      "-I",
      protobufRoot,
      `--plugin=protoc-gen-ts_proto=${plugin}`,
      `--ts_proto_out=${generatedOutput}`,
      `--ts_proto_opt=${lock.protobuf.pluginOptions.join(",")}`,
      ...protoFiles,
    ],
    { cwd: protobufRoot, stdio: "inherit" },
  );
  execFileSync(
    protocCommand,
    ["-I", protobufRoot, "--include_imports", `--descriptor_set_out=${descriptorPath}`, ...protoFiles],
    { cwd: protobufRoot, stdio: "inherit" },
  );

  const descriptorDigest = sha256(await readFile(descriptorPath));
  if (descriptorDigest !== lock.protobuf.descriptorSetSha256) {
    throw new Error(
      `Semantic descriptor drift: expected ${lock.protobuf.descriptorSetSha256}, received ${descriptorDigest}`,
    );
  }

  const expectedPaths = lock.protobuf.outputs.map((entry) => entry.path).sort();
  const generatedPaths = (await listFiles(generatedOutput)).sort();
  if (JSON.stringify(generatedPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(JSON.stringify({ expectedPaths, generatedPaths }, null, 2));
  }
  const checkedPaths = (await listFiles(checkedOutput)).sort();
  if (mode === "check" && JSON.stringify(checkedPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(JSON.stringify({ expectedPaths, checkedPaths }, null, 2));
  }

  const drift = [];
  for (const expected of lock.protobuf.outputs) {
    const generatedData = await readFile(join(generatedOutput, expected.path));
    const generatedDigest = sha256(generatedData);
    if (generatedDigest !== expected.sha256) {
      drift.push({ path: expected.path, expected: expected.sha256, generated: generatedDigest });
      continue;
    }

    let checkedData;
    try {
      checkedData = await readFile(join(checkedOutput, expected.path));
    } catch {
      checkedData = Buffer.alloc(0);
    }
    if (!generatedData.equals(checkedData)) {
      drift.push({
        path: expected.path,
        expected: expected.sha256,
        generated: generatedDigest,
        checkedIn: sha256(checkedData),
      });
    }
  }

  const generatedIsLocked = drift.every((entry) => entry.generated === entry.expected);
  if (!generatedIsLocked) {
    throw new Error(`Generated protobuf output does not match protobuf.lock.json:\n${JSON.stringify(drift, null, 2)}`);
  }

  if (mode === "write") {
    await rm(checkedOutput, { recursive: true, force: true });
    for (const expected of lock.protobuf.outputs) {
      const destination = join(checkedOutput, expected.path);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(generatedOutput, expected.path), destination);
    }
  } else if (drift.length !== 0) {
    throw new Error(`Checked-in protobuf output drifted:\n${JSON.stringify(drift, null, 2)}`);
  }

  console.log(
    `${mode === "write" ? "Generated" : "Verified"} ${lock.protobuf.outputs.length} protobuf files ` +
      `from Sliver ${lock.source.commit} with protoc ${lock.toolchain.protoc} and ts-proto ${lock.toolchain.tsProto}`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function verifySource() {
  if (!existsSync(join(sourceRoot, "go.mod"))) {
    throw new Error("Missing pinned Sliver submodule; run: git submodule update --init --recursive");
  }
  const commit = git(["rev-parse", "HEAD"]);
  const tree = git(["rev-parse", "HEAD^{tree}"]);
  if (commit !== lock.source.commit || tree !== lock.source.tree) {
    throw new Error(
      `Sliver source drift: expected ${lock.source.commit} (${lock.source.tree}), received ${commit} (${tree})`,
    );
  }
}

async function verifyInputs() {
  for (const input of lock.protobuf.files) {
    const digest = sha256(await readFile(join(protobufRoot, input.path)));
    if (digest !== input.sha256) {
      throw new Error(`Protobuf input drift for ${input.path}: expected ${input.sha256}, received ${digest}`);
    }
  }
}

async function verifyToolchain() {
  const protoc = commandOutput(protocCommand, ["--version"]).replace(/^libprotoc\s+/u, "");
  if (protoc !== lock.toolchain.protoc) {
    throw new Error(`protoc drift: expected ${lock.toolchain.protoc}, received ${protoc}`);
  }
  if (!existsSync(plugin)) {
    throw new Error("Missing locked ts-proto generator; run: npm ci");
  }
  const tsProto = JSON.parse(
    await readFile(join(repositoryRoot, "node_modules/ts-proto/package.json"), "utf8"),
  ).version;
  if (tsProto !== lock.toolchain.tsProto) {
    throw new Error(`ts-proto drift: expected ${lock.toolchain.tsProto}, received ${tsProto}`);
  }
}

async function listFiles(root, current = root) {
  const result = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await listFiles(root, path)));
    } else if (entry.isFile()) {
      result.push(relative(root, path).split(sep).join("/"));
    }
  }
  return result;
}

function git(args) {
  return commandOutput("git", ["-C", sourceRoot, ...args]);
}

function commandOutput(command, args) {
  return execFileSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function parseMode(args) {
  if (args.length !== 1 || !["--check", "--write"].includes(args[0])) {
    throw new Error("Usage: node scripts/protobuf.mjs --check|--write");
  }
  return args[0].slice(2);
}
