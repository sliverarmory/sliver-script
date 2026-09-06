import { posix } from "node:path";

const PACKAGE_REPOSITORY = "https://github.com/sliverarmory/sliver-script.git";
const SLIVER_REPOSITORY = "https://github.com/BishopFox/sliver.git";
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const FORBIDDEN_CONSUMER_MARKERS = [
  /sliver-gui/iu,
  /authoritativeGui/u,
  /vendoredRoot/u,
  /guiOnlyOmissions/u,
  /provenanceManifest/u,
  /handwrittenOverlay/u,
  /vendor\/sliver-script/iu,
  /protocol\/sliver-script-(?:provenance|handwritten-overlay)/iu,
];

function requireCondition(condition, message) {
  if (!condition) throw new Error(`Invalid integration lock: ${message}`);
}

function requireRecord(value, label) {
  requireCondition(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
}

function requireExactKeys(value, expected, label) {
  requireRecord(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  requireCondition(JSON.stringify(actual) === JSON.stringify(wanted), `${label} has unexpected fields`);
}

function requireNonEmptyString(value, label) {
  requireCondition(typeof value === "string" && value.trim() === value && value.length > 0, `${label} must be a non-empty string`);
}

function requireCommit(value, label) {
  requireCondition(typeof value === "string" && COMMIT_PATTERN.test(value), `${label} must be a lowercase commit SHA`);
}

function requireSha256(value, label) {
  requireCondition(typeof value === "string" && SHA256_PATTERN.test(value), `${label} must be a lowercase SHA-256`);
}

function requireNormalizedPath(value, label) {
  requireNonEmptyString(value, label);
  requireCondition(
    !value.startsWith("/")
      && !value.includes("\\")
      && !value.split("/").some((part) => part === "." || part === ".." || part === "")
      && posix.normalize(value) === value,
    `${label} must be a normalized repository-relative path`,
  );
}

function requireSafePath(value, label, allowedAreas) {
  requireNormalizedPath(value, label);
  requireCondition(
    allowedAreas.some((area) => value === area || value.startsWith(`${area}/`)),
    `${label} is outside the generic package source areas`,
  );
}

function requireStringArray(value, label) {
  requireCondition(Array.isArray(value) && value.length > 0, `${label} must be a non-empty array`);
  const unique = new Set();
  for (const [index, entry] of value.entries()) {
    requireNonEmptyString(entry, `${label}[${index}]`);
    requireCondition(!unique.has(entry), `${label} must not contain duplicates`);
    unique.add(entry);
  }
}

export function validateIntegrationLock(lock, protobufLock) {
  const serializedLock = JSON.stringify([lock, protobufLock]);
  for (const marker of FORBIDDEN_CONSUMER_MARKERS) {
    requireCondition(!marker.test(serializedLock), `consumer-specific marker ${marker.source} is forbidden`);
  }
  requireExactKeys(
    lock,
    ["schemaVersion", "wrapper", "sliver", "importedPaths", "standaloneAdaptations", "standaloneOmissions"],
    "root",
  );
  requireCondition(lock.schemaVersion === 2, "schemaVersion must be 2");

  requireExactKeys(lock.wrapper, ["repository", "publishedBase", "integrationBase"], "wrapper");
  requireCondition(lock.wrapper.repository === PACKAGE_REPOSITORY, "wrapper repository must identify sliver-script");
  requireCommit(lock.wrapper.publishedBase, "wrapper.publishedBase");
  requireCommit(lock.wrapper.integrationBase, "wrapper.integrationBase");

  requireExactKeys(lock.sliver, ["repository", "sourceCommit", "protobufLock"], "sliver");
  requireCondition(lock.sliver.repository === SLIVER_REPOSITORY, "sliver repository must identify upstream Sliver");
  requireCommit(lock.sliver.sourceCommit, "sliver.sourceCommit");
  requireCondition(lock.sliver.protobufLock === "protobuf.lock.json", "sliver.protobufLock must identify protobuf.lock.json");

  requireExactKeys(protobufLock, ["schemaVersion", "source", "toolchain", "protobuf"], "protobuf lock root");
  requireCondition(protobufLock.schemaVersion === 1, "protobuf lock schemaVersion must be 1");

  requireExactKeys(protobufLock.source, ["repository", "commit", "tree"], "protobuf lock source");
  requireCondition(protobufLock.source.repository === SLIVER_REPOSITORY, "protobuf lock must identify upstream Sliver");
  requireCommit(protobufLock.source.commit, "protobuf lock source.commit");
  requireCommit(protobufLock.source.tree, "protobuf lock source.tree");
  requireCondition(protobufLock.source.repository === lock.sliver.repository, "Sliver repository must match protobuf.lock.json");
  requireCondition(protobufLock.source.commit === lock.sliver.sourceCommit, "Sliver commit must match protobuf.lock.json");

  requireExactKeys(protobufLock.toolchain, ["protoc", "tsProto"], "protobuf lock toolchain");
  requireNonEmptyString(protobufLock.toolchain.protoc, "protobuf lock toolchain.protoc");
  requireNonEmptyString(protobufLock.toolchain.tsProto, "protobuf lock toolchain.tsProto");

  requireExactKeys(
    protobufLock.protobuf,
    ["descriptorSetSha256", "files", "outputs", "pluginOptions"],
    "protobuf lock protobuf",
  );
  requireSha256(protobufLock.protobuf.descriptorSetSha256, "protobuf lock protobuf.descriptorSetSha256");
  requireCondition(
    Array.isArray(protobufLock.protobuf.files) && protobufLock.protobuf.files.length > 0,
    "protobuf lock protobuf.files must be a non-empty array",
  );
  requireCondition(
    Array.isArray(protobufLock.protobuf.outputs) && protobufLock.protobuf.outputs.length > 0,
    "protobuf lock protobuf.outputs must be a non-empty array",
  );
  requireStringArray(protobufLock.protobuf.pluginOptions, "protobuf lock protobuf.pluginOptions");

  requireStringArray(lock.importedPaths, "importedPaths");
  const referencedPaths = new Set([lock.sliver.protobufLock]);
  for (const [index, entry] of protobufLock.protobuf.files.entries()) {
    requireExactKeys(entry, ["path", "sha256"], `protobuf lock protobuf.files[${index}]`);
    requireNormalizedPath(entry.path, `protobuf lock protobuf.files[${index}].path`);
    requireCondition(entry.path.endsWith(".proto"), `protobuf lock protobuf.files[${index}].path must end in .proto`);
    requireSha256(entry.sha256, `protobuf lock protobuf.files[${index}].sha256`);
  }
  for (const [index, entry] of protobufLock.protobuf.outputs.entries()) {
    requireExactKeys(entry, ["path", "sha256"], `protobuf lock protobuf.outputs[${index}]`);
    requireNormalizedPath(entry.path, `protobuf lock protobuf.outputs[${index}].path`);
    requireCondition(entry.path.endsWith(".ts"), `protobuf lock protobuf.outputs[${index}].path must end in .ts`);
    requireSha256(entry.sha256, `protobuf lock protobuf.outputs[${index}].sha256`);
    referencedPaths.add(`src/pb/${entry.path}`);
  }
  for (const [index, sourcePath] of lock.importedPaths.entries()) {
    requireSafePath(sourcePath, `importedPaths[${index}]`, ["src"]);
    referencedPaths.add(sourcePath);
  }

  requireCondition(
    Array.isArray(lock.standaloneAdaptations) && lock.standaloneAdaptations.length > 0,
    "standaloneAdaptations must be a non-empty array",
  );
  for (const [index, adaptation] of lock.standaloneAdaptations.entries()) {
    requireExactKeys(adaptation, ["paths", "reason"], `standaloneAdaptations[${index}]`);
    requireStringArray(adaptation.paths, `standaloneAdaptations[${index}].paths`);
    requireNonEmptyString(adaptation.reason, `standaloneAdaptations[${index}].reason`);
    for (const [pathIndex, sourcePath] of adaptation.paths.entries()) {
      requireSafePath(
        sourcePath,
        `standaloneAdaptations[${index}].paths[${pathIndex}]`,
        ["src", "scripts", ".github/workflows"],
      );
      referencedPaths.add(sourcePath);
    }
  }

  requireStringArray(lock.standaloneOmissions, "standaloneOmissions");
  return { referencedPaths: [...referencedPaths].sort() };
}
