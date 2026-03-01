import * as fs from "node:fs";
import * as path from "node:path";

type SliverScriptModule = typeof import("..");

function findRepoRoot(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return undefined;
}

function guessRepoRoot(): string {
  return findRepoRoot(process.cwd()) ?? findRepoRoot(__dirname) ?? process.cwd();
}

function loadLocalSliverScript(repoRoot: string): SliverScriptModule {
  const libDir = path.join(repoRoot, "lib");
  const entry = path.join(libDir, "index.js");
  if (!fs.existsSync(entry)) {
    throw new Error(`Missing built library entrypoint: ${entry}. Run: npm run build`);
  }

  // CJS build; load via require for compatibility with `tsc --module commonjs`.
  return require(libDir) as SliverScriptModule;
}

const REPO_ROOT = guessRepoRoot();
const CONFIG_PATH = process.env.SLIVER_CONFIG_FILE ?? path.join(REPO_ROOT, "localhost.cfg");
const WAIT_TASKS = process.env.SLIVER_WAIT_TASKS === "1";

async function main() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Missing config file: ${CONFIG_PATH}`);
    process.exit(2);
  }

  const sliver = loadLocalSliverScript(REPO_ROOT);
  const config = await sliver.ParseConfigFile(CONFIG_PATH);
  const client = new sliver.SliverClient(config);

  await client.connect();
  try {
    const version = await client.getVersion();
    console.log("version", `${version.Major}.${version.Minor}.${version.Patch}`, version.Commit);

    const operators = await client.operators();
    console.log("operators", operators.map((o) => o.Name));

    const sessions = await client.sessions();
    console.log("sessions", sessions.length);

    const beacons = await client.beacons();
    console.log("beacons", beacons.length);

    if (beacons.length > 0) {
      const beacon = client.interactBeacon(beacons[0].ID);
      const task = await beacon.lsTask(".");
      console.log("beacon ls queued", task.id);

      if (WAIT_TASKS) {
        try {
          const ls = await task.wait(60);
          console.log("beacon ls result", { path: ls.Path, count: ls.Files.length });
        } catch (err) {
          console.error("beacon ls wait failed", err);
        }
      }
    }
  } finally {
    await client.disconnect();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
