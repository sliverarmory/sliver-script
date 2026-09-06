import assert from "node:assert/strict";

import {
  loadE2EEnvironment,
  waitForOnlineOperator,
  withConnectedClient,
} from "../support";

export const name = "00-connectivity";

export async function run(): Promise<void> {
  const environment = loadE2EEnvironment();

  await withConnectedClient(environment, async ({ client }) => {
    const version = await client.getVersion();
    assert.equal(version.Commit, environment.sliverSha, "server commit");
    assert.equal(version.OS, environment.expectedOS, "server operating system");
    assert.equal(version.Arch, environment.expectedArch, "server architecture");
    assert.ok(Number.isInteger(version.Major) && version.Major >= 0, "server major version");
    assert.ok(Number.isInteger(version.Minor) && version.Minor >= 0, "server minor version");
    assert.ok(Number.isInteger(version.Patch) && version.Patch >= 0, "server patch version");
    assert.ok(
      Number.isSafeInteger(Number(version.CompiledAt)) && Number(version.CompiledAt) > 0,
      "server compilation timestamp",
    );
    assert.equal(version.Dirty, false, "server must report a clean source build");

    const operator = await waitForOnlineOperator(client, environment.operator);
    assert.equal(operator.Name, environment.operator, "server operator identity");
    assert.equal(operator.Online, true, "server operator online state");

    const operators = await client.operators();
    assert.ok(Array.isArray(operators), "operators helper must return an array");
    assert.deepEqual(
      operators.map((candidate) => candidate.Name),
      [environment.operator],
      "operators helper identity",
    );
    assert.equal(operators[0].Online, true, "operators helper online state");
  });
}

void run().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
