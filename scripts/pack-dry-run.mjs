import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("Missing npm_execpath; run this check through npm");
}
const temporary = await mkdtemp(join(tmpdir(), "sliver-script-pack-dry-run-"));

try {
  execFileSync(process.execPath, [npmCli, "pack", ".", "--dry-run"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      npm_config_cache: join(temporary, "npm-cache"),
      npm_config_update_notifier: "false",
    },
    stdio: "inherit",
  });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
