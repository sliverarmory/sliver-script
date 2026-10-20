import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { ShellSessionHandle } from "../../lib";
import type { E2ESuiteContext, LiveImplant } from "../context";

export const name = "06-session-shell";
const operationSeconds = 30;
const outputLimitBytes = 128 * 1024;
const waitMilliseconds = 20_000;

interface OutputObservation {
  text: string;
  finished: boolean;
  error?: unknown;
  done: Promise<void>;
}

interface OwnedShell {
  handle: ShellSessionHandle;
  output: OutputObservation;
  executable: string;
}

export async function run(context: E2ESuiteContext): Promise<void> {
  const implant = context.session;
  assert.ok(implant?.session?.ID, "live session fixture");
  const sessionId = implant.session.ID;
  const sentinel = path.join(implant.root, "outside-test-sentinel.txt");
  assert.equal(await readFile(sentinel, "utf8"), "must-survive\n", "shell fixture sentinel");
  const windows = context.environment.expectedOS === "windows";
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (windows) assert.ok(systemRoot && path.win32.isAbsolute(systemRoot), "absolute Windows system root");
  const shellPath = windows ? path.win32.join(systemRoot!, "System32", "cmd.exe") : "/bin/sh";
  await access(shellPath); // Do not let Sliver silently select its fallback shell.
  const prefix = `SSE2E_${process.pid}_`;
  const markerCommand = (suffix: string): string => windows
    ? `echo %SSE2E_PREFIX%${suffix}\r\n`
    : `printf '%s%s\\n' '${prefix}' '${suffix}'\n`;
  const owned: OwnedShell[] = [];
  let failure: unknown;
  try {
    const first = await startOwnedShell(context, implant, shellPath, !windows);
    owned.push(first);
    await write(first.handle, windows
      ? `@echo off\r\nset "SSE2E_PREFIX=${prefix}"\r\n`
      : "PS1=''; PS2=''; /bin/stty -echo\n");
    await write(first.handle, markerCommand("READY"));
    await waitForOutput(first.output, `${prefix}READY\n`);

    // Queue separate writes together to exercise the handle's ordering guarantee.
    await bounded(Promise.all(["FIRST", "SECOND", "THIRD"].map((part) =>
      write(first.handle, markerCommand(part)),
    )), "ordered shell writes");
    await waitForOutput(first.output, `${prefix}THIRD\n`);
    const positions = ["FIRST", "SECOND", "THIRD"].map((part) => first.output.text.indexOf(`${prefix}${part}\n`));
    assert.ok(positions[0]! >= 0 && positions[0]! < positions[1]! && positions[1]! < positions[2]!, "shell output follows write order");

    if (windows) {
      await assert.rejects(bounded(first.handle.resize(41, 101), "piped shell resize"), /requires a PTY/u, "piped Windows shell cannot resize");
    } else {
      await write(first.handle, `printf '%s%s' '${prefix}' 'INITIAL:'; /bin/stty size\n`);
      await waitForOutput(first.output, `${prefix}INITIAL:24 80\n`);
      await bounded(first.handle.resize(41, 101), "native PTY resize");
      await write(first.handle, `printf '%s%s' '${prefix}' 'RESIZED:'; /bin/stty size\n`);
      await waitForOutput(first.output, `${prefix}RESIZED:41 101\n`);
    }

    await write(first.handle, windows ? "exit\r\n" : "exit\n");
    await bounded(first.output.done, "natural shell EOF");
    assert.equal(first.output.error, undefined, "natural shell exit completes the output iterator");
    await waitForShellExit(context, implant, first);
    await assert.rejects(write(first.handle, "already closed"), /closed/u, "exited shell rejects writes");
    await bounded(first.handle.close(), "exited shell close");
    await bounded(first.handle.close(), "idempotent shell close");

    const second = await startOwnedShell(context, implant, shellPath, !windows);
    owned.push(second);
    await write(second.handle, windows
      ? `@echo off\r\nset "SSE2E_PREFIX=${prefix}"\r\n`
      : "PS1=''; PS2=''; /bin/stty -echo\n");
    await write(second.handle, markerCommand("DISCONNECT_READY"));
    await waitForOutput(second.output, `${prefix}DISCONNECT_READY\n`);
    await bounded(context.client.disconnect(), "client disconnect with an open shell");
    await bounded(second.output.done, "disconnected shell output cleanup");
    assert.ok(second.output.error instanceof Error, "disconnect fails the open output iterator");
    assert.match(second.output.error.message, /Tunnel transport disconnected/u);
    await assert.rejects(write(second.handle, "already disconnected"), /closed/u);
    assert.equal(context.client.isConnected, false, "client disconnected after shell teardown");

    await context.client.connect();
    const ping = await context.client.pingSession(sessionId, 0x53e110, operationSeconds);
    assert.equal(ping.Response?.Err ?? "", "", "session remains usable after shell reconnect");
    assert.equal(ping.Nonce, 0x53e110);
    await waitForShellExit(context, implant, second);
  } catch (error) {
    failure = error;
  }

  const cleanupErrors: unknown[] = [];
  try {
    if (!context.client.isConnected) await context.client.connect();
    for (const shell of owned) {
      try {
        await bounded(shell.handle.close(), "owned shell cleanup");
        const current = await ownedProcess(context, implant, shell.handle.pid);
        if (current) {
          assert.equal(current.Executable, shell.executable, "cleanup shell executable identity");
          const terminated = await context.client.terminateSessionProcess(sessionId, shell.handle.pid, false, operationSeconds);
          assert.equal(terminated.Response?.Err ?? "", "", "owned shell fallback termination");
          assert.equal(terminated.Pid, shell.handle.pid, "only the returned shell PID is terminated");
        }
        await waitForShellExit(context, implant, shell);
        await bounded(shell.output.done, "owned shell output cleanup");
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    assert.equal(await readFile(sentinel, "utf8"), "must-survive\n", "shell fixture sentinel preserved");
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (failure && cleanupErrors.length) throw new AggregateError([failure, ...cleanupErrors], "shell E2E and cleanup failed");
  if (failure) throw failure;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "shell E2E cleanup failed");
}

async function startOwnedShell(context: E2ESuiteContext, implant: LiveImplant, shellPath: string, pty: boolean): Promise<OwnedShell> {
  const handle = await context.client.startShellSession(implant.session!.ID, {
    path: shellPath, pty, rows: 24, cols: 80, outputBufferBytes: outputLimitBytes,
  }, operationSeconds);
  const output = observeOutput(handle);
  try {
    assert.ok(handle.pid > 1 && handle.pid !== implant.pid, "distinct owned shell child PID");
    const process = await ownedProcess(context, implant, handle.pid);
    assert.ok(process, "new shell is in the native process inventory");
    return { handle, output, executable: process.Executable };
  } catch (error) {
    await bounded(handle.close(), "failed shell startup cleanup");
    throw error;
  }
}

function observeOutput(handle: ShellSessionHandle): OutputObservation {
  const observed: OutputObservation = { text: "", finished: false, done: Promise.resolve() };
  observed.done = (async () => {
    let bytes = 0;
    try {
      for await (const chunk of handle.output) {
        bytes += chunk.byteLength;
        assert.ok(bytes <= outputLimitBytes, "bounded shell fixture output");
        observed.text += Buffer.from(chunk).toString("utf8").replace(/\r/gu, "");
      }
    } catch (error) {
      observed.error = error;
    } finally {
      observed.finished = true;
    }
  })();
  return observed;
}

async function waitForOutput(output: OutputObservation, marker: string): Promise<void> {
  const deadline = Date.now() + waitMilliseconds;
  while (Date.now() < deadline) {
    if (output.text.includes(marker)) return;
    if (output.error) throw output.error;
    assert.equal(output.finished, false, `shell closed before ${marker.trim()}`);
    await delay(25);
  }
  throw new Error(`Timed out waiting for shell marker ${marker.trim()}; output=${JSON.stringify(output.text.slice(-2_000))}`);
}

async function ownedProcess(context: E2ESuiteContext, implant: LiveImplant, pid: number) {
  assert.ok(pid > 1 && pid !== implant.pid, "safe shell child PID");
  const listed = await context.client.psSession(implant.session!.ID, true, 5);
  assert.equal(listed.Response?.Err ?? "", "", "shell process inventory");
  const current = listed.Processes.find((process) => process.Pid === pid);
  if (current) assert.equal(current.Ppid, implant.pid, "shell process belongs to this fixture implant");
  return current;
}

async function waitForShellExit(context: E2ESuiteContext, implant: LiveImplant, shell: OwnedShell): Promise<void> {
  const deadline = Date.now() + waitMilliseconds;
  while (Date.now() < deadline) {
    if (!await ownedProcess(context, implant, shell.handle.pid)) return;
    await delay(100);
  }
  throw new Error(`Owned shell PID ${shell.handle.pid} did not exit`);
}

function write(handle: ShellSessionHandle, data: string): Promise<void> {
  return bounded(handle.write(data), "shell input");
}

async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out during ${label}`)), waitMilliseconds);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
