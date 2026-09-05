import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "sliver-script-pack-dry-run-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

try {
  execFileSync(npm, ["pack", ".", "--dry-run"], {
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
