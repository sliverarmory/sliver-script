import assert from "node:assert/strict";

import type { clientpb, SliverEventStreamState } from "../../lib";
import type { E2ESuiteContext } from "../context";
import { waitForOnlineOperator } from "../support";

const sliverScript = require("../../../lib") as typeof import("../../lib");

export const name = "00-connectivity";

export async function run(context: E2ESuiteContext): Promise<void> {
    const { client, environment } = context;
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
    assert.equal(
      version.Dirty,
      environment.expectedSliverDirty,
      environment.expectedSliverDirty
        ? `server must report dirty working-tree source ${environment.sliverPatchSha256}`
        : "server must report a clean pinned source build",
    );

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

    await verifySecondaryClientLifecycle(context);
}

async function verifySecondaryClientLifecycle(context: E2ESuiteContext): Promise<void> {
  const secondary = new sliverScript.SliverClient(context.config);
  const derivedClientEvents: clientpb.Event[] = [];
  const streamStates: SliverEventStreamState[] = [];
  const subscription = context.client.client$.subscribe((event) => derivedClientEvents.push(event));
  const streamSubscription = context.client.eventStreamState$.subscribe((state) => streamStates.push(state));
  let joinedClientId: number | undefined;
  try {
    const joinCursor = context.eventCursor();
    assert.equal(await secondary.connect(), secondary, "secondary client connect result");
    assert.equal(await secondary.connect(), secondary, "secondary idempotent connect result");
    const joined = await context.waitForEvent(
      joinCursor,
      (event) => event.EventType === "client-joined"
        && event.Client?.Operator?.Name === context.environment.operator,
      30_000,
      "secondary operator client-joined event",
    );
    assert.ok(joined.Client && joined.Client.ID > 0, "secondary joined client ID");
    joinedClientId = joined.Client.ID;
    assert.ok(streamStates.some((state) => state.status === "connected"), "primary event stream connected state");
    assert.ok(
      derivedClientEvents.some((event) => event.EventType === "client-joined"
        && event.Client?.ID === joinedClientId),
      "derived client observable must emit the exact join event",
    );

    const leaveCursor = context.eventCursor();
    await secondary.disconnect();
    await secondary.disconnect();
    const left = await context.waitForEvent(
      leaveCursor,
      (event) => event.EventType === "client-left" && event.Client?.ID === joinedClientId,
      30_000,
      "secondary operator client-left event",
    );
    assert.equal(left.Client?.Operator?.Name, context.environment.operator, "secondary left operator name");
    assert.ok(
      derivedClientEvents.some((event) => event.EventType === "client-left"
        && event.Client?.ID === joinedClientId),
      "derived client observable must emit the exact leave event",
    );
  } finally {
    subscription.unsubscribe();
    streamSubscription.unsubscribe();
    await secondary.disconnect();
  }
}
