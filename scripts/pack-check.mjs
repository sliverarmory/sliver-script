import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "sliver-script-pack-check-"));
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
    || forbiddenFiles.includes(file)
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
  const installedManifest = JSON.parse(await readFile(join(installedPackage, "package.json"), "utf8"));
  if (installedManifest.dependencies?.["nice-grpc-common"] !== "^2.0.4") {
    throw new Error("Packed manifest does not declare the generated nice-grpc-common import");
  }
  const tarballShasum = createHash("sha1").update(await readFile(tarball)).digest("hex");
  if (entry.shasum !== tarballShasum) {
    throw new Error(`Packed tarball shasum mismatch: ${entry.shasum} != ${tarballShasum}`);
  }
  console.log(
    `Packed and loaded ${installedManifest.name}@${installedManifest.version} from a clean consumer ` +
      `(${files.size} files, ${entry.unpackedSize} unpacked bytes; ${tarballIntegrity}; ` +
      `CJS, ESM, strict nested TypeScript NodeNext, and production audit verified)`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
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
