import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createE2ESuiteContext, type E2ESuiteContext } from "./context";

interface E2EGroupModule {
  readonly name: string;
  run(context: E2ESuiteContext): Promise<void>;
}

interface GroupResult {
  readonly name: string;
  readonly status: "passed" | "failed";
  readonly durationMilliseconds: number;
}

async function collectGroups(): Promise<Array<{ name: string; path: string }>> {
  const groupDir = path.join(__dirname, "groups");
  const groups = (await readdir(groupDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^\d{2}-.+\.js$/u.test(entry.name))
    .map((entry) => ({ name: entry.name.slice(0, -3), path: path.join(groupDir, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name));

  const requested = (process.env.SLIVER_E2E_GROUPS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (requested.length === 0) return groups;

  const available = new Set(groups.map((group) => group.name));
  const unknown = requested.filter((name) => !available.has(name));
  assert.deepEqual(unknown, [], `Unknown E2E groups: ${unknown.join(", ")}`);
  const requestedSet = new Set(requested);
  return groups.filter((group) => requestedSet.has(group.name));
}

async function writeResults(context: E2ESuiteContext, results: GroupResult[]): Promise<void> {
  await writeFile(
    path.join(context.resultsDir, "group-results.json"),
    `${JSON.stringify(results, null, 2)}\n`,
    "utf8",
  );
}

async function main(): Promise<void> {
  const groups = await collectGroups();
  assert.ok(groups.length > 0, "No compiled E2E groups were selected");

  const context = await createE2ESuiteContext();
  const results: GroupResult[] = [];
  let failure: unknown;
  try {
    for (const group of groups) {
      const started = Date.now();
      console.log(`[suite] Running ${group.name}`);
      try {
        const module = require(group.path) as E2EGroupModule;
        assert.equal(module.name, group.name, `${group.name} exported name`);
        assert.equal(typeof module.run, "function", `${group.name} must export run(context)`);
        await module.run(context);
        results.push({ name: group.name, status: "passed", durationMilliseconds: Date.now() - started });
        await writeFile(path.join(context.resultsDir, `${group.name}.log`), "passed\n", "utf8");
        await writeResults(context, results);
        console.log(`[suite] Passed ${group.name}`);
      } catch (error) {
        const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
        const processDiagnostics = [context.session, context.beacon]
          .filter((implant) => implant !== undefined)
          .map((implant) => {
            const stdout = implant.stdout.slice(-8_000);
            const stderr = implant.stderr.slice(-8_000);
            return [
              `${implant.mode} process ${implant.pid}`,
              stdout ? `stdout tail:\n${stdout}` : "",
              stderr ? `stderr tail:\n${stderr}` : "",
            ].filter(Boolean).join("\n");
          })
          .join("\n\n");
        results.push({ name: group.name, status: "failed", durationMilliseconds: Date.now() - started });
        await writeFile(
          path.join(context.resultsDir, `${group.name}.log`),
          `${detail}${processDiagnostics ? `\n\n${processDiagnostics}` : ""}\n`,
          "utf8",
        );
        await writeResults(context, results);
        throw error;
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      await context.dispose();
    } catch (error) {
      failure = failure
        ? new AggregateError([failure, error], "E2E groups or cleanup failed")
        : error;
    }
    await writeResults(context, results);
  }

  if (failure) throw failure;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
