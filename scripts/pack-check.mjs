import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { validateIntegrationLock } from "./integration-lock.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputArgument = parseArguments(process.argv.slice(2));
const outputDirectory = outputArgument === undefined
  ? undefined
  : await validateOutputDirectory(outputArgument);
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("Missing npm_execpath; run this check through npm");
}
const temporary = await mkdtemp(join(tmpdir(), "sliver-script-pack-check-"));

const requiredFiles = [
  "LICENSE",
  "README.md",
  "integration.lock.json",
  "package.json",
  "protobuf.lock.json",
  "protobuf.sh",
  "tsconfig.json",
  "scripts/clean.mjs",
  "scripts/integration-lock.mjs",
  "scripts/pack-check.mjs",
  "scripts/pack-dry-run.mjs",
  "scripts/protobuf.mjs",
  "lib/index.js",
  "lib/index.d.ts",
  "src/index.ts",
];
const forbiddenPrefixes = [
  "docs/",
  "examples/",
  "lib/tests/",
  "node_modules/",
  "scripts/npm-release/",
  "sliver/",
  "src/tests/",
  "wireguard-proxy/",
];
const forbiddenFiles = [
  "lib/internal/wgProxy.js",
  "lib/internal/wgProxy.d.ts",
  "lib/internal/wireGuardConfig.js",
  "lib/internal/wireGuardConfig.d.ts",
  "src/internal/wgProxy.ts",
  "src/internal/wireGuardConfig.ts",
];

try {
  const packOutput = execFileSync(
    process.execPath,
    [npmCli, "pack", ".", "--json", "--ignore-scripts", "--pack-destination", temporary],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: npmEnvironment(join(temporary, "npm-cache")),
      stdio: ["ignore", "pipe", "inherit"],
      timeout: 120_000,
    },
  );
  const packed = JSON.parse(packOutput);
  if (!Array.isArray(packed) || packed.length !== 1) {
    throw new Error(`Unexpected npm pack result: ${packOutput}`);
  }

  const entry = packed[0];
  const files = new Set(entry.files.map((file) => file.path));
  const sourceFiles = (await listFiles(join(repositoryRoot, "src")))
    .filter((file) => !file.startsWith("tests/"))
    .map((file) => `src/${file}`);
  const missing = [...requiredFiles, ...sourceFiles].filter((file) => !files.has(file));
  const forbidden = [...files].filter((file) =>
    forbiddenPrefixes.some((prefix) => file.startsWith(prefix))
    || forbiddenFiles.includes(file)
    || file.includes("/__snapshots__/")
    || file.endsWith(".snap")
  );
  const allowedMetadataFiles = new Set(["integration.lock.json", "protobuf.lock.json"]);
  const unexpectedMetadata = [...files].filter((file) =>
    (file.endsWith(".lock.json") || file.endsWith(".provenance.json"))
    && !allowedMetadataFiles.has(file)
  );
  if (missing.length !== 0 || forbidden.length !== 0 || unexpectedMetadata.length !== 0) {
    throw new Error(JSON.stringify({ missing, forbidden, unexpectedMetadata }, null, 2));
  }

  if (typeof entry.filename !== "string" || basename(entry.filename) !== entry.filename
      || !entry.filename.endsWith(".tgz")) {
    throw new Error(`Unexpected packed tarball filename: ${String(entry.filename)}`);
  }
  const tarball = join(temporary, entry.filename);
  if (!existsSync(tarball)) {
    throw new Error(`npm pack did not create ${tarball}`);
  }
  const tarballContents = await readFile(tarball);
  const tarballIntegrity = `sha512-${createHash("sha512")
    .update(tarballContents)
    .digest("base64")}`;
  if (entry.integrity !== tarballIntegrity) {
    throw new Error(`Packed tarball integrity mismatch: ${entry.integrity} != ${tarballIntegrity}`);
  }

  const consumer = join(temporary, "consumer");
  await mkdir(consumer, { recursive: true });
  await writeFile(
    join(consumer, "package.json"),
    `${JSON.stringify({
      name: "sliver-script-clean-consumer",
      version: "1.0.0",
      private: true,
      type: "module",
      devDependencies: {
        "@types/node": "22.19.13",
        typescript: "5.8.3",
      },
    }, null, 2)}\n`,
  );

  execFileSync(
    process.execPath,
    [
      npmCli,
      "install",
      tarball,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--install-strategy=nested",
    ],
    {
      cwd: consumer,
      env: npmEnvironment(join(temporary, "npm-cache")),
      stdio: "inherit",
      timeout: 300_000,
    },
  );
  if (!existsSync(join(consumer, "package-lock.json"))) {
    throw new Error("Clean packed consumer did not produce a package lock");
  }
  const consumerLock = JSON.parse(await readFile(join(consumer, "package-lock.json"), "utf8"));
  const lockedPackage = consumerLock.packages?.["node_modules/sliver-script"];
  if (lockedPackage?.integrity !== tarballIntegrity) {
    throw new Error(
      `Clean consumer locked unexpected package integrity: ${String(lockedPackage?.integrity)}`,
    );
  }
  execFileSync(process.execPath, [npmCli, "audit", "--omit=dev"], {
    cwd: consumer,
    env: npmEnvironment(join(temporary, "npm-cache")),
    stdio: "inherit",
    timeout: 120_000,
  });

  execFileSync(
    process.execPath,
    [
      "--input-type=commonjs",
      "-e",
      [
        "const library = require('sliver-script')",
        "for (const key of ['SliverClient', 'ParseConfigFile', 'clientpb']) {",
        "  if (!(key in library)) throw new Error(`Missing public export: ${key}`)",
        "}",
      ].join("\n"),
    ],
    { cwd: consumer, stdio: "inherit", timeout: 30_000 },
  );

  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        "const library = await import('sliver-script')",
        "for (const key of ['SliverClient', 'ParseConfigFile', 'clientpb']) {",
        "  if (!(key in library)) throw new Error(`Missing ESM public export: ${key}`)",
        "}",
      ].join("\n"),
    ],
    { cwd: consumer, stdio: "inherit", timeout: 30_000 },
  );

  await writeFile(
    join(consumer, "index.mts"),
    [
      'import * as library from "sliver-script";',
      "const Client: typeof library.SliverClient = library.SliverClient;",
      "const parse: typeof library.ParseConfigFile = library.ParseConfigFile;",
      "const messages: typeof library.clientpb = library.clientpb;",
      "void [Client, parse, messages];",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(consumer, "tsconfig.json"),
    `${JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        types: ["node"],
      },
      files: ["index.mts"],
    }, null, 2)}\n`,
  );
  execFileSync(
    process.execPath,
    [join(consumer, "node_modules", "typescript", "bin", "tsc"), "--project", "tsconfig.json"],
    { cwd: consumer, stdio: "inherit", timeout: 60_000 },
  );

  const installedPackage = join(consumer, "node_modules/sliver-script");
  const installedManifest = JSON.parse(await readFile(join(installedPackage, "package.json"), "utf8"));
  const expectedRuntimePins = new Map([
    ["@protobufjs/utf8", "1.1.2"],
    ["protobufjs", "7.6.6"],
  ]);
  for (const [dependency, version] of expectedRuntimePins) {
    if (installedManifest.dependencies?.[dependency] !== version) {
      throw new Error(`Packed manifest does not enforce ${dependency}@${version}`);
    }
  }
  const installedDependencyTree = JSON.parse(execFileSync(
    process.execPath,
    [npmCli, "ls", ...expectedRuntimePins.keys(), "--all", "--json"],
    {
      cwd: consumer,
      encoding: "utf8",
      env: npmEnvironment(join(temporary, "npm-cache")),
      stdio: ["ignore", "pipe", "inherit"],
      timeout: 30_000,
    },
  ));
  const resolvedRuntimeVersions = collectDependencyVersions(installedDependencyTree, expectedRuntimePins.keys());
  for (const [dependency, version] of expectedRuntimePins) {
    const resolved = [...(resolvedRuntimeVersions.get(dependency) ?? [])].sort();
    if (resolved.length !== 1 || resolved[0] !== version) {
      throw new Error(`Clean packed consumer resolved unexpected ${dependency} versions: ${resolved.join(", ")}`);
    }
  }
  const installedIntegrationLock = JSON.parse(
    await readFile(join(installedPackage, "integration.lock.json"), "utf8"),
  );
  const installedProtobufLock = JSON.parse(
    await readFile(join(installedPackage, "protobuf.lock.json"), "utf8"),
  );
  const { referencedPaths } = validateIntegrationLock(installedIntegrationLock, installedProtobufLock);
  const resolvedRepositoryRoot = await realpath(repositoryRoot);
  for (const referencedPath of referencedPaths) {
    const sourcePath = resolve(repositoryRoot, referencedPath);
    const sourceStat = await lstat(sourcePath).catch(() => undefined);
    if (!sourceStat || (!sourceStat.isFile() && !sourceStat.isDirectory()) || sourceStat.isSymbolicLink()) {
      throw new Error(`Integration lock references a missing or unsupported source path: ${referencedPath}`);
    }
    const resolvedSourcePath = await realpath(sourcePath);
    const fromRepository = relative(resolvedRepositoryRoot, resolvedSourcePath);
    if (fromRepository === ".." || fromRepository.startsWith(`..${sep}`) || isAbsolute(fromRepository)) {
      throw new Error(`Integration lock source path escapes the repository: ${referencedPath}`);
    }
  }
  if (installedManifest.dependencies?.["nice-grpc-common"] !== "^2.0.4") {
    throw new Error("Packed manifest does not declare the generated nice-grpc-common import");
  }
  const checkedTarballContents = await readFile(tarball);
  if (!checkedTarballContents.equals(tarballContents)) {
    throw new Error("Packed tarball changed during consumer validation");
  }
  const tarballShasum = createHash("sha1").update(checkedTarballContents).digest("hex");
  if (entry.shasum !== tarballShasum) {
    throw new Error(`Packed tarball shasum mismatch: ${entry.shasum} != ${tarballShasum}`);
  }
  if (outputDirectory !== undefined) {
    const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      timeout: 10_000,
    }).trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceSha)) {
      throw new Error(`Unexpected source commit: ${sourceSha}`);
    }
    await retainArtifact(outputDirectory, checkedTarballContents, {
      schemaVersion: 1,
      name: installedManifest.name,
      version: installedManifest.version,
      filename: entry.filename,
      integrity: tarballIntegrity,
      shasum: tarballShasum,
      sourceSha,
    });
    console.log(`Retained validated release artifact and metadata in ${outputDirectory}`);
  }
  console.log(
    `Packed and loaded ${installedManifest.name}@${installedManifest.version} from a clean consumer ` +
      `(${files.size} files, ${entry.unpackedSize} unpacked bytes; ${tarballIntegrity}; ` +
      `CJS, ESM, strict nested TypeScript NodeNext, and production audit verified)`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function parseArguments(args) {
  if (args.length === 0) return undefined;
  if (args.length !== 2 || args[0] !== "--output-dir" || !args[1]
      || args[1].startsWith("--")) {
    throw new Error("Usage: npm run pack:check -- [--output-dir <directory>]");
  }
  return args[1];
}

async function validateOutputDirectory(requested) {
  const absolute = resolve(requested);
  let ancestor = absolute;
  const missingComponents = [];
  let resolvedAncestor;
  for (;;) {
    try {
      resolvedAncestor = await realpath(ancestor);
      break;
    } catch (error) {
      if (error.code !== "ENOENT" || dirname(ancestor) === ancestor) throw error;
      missingComponents.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
  const destination = resolve(resolvedAncestor, ...missingComponents);
  const fromRepository = relative(await realpath(repositoryRoot), destination);
  if (fromRepository === ""
      || (fromRepository !== ".." && !fromRepository.startsWith(`..${sep}`)
        && !isAbsolute(fromRepository))) {
    throw new Error("Release output directory must be outside the repository");
  }
  await requireEmptyDirectory(destination);
  return destination;
}

async function requireEmptyDirectory(directory) {
  try {
    if ((await readdir(directory)).length !== 0) {
      throw new Error(`Release output directory must be empty: ${directory}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function retainArtifact(directory, tarballContents, metadata) {
  await mkdir(directory, { recursive: true });
  await requireEmptyDirectory(directory);
  const tarballPath = join(directory, metadata.filename);
  const createdFiles = [];
  async function writeExclusive(path, contents) {
    const handle = await open(path, "wx");
    createdFiles.push(path);
    try {
      await handle.writeFile(contents);
    } finally {
      await handle.close();
    }
  }
  try {
    await writeExclusive(tarballPath, tarballContents);
    await writeExclusive(join(directory, "release.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  } catch (error) {
    await Promise.allSettled(createdFiles.map((path) => rm(path, { force: true })));
    throw error;
  }
}

function npmEnvironment(cache) {
  return {
    ...process.env,
    npm_config_cache: cache,
    npm_config_update_notifier: "false",
  };
}

async function listFiles(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const entryPath = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath.slice(root.length + 1).replaceAll("\\", "/"));
    }
  }
  return files;
}

function collectDependencyVersions(tree, dependencyNames) {
  const names = new Set(dependencyNames);
  const versions = new Map([...names].map((name) => [name, new Set()]));
  function visit(node) {
    for (const [name, dependency] of Object.entries(node?.dependencies ?? {})) {
      if (names.has(name) && typeof dependency?.version === "string") {
        versions.get(name).add(dependency.version);
      }
      visit(dependency);
    }
  }
  visit(tree);
  return versions;
}
