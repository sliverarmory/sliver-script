import assert from "node:assert/strict";

import type { E2ESuiteContext, LiveImplant } from "../context";

export const name = "04-session-core";

const RPC_TIMEOUT_SECONDS = 120;

export async function run(context: E2ESuiteContext): Promise<void> {
  const implant = requireSession(context);
  const sessionId = implant.session!.ID;

  const inventory = await context.client.getSessions(RPC_TIMEOUT_SECONDS);
  const listed = inventory.Sessions.find((session) => session.ID === sessionId);
  assert.ok(listed, "session inventory must contain the generated session");
  assert.equal(listed.PID, implant.pid, "session inventory PID");
  assert.equal(listed.Name, implant.name, "session inventory name");

  const sessions = await context.client.sessions(RPC_TIMEOUT_SECONDS);
  assert.ok(sessions.some((session) => session.ID === sessionId), "sessions helper must contain the generated session");

  const nonce = 0x5a17c0de;
  const ping = await context.client.pingSession(sessionId, nonce, RPC_TIMEOUT_SECONDS);
  assertImplantSuccess(ping, "session ping");
  assert.equal(ping.Nonce, nonce, "session ping nonce");

  const interactiveNonce = 0x12ab34cd;
  const interactivePing = await context.client.interactSession(sessionId).ping(
    interactiveNonce,
    RPC_TIMEOUT_SECONDS,
  );
  assertImplantSuccess(interactivePing, "interactive session ping");
  assert.equal(interactivePing.Nonce, interactiveNonce, "interactive session ping nonce");

  await verifyRename(context, implant);
  await verifyEnvironment(context, implant);
}

async function verifyRename(context: E2ESuiteContext, implant: LiveImplant): Promise<void> {
  const sessionId = implant.session!.ID;
  const renamed = `sse2e${process.pid}${Date.now().toString(36)}`;
  let renameApplied = false;
  try {
    await context.client.renameSession(sessionId, renamed, RPC_TIMEOUT_SECONDS);
    renameApplied = true;
    const inventory = await context.client.getSessions(RPC_TIMEOUT_SECONDS);
    assert.equal(
      inventory.Sessions.find((session) => session.ID === sessionId)?.Name,
      renamed,
      "renamed session inventory name",
    );
  } finally {
    if (renameApplied) {
      await context.client.renameSession(sessionId, implant.name, RPC_TIMEOUT_SECONDS);
    }
  }

  const restored = await context.client.getSessions(RPC_TIMEOUT_SECONDS);
  assert.equal(
    restored.Sessions.find((session) => session.ID === sessionId)?.Name,
    implant.name,
    "restored session inventory name",
  );
}

async function verifyEnvironment(context: E2ESuiteContext, implant: LiveImplant): Promise<void> {
  const sessionId = implant.session!.ID;
  const environmentKey = `SLIVER_SCRIPT_E2E_MUTABLE_${process.pid}_${Date.now()}`;
  const environmentValue = `${context.environment.expectedOS}-${context.environment.expectedArch}-session`;

  const direct = await context.client.getEnvSession(sessionId, "", RPC_TIMEOUT_SECONDS);
  assertImplantSuccess(direct, "get full session environment");
  assert.ok(direct.Variables.length >= 2, "session environment must contain inherited variables");
  assert.equal(envValue(direct.Variables, "SLIVER_SCRIPT_E2E"), "1", "session environment marker");

  const listed = await context.client.listEnvSession(sessionId, RPC_TIMEOUT_SECONDS);
  assertImplantSuccess(listed, "list session environment");
  assert.equal(envValue(listed.Variables, "SLIVER_SCRIPT_E2E"), "1", "listed session environment marker");

  let variableMayExist = false;
  try {
    variableMayExist = true;
    const set = await context.client.setEnvSession(
      sessionId,
      environmentKey,
      environmentValue,
      RPC_TIMEOUT_SECONDS,
    );
    assertImplantSuccess(set, "set session environment variable");

    const fetched = await context.client.getEnvSession(sessionId, environmentKey, RPC_TIMEOUT_SECONDS);
    assertImplantSuccess(fetched, "get named session environment variable");
    assert.equal(envValue(fetched.Variables, environmentKey), environmentValue, "named session environment value");

    const revealed = await context.client.revealEnvSession(sessionId, environmentKey, RPC_TIMEOUT_SECONDS);
    assertImplantSuccess(revealed, "reveal session environment variable");
    assert.equal(envValue(revealed.Variables, environmentKey), environmentValue, "revealed session environment value");

    const unset = await context.client.unsetEnvSession(sessionId, environmentKey, RPC_TIMEOUT_SECONDS);
    assertImplantSuccess(unset, "unset session environment variable");
    variableMayExist = false;
  } finally {
    if (variableMayExist) {
      const unset = await context.client.unsetEnvSession(sessionId, environmentKey, RPC_TIMEOUT_SECONDS);
      assertImplantSuccess(unset, "clean session environment variable");
    }
  }

  const afterUnset = await context.client.listEnvSession(sessionId, RPC_TIMEOUT_SECONDS);
  assertImplantSuccess(afterUnset, "list session environment after unset");
  assert.equal(envHasKey(afterUnset.Variables, environmentKey), false, "unset session environment variable must be absent");
}

function requireSession(context: E2ESuiteContext): LiveImplant {
  assert.ok(context.session, "listener/generation group must launch a session first");
  assert.ok(context.session.session, "session callback metadata is required");
  assert.ok(context.session.session.ID, "session callback ID is required");
  return context.session;
}

function assertImplantSuccess(
  response: { readonly Response?: { readonly Err: string } },
  label: string,
): void {
  assert.equal(response.Response?.Err ?? "", "", `${label} implant error`);
}

function envValue(
  variables: ReadonlyArray<{ readonly Key: string; readonly Value: string }>,
  key: string,
): string | undefined {
  const normalized = key.toUpperCase();
  return variables.find((variable) => variable.Key.toUpperCase() === normalized)?.Value;
}

function envHasKey(
  variables: ReadonlyArray<{ readonly Key: string }>,
  key: string,
): boolean {
  const normalized = key.toUpperCase();
  return variables.some((variable) => variable.Key.toUpperCase() === normalized);
}
