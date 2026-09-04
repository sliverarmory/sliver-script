import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const retainedPackDestination = parsePackDestination(process.argv.slice(2));
const temporary = retainedPackDestination
  ?? await mkdtemp(join(tmpdir(), "sliver-script-pack-check-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const requiredFiles = [
  "LICENSE",
  "README.md",
  "integration.lock.json",
  "package.json",
  "protobuf.lock.json",
  "protobuf.sh",
  "tsconfig.json",
  "scripts/clean.mjs",
  "scripts/pack-check.mjs",
  "scripts/pack-dry-run.mjs",
  "scripts/pack-receipt-check.mjs",
  "scripts/protobuf.mjs",
  "scripts/publish-order-check.mjs",
  "scripts/registry-provenance-check.mjs",
  "lib/index.js",
  "lib/index.d.ts",
  "lib/internal/wgProxy.js",
  "lib/internal/wgProxy.d.ts",
  "src/index.ts",
  "src/internal/wgProxy.ts",
  "wireguard-proxy/main.go",
  "wireguard-proxy/main_test.go",
  "wireguard-proxy/netstack.go",
  "wireguard-proxy/go.mod",
  "wireguard-proxy/go.sum",
];
const forbiddenPrefixes = [
  "docs/",
  "e2e/",
  "examples/",
  "lib/tests/",
  "node_modules/",
  "sliver/",
  "src/tests/",
];

try {
  if (retainedPackDestination !== null) {
    await mkdir(temporary, { recursive: true });
    const existing = await readdir(temporary);
    if (existing.length !== 0) {
      throw new Error(`Pack destination must be empty: ${temporary}`);
    }
  }

  const packOutput = execFileSync(
    npm,
    ["pack", ".", "--json", "--ignore-scripts", "--pack-destination", temporary],
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
    || file.includes("/__snapshots__/")
    || file.endsWith(".snap")
  );
  if (missing.length !== 0 || forbidden.length !== 0) {
    throw new Error(JSON.stringify({ missing, forbidden }, null, 2));
  }

  const tarball = join(temporary, entry.filename);
  if (!existsSync(tarball)) {
    throw new Error(`npm pack did not create ${tarball}`);
  }
  const tarballIntegrity = `sha512-${createHash("sha512")
    .update(await readFile(tarball))
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
    npm,
    [
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
  execFileSync(npm, ["audit", "--omit=dev"], {
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
  for (const helperFile of ["main.go", "main_test.go", "netstack.go", "go.mod", "go.sum"]) {
    const installedPath = join(installedPackage, "wireguard-proxy", helperFile);
    if (!existsSync(installedPath)) {
      throw new Error(`Installed package is missing ${installedPath}`);
    }
  }

  const installedHelper = join(installedPackage, "wireguard-proxy");
  const helperRuntimeTemp = join(temporary, "helper-runtime-temp");
  await mkdir(helperRuntimeTemp, { recursive: true });
  const helperEnvironment = {
    ...process.env,
    CGO_ENABLED: "0",
    GOCACHE: join(temporary, "go-build-cache"),
    GOMODCACHE: join(temporary, "go-module-cache"),
    // The test owns and removes this disposable module cache. Writable module
    // files keep that cleanup reliable on Windows; production source builds do
    // not set this flag and retain Go's read-only shared-cache default.
    GOFLAGS: "-modcacherw",
    GOTOOLCHAIN: "local",
    GOWORK: "off",
    TMPDIR: helperRuntimeTemp,
    TEMP: helperRuntimeTemp,
    TMP: helperRuntimeTemp,
  };
  for (const key of Object.keys(helperEnvironment)) {
    if (key.toUpperCase() === "SLIVER_SCRIPT_WG_PROXY_BINARY") {
      delete helperEnvironment[key];
    }
  }
  execFileSync("go", ["test", "./..."], {
    cwd: installedHelper,
    env: helperEnvironment,
    stdio: "inherit",
    timeout: 300_000,
  });
  const helperBinary = join(
    temporary,
    process.platform === "win32" ? "sliver-script-wgproxy.exe" : "sliver-script-wgproxy",
  );
  execFileSync("go", ["build", "-o", helperBinary, "."], {
    cwd: installedHelper,
    env: helperEnvironment,
    stdio: "inherit",
    timeout: 300_000,
  });
  if (!existsSync(helperBinary)) {
    throw new Error(`Installed WireGuard helper did not build ${helperBinary}`);
  }

  execFileSync(
    process.execPath,
    [
      "-e",
      [
        "const { randomBytes } = require('node:crypto')",
        "const { startWireGuardProxy } = require('sliver-script/lib/internal/wgProxy')",
        ";(async () => {",
        "  const session = await startWireGuardProxy({",
        "    operator: 'pack-check',",
        "    lhost: '127.0.0.1',",
        "    lport: 9,",
        "    ca_certificate: 'not-forwarded',",
        "    certificate: 'not-forwarded',",
        "    private_key: 'not-forwarded',",
        "    token: 'not-forwarded',",
        "    wg: {",
        "      enabled: true,",
        "      server_pub_key: randomBytes(32).toString('hex'),",
        "      client_private_key: randomBytes(32).toString('hex'),",
        "      client_ip: '100.65.0.2',",
        "      server_ip: '100.65.0.1',",
        "    },",
        "  })",
        "  try {",
        "    if (!/^127\\.0\\.0\\.1:[1-9][0-9]*$/.test(session.rpcHost())) {",
        "      throw new Error(`Invalid installed helper endpoint: ${session.rpcHost()}`)",
        "    }",
        "  } finally {",
        "    await session.stop()",
        "  }",
        "})().catch((error) => { console.error(error); process.exitCode = 1 })",
      ].join("\n"),
    ],
    {
      cwd: consumer,
      env: { ...helperEnvironment, GOFLAGS: "" },
      stdio: "inherit",
      timeout: 180_000,
    },
  );
  const runtimeLeftovers = (await readdir(helperRuntimeTemp))
    .filter((file) => file.startsWith("sliver-script-wgproxy-"));
  if (runtimeLeftovers.length !== 0) {
    throw new Error(`Installed WireGuard resolver left private build directories: ${runtimeLeftovers.join(", ")}`);
  }

  const installedManifest = JSON.parse(await readFile(join(installedPackage, "package.json"), "utf8"));
  if (installedManifest.dependencies?.["nice-grpc-common"] !== "^2.0.2") {
    throw new Error("Packed manifest does not declare the generated nice-grpc-common import");
  }
  const tarballShasum = createHash("sha1").update(await readFile(tarball)).digest("hex");
  if (entry.shasum !== tarballShasum) {
    throw new Error(`Packed tarball shasum mismatch: ${entry.shasum} != ${tarballShasum}`);
  }
  if (retainedPackDestination !== null) {
    await writeFile(
      join(temporary, "pack-receipt.json"),
      `${JSON.stringify({
        name: installedManifest.name,
        version: installedManifest.version,
        sourceCommit: process.env.GITHUB_SHA ?? null,
        filename: entry.filename,
        integrity: tarballIntegrity,
        shasum: tarballShasum,
        size: entry.size,
        unpackedSize: entry.unpackedSize,
        fileCount: files.size,
      }, null, 2)}\n`,
    );
  }
  console.log(
    `Packed and loaded ${installedManifest.name}@${installedManifest.version} from a clean consumer ` +
      `(${files.size} files, ${entry.unpackedSize} unpacked bytes; ${tarballIntegrity}; ` +
      `CJS, ESM, strict nested TypeScript NodeNext, production audit, and helper runtime verified)`,
  );
} finally {
  if (retainedPackDestination === null) {
    await rm(temporary, { recursive: true, force: true });
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

function parsePackDestination(args) {
  if (args.length === 0) return null;
  if (args.length !== 2 || args[0] !== "--pack-destination" || args[1].trim() === "") {
    throw new Error("Usage: node scripts/pack-check.mjs [--pack-destination DIRECTORY]");
  }
  return resolve(args[1]);
}
