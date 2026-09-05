import { EMPTY } from "rxjs";

import {
  InteractiveSession,
  SHELL_OUTPUT_BUFFER_MAX_BYTES,
  SHELL_WRITE_MAX_BYTES,
  SliverClient,
} from "../client";
import type { SliverClientConfig } from "../config";
import type { DeepPartial } from "../pb/rpcpb/services";
import type { TunnelData } from "../pb/sliverpb/sliver";
import { TUNNEL_STREAM_MAX_PAYLOAD_BYTES } from "../messageBudget";
import {
  TUNNEL_MANAGER_MAX_ACTIVE_TUNNELS,
  TUNNEL_MANAGER_MAX_QUEUED_FRAMES_PER_TUNNEL,
  TunnelManager,
} from "../internal/tunnelManager";

const activeHarnesses = new Set<TunnelHarness>();
afterEach(async () => {
  await Promise.all([...activeHarnesses].map((harness) => harness.stop()));
});

describe("bounded managed session shell", () => {
  test("registers early output before the exact bind and shell sequence", async () => {
    const order: string[] = [];
    const harness = new TunnelHarness(true, (message) => {
      if (message.Data?.length === 0) order.push("bind");
    });
    const createTunnel = jest.fn(async () => {
      order.push("create");
      return { TunnelID: "tunnel-early", SessionID: "session-42" };
    });
    const shell = jest.fn(async () => {
      order.push("shell");
      harness.incoming.push(tunnelMessage("tunnel-early", "session-42", Buffer.from("ready> ")));
      return shellResponse("tunnel-early", "/bin/zsh", 4_242, true);
    });
    const closeTunnel = jest.fn(async () => ({}));
    const client = clientWithShellRpc(harness.manager, { createTunnel, shell, closeTunnel });

    const handle = await client.startShellSession("session-42", {
      path: "/bin/zsh",
      pty: true,
      rows: 32,
      cols: 120,
      outputBufferBytes: SHELL_OUTPUT_BUFFER_MAX_BYTES * 10,
    }, 0);

    expect(order).toEqual(["create", "bind", "shell"]);
    expect(createTunnel).toHaveBeenCalledWith(
      { SessionID: "session-42" }, { signal: expect.any(AbortSignal) },
    );
    expect(harness.outbound[0]).toEqual({
      TunnelID: "tunnel-early", SessionID: "session-42", Data: Buffer.alloc(0),
    });
    expect(shell).toHaveBeenCalledWith(
      {
        Path: "/bin/zsh",
        EnablePTY: true,
        Pid: 0,
        Rows: 32,
        Cols: 120,
        TunnelID: "tunnel-early",
        Request: { Async: false, Timeout: "0", BeaconID: "", SessionID: "session-42" },
      },
      { signal: expect.any(AbortSignal) },
    );
    await expect(handle.output[Symbol.asyncIterator]().next()).resolves.toEqual({
      value: Uint8Array.from(Buffer.from("ready> ")), done: false,
    });
    expect(handle).toMatchObject({
      id: "tunnel-early", pid: 4_242, path: "/bin/zsh", ptyRequested: true,
    });

    await handle.close();
  });

  test.each([
    ["target rejection", async () => shellResponse(
      "tunnel-failure", "/bin/sh", 0, true, "TOP-SECRET-TARGET-DETAIL",
    )],
    ["RPC rejection", async () => {
      throw new Error("TOP-SECRET-RPC-DETAIL");
    }],
  ])("cleans partial tunnels after %s without reflecting remote errors", async (_label, shellImpl) => {
    const harness = new TunnelHarness();
    const closeTunnel = jest.fn(async () => ({}));
    const client = clientWithShellRpc(harness.manager, {
      createTunnel: jest.fn(async () => ({ TunnelID: "tunnel-failure", SessionID: "session-failure" })),
      shell: jest.fn(shellImpl),
      closeTunnel,
    });

    const start = client.startShellSession("session-failure", {
      path: "/bin/sh", pty: true, rows: 24, cols: 80,
    }, 0);
    await expect(start).rejects.toThrow("Unable to start shell session");
    await expect(start).rejects.not.toThrow(/TOP-SECRET/u);

    expect(closeTunnel).toHaveBeenCalledTimes(1);
    expect(closeTunnel).toHaveBeenCalledWith(
      { TunnelID: "tunnel-failure", SessionID: "session-failure" },
      { signal: expect.any(AbortSignal) },
    );
    expect(harness.outbound.filter((message) => (message.Data?.length ?? 0) > 0).map((message) =>
      Buffer.from(message.Data!).toString("utf8"))).toEqual(["exit\n", "logout\n"]);
    expect(harness.manager.stats()).toEqual({ activeTunnels: 0, queuedFrames: 0, queuedBytes: 0 });
  });

  test("serializes and chunks immutable input, gates resize, and closes idempotently", async () => {
    const closeOrder: string[] = [];
    const harness = new TunnelHarness(true, (message) => {
      const data = Buffer.from(message.Data ?? []).toString("utf8");
      if (data) closeOrder.push(`write:${data}`);
    });
    const shellResize = jest.fn(async () => ({}));
    const closeTunnel = jest.fn(async () => {
      closeOrder.push("closeTunnel");
      return {};
    });
    const client = clientWithShellRpc(harness.manager, {
      createTunnel: jest.fn(async () => ({ TunnelID: "tunnel-io", SessionID: "session-io" })),
      shell: jest.fn(async () => shellResponse("tunnel-io", "/bin/bash", 101, true)),
      shellResize,
      closeTunnel,
    });
    const handle = await client.startShellSession("session-io", {
      path: "/bin/bash", pty: true, rows: 40, cols: 132,
    }, 0);
    harness.outbound.splice(0, harness.outbound.length);

    const first = Uint8Array.from(
      { length: (TUNNEL_STREAM_MAX_PAYLOAD_BYTES * 2) + 3 },
      (_value, index) => index % 251,
    );
    const expectedFirst = Buffer.from(first);
    const second = Buffer.from("second-write");
    const firstWrite = handle.write(first);
    first.fill(0);
    const secondWrite = handle.write(second);
    second.fill(0);
    await Promise.all([firstWrite, secondWrite]);

    const frames = harness.outbound.filter((message) => (message.Data?.length ?? 0) > 0);
    expect(frames.map((message) => message.Data!.length)).toEqual([
      TUNNEL_STREAM_MAX_PAYLOAD_BYTES,
      TUNNEL_STREAM_MAX_PAYLOAD_BYTES,
      3,
      Buffer.byteLength("second-write"),
    ]);
    expect(Buffer.concat(frames.map((message) => Buffer.from(message.Data!)))).toEqual(
      Buffer.concat([expectedFirst, Buffer.from("second-write")]),
    );

    await handle.resize(52, 160);
    expect(shellResize).toHaveBeenCalledWith(
      {
        Rows: 52,
        Cols: 160,
        TunnelID: "tunnel-io",
        Request: { Async: false, Timeout: "0", BeaconID: "", SessionID: "session-io" },
      },
      { signal: expect.any(AbortSignal) },
    );

    const firstClose = handle.close();
    const secondClose = handle.close();
    expect(firstClose).toBe(secondClose);
    await Promise.all([firstClose, secondClose]);
    expect(closeOrder.slice(-3)).toEqual(["write:exit\n", "write:logout\n", "closeTunnel"]);
    expect(closeTunnel).toHaveBeenCalledTimes(1);
    await expect(handle.write("after close")).rejects.toThrow("Shell session is closed");
  });

  test("bounds aggregate write ownership while transport is stalled and clears owned bytes", async () => {
    let releaseFirstFrame!: () => void;
    let reportFirstFrame!: () => void;
    const firstFrameStarted = new Promise<void>((resolve) => {
      reportFirstFrame = resolve;
    });
    const firstFrameBlocked = new Promise<void>((resolve) => {
      releaseFirstFrame = resolve;
    });
    let firstOwnedFrame: Uint8Array | undefined;
    let failedOwnedFrame: Uint8Array | undefined;
    let dataFrames = 0;
    const send = jest.fn((message: DeepPartial<TunnelData>) => {
      if ((message.Data?.length ?? 0) === 0) return Promise.resolve();
      dataFrames += 1;
      if (dataFrames === 1) {
        firstOwnedFrame = message.Data;
        reportFirstFrame();
        return firstFrameBlocked;
      }
      if (dataFrames === 65) {
        failedOwnedFrame = message.Data;
        return Promise.reject(new Error("target-controlled transport failure"));
      }
      return Promise.resolve();
    });
    const output = {
      [Symbol.asyncIterator]: async function* () {
        return;
      },
    };
    const tunnels = {
      openOutput: jest.fn(() => output),
      send,
      cancelTunnel: jest.fn(),
    };
    const client = new SliverClient(baseConfig());
    const rpc = {
      createTunnel: jest.fn(async () => ({ TunnelID: "stalled-managed", SessionID: "session-stalled" })),
      shell: jest.fn(async () => shellResponse("stalled-managed", "/bin/sh", 303, true)),
      closeTunnel: jest.fn(async () => ({})),
    };
    const internals = client as unknown as { rpcClients: Record<string, unknown>; tunnels: typeof tunnels };
    internals.rpcClients.control = rpc;
    internals.tunnels = tunnels;
    const handle = await client.startShellSession("session-stalled", {
      path: "/bin/sh", pty: true, rows: 24, cols: 80,
    }, 0);

    const source = Buffer.alloc(SHELL_WRITE_MAX_BYTES, 0x41);
    const firstWrite = handle.write(source);
    source.fill(0);
    await firstFrameStarted;
    expect(firstOwnedFrame).toBeDefined();
    expect(firstOwnedFrame!.every((byte) => byte === 0x41)).toBe(true);

    await expect(handle.write("overflow")).rejects.toThrow("Shell write exceeded its bounded queue");
    expect(send).toHaveBeenCalledTimes(2);

    releaseFirstFrame();
    await expect(firstWrite).resolves.toBeUndefined();
    expect(firstOwnedFrame!.every((byte) => byte === 0)).toBe(true);

    await expect(handle.write("failure-owned-bytes")).rejects.toThrow("Unable to write to shell session");
    expect(failedOwnedFrame).toBeDefined();
    expect(failedOwnedFrame!.every((byte) => byte === 0)).toBe(true);
  });

  test("drains final output and closes operations after target EOF", async () => {
    const harness = new TunnelHarness();
    const closeTunnel = jest.fn(async () => ({}));
    const client = clientWithShellRpc(harness.manager, {
      createTunnel: jest.fn(async () => ({ TunnelID: "target-close", SessionID: "session-close" })),
      shell: jest.fn(async () => shellResponse("target-close", "/bin/sh", 303, true)),
      closeTunnel,
    });
    const handle = await client.startShellSession("session-close", {
      path: "/bin/sh", pty: true, rows: 24, cols: 80,
    }, 0);
    const output = handle.output[Symbol.asyncIterator]();

    harness.incoming.push(tunnelMessage("target-close", "session-close", Buffer.from("bye\n"), true));
    await expect(output.next()).resolves.toEqual({
      value: Uint8Array.from(Buffer.from("bye\n")), done: false,
    });
    await expect(output.next()).resolves.toEqual({ value: undefined, done: true });
    await expect(handle.resize(30, 100)).rejects.toThrow("Shell session is closed");
    await handle.close();
    expect(closeTunnel).not.toHaveBeenCalled();
  });

  test.each([0, 1, 0x8000_0000])(
    "rejects unsafe child PID %i and tears down the partial tunnel",
    async (pid) => {
    const harness = new TunnelHarness();
    const closeTunnel = jest.fn(async () => ({}));
    const client = clientWithShellRpc(harness.manager, {
      createTunnel: jest.fn(async () => ({ TunnelID: `unsafe-pid-${pid}`, SessionID: "session-pid" })),
      shell: jest.fn(async () => shellResponse(`unsafe-pid-${pid}`, "/bin/sh", pid, true)),
      closeTunnel,
    });

    await expect(client.startShellSession("session-pid", {
      path: "/bin/sh", pty: true, rows: 24, cols: 80,
    }, 0)).rejects.toThrow("Unable to start shell session");
    expect(closeTunnel).toHaveBeenCalledTimes(1);
    expect(harness.outbound.filter((message) => (message.Data?.length ?? 0) > 0).map((message) =>
      Buffer.from(message.Data!).toString("utf8"))).toEqual(["exit\n", "logout\n"]);
    expect(harness.manager.stats().activeTunnels).toBe(0);
  });

  test("bounds graceful close when an unconsumed tunnel never reports EOF", async () => {
    jest.useFakeTimers();
    try {
      const harness = new TunnelHarness(true, undefined, false);
      const closeTunnel = jest.fn(async () => ({}));
      const client = clientWithShellRpc(harness.manager, {
        createTunnel: jest.fn(async () => ({ TunnelID: "no-eof", SessionID: "session-no-eof" })),
        shell: jest.fn(async () => shellResponse("no-eof", "/bin/sh", 303, true)),
        closeTunnel,
      });
      const handle = await client.startShellSession("session-no-eof", {
        path: "/bin/sh", pty: true, rows: 24, cols: 80,
      }, 0);
      harness.incoming.push(tunnelMessage("no-eof", "session-no-eof", Buffer.from("unconsumed output")));

      const closing = handle.close();
      await Promise.resolve();
      expect(closeTunnel).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(2_000);
      await expect(closing).resolves.toBeUndefined();
      expect(closeTunnel).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("does not let CloseTunnel overtake graceful exit frames before exact remote EOF", async () => {
    const harness = new TunnelHarness(true, undefined, false);
    const closeTunnel = jest.fn(async () => ({}));
    const client = clientWithShellRpc(harness.manager, {
      createTunnel: jest.fn(async () => ({ TunnelID: "close-eof", SessionID: "session-close-eof" })),
      shell: jest.fn(async () => shellResponse("close-eof", "/bin/sh", 505, true)),
      closeTunnel,
    });
    const handle = await client.startShellSession("session-close-eof", {
      path: "/bin/sh", pty: true, rows: 24, cols: 80,
    }, 0);
    harness.outbound.splice(0, harness.outbound.length);

    const closing = handle.close();
    await waitFor(() => harness.outbound.filter((message) => (message.Data?.length ?? 0) > 0).length === 2);
    expect(closeTunnel).not.toHaveBeenCalled();

    harness.incoming.push(tunnelMessage("close-eof", "session-close-eof", Buffer.alloc(0), true));
    await closing;
    expect(closeTunnel).toHaveBeenCalledTimes(1);
  });

  test("rejects resize for non-PTY shells without dispatching ShellResize", async () => {
    const harness = new TunnelHarness();
    const shellResize = jest.fn(async () => ({}));
    const client = clientWithShellRpc(harness.manager, {
      createTunnel: jest.fn(async () => ({ TunnelID: "no-pty", SessionID: "session-no-pty" })),
      shell: jest.fn(async () => shellResponse("no-pty", "/bin/sh", 303, false)),
      shellResize,
      closeTunnel: jest.fn(async () => ({})),
    });
    const handle = await client.startShellSession("session-no-pty", {
      path: "/bin/sh", pty: false, rows: 24, cols: 80,
    }, 0);

    await expect(handle.resize(30, 100)).rejects.toThrow("Shell resize requires a PTY");
    expect(shellResize).not.toHaveBeenCalled();
    await handle.close();
  });

});

describe("legacy interactive session shell compatibility", () => {
  test("copies, serializes, and chunks legacy writes within reviewed bounds", async () => {
    const harness = new TunnelHarness();
    const client = clientWithShellRpc(harness.manager, {
      createTunnel: jest.fn(async () => ({ TunnelID: "legacy-shell", SessionID: "legacy-session" })),
      shell: jest.fn(async () => shellResponse("legacy-shell", "/bin/sh", 0, true)),
      closeTunnel: jest.fn(async () => ({})),
    });
    const shell = await client.interactSession("legacy-session").shell("/bin/sh", true, 0);
    harness.outbound.splice(0, harness.outbound.length);

    const source = Buffer.alloc(TUNNEL_STREAM_MAX_PAYLOAD_BYTES + 3, 0x41);
    const expected = Buffer.from(source);
    const write = shell.write(source);
    source.fill(0);
    await expect(write).resolves.toBeUndefined();

    const frames = harness.outbound.filter((message) => (message.Data?.length ?? 0) > 0);
    expect(frames.map((message) => message.Data!.length)).toEqual([TUNNEL_STREAM_MAX_PAYLOAD_BYTES, 3]);
    expect(Buffer.concat(frames.map((message) => Buffer.from(message.Data!)))).toEqual(expected);
    await expect(shell.write(Buffer.alloc(SHELL_WRITE_MAX_BYTES + 1))).rejects.toThrow("Shell write must not exceed");
    await shell.close();
  });

  test("bounds queued legacy write ownership while transport is stalled", async () => {
    let releaseData!: () => void;
    const dataBlocked = new Promise<void>((resolve) => {
      releaseData = resolve;
    });
    let dataFrames = 0;
    const send = jest.fn((message: DeepPartial<TunnelData>) => {
      if ((message.Data?.length ?? 0) === 0) return Promise.resolve();
      dataFrames += 1;
      return dataFrames === 1 ? dataBlocked : Promise.resolve();
    });
    const tunnels = {
      subscribe: jest.fn(() => EMPTY),
      send,
      cancelTunnel: jest.fn(),
    };
    const rpc = {
      createTunnel: jest.fn(async () => ({ TunnelID: "stalled", SessionID: "legacy-session" })),
      shell: jest.fn(async () => shellResponse("stalled", "/bin/sh", 0, true)),
      closeTunnel: jest.fn(async () => ({})),
    };
    const session = new InteractiveSession(rpc as never, tunnels as never, "legacy-session");
    const shell = await session.shell("/bin/sh", true, 0);

    const first = shell.write(Buffer.alloc(SHELL_WRITE_MAX_BYTES, 0x41));
    const overflow = shell.write("x");
    await expect(overflow).rejects.toThrow("Shell write exceeded its bounded queue");
    releaseData();
    await expect(first).resolves.toBeUndefined();
    await shell.close();
  });
});

describe("bounded fair tunnel manager", () => {
  test("opens the long-lived duplex stream only after a tunnel is registered", async () => {
    const harness = new TunnelHarness();

    expect(harness.streamStarted).toBe(false);
    harness.manager.openOutput("tunnel-lazy", { maxBufferedBytes: 64 });
    expect(harness.streamStarted).toBe(true);
  });

  test("round-robins tunnels and rejects frames beyond per-tunnel caps", async () => {
    const harness = new TunnelHarness(false);
    harness.manager.openOutput("tunnel-a", { maxBufferedBytes: 64 });
    harness.manager.openOutput("tunnel-b", { maxBufferedBytes: 64 });

    const a1 = harness.manager.send(tunnelSend("tunnel-a", "a1"));
    const a2 = harness.manager.send(tunnelSend("tunnel-a", "a2"));
    const b1 = harness.manager.send(tunnelSend("tunnel-b", "b1"));

    harness.manager.openOutput("tunnel-cap", { maxBufferedBytes: 64 });
    const pending = Array.from({ length: TUNNEL_MANAGER_MAX_QUEUED_FRAMES_PER_TUNNEL }, (_value, index) =>
      harness.manager.send(tunnelSend("tunnel-cap", String(index))).catch(() => undefined));
    await expect(harness.manager.send(tunnelSend("tunnel-cap", "overflow"))).rejects.toThrow(
      "bounded queue",
    );
    harness.manager.cancelTunnel("tunnel-cap");
    await Promise.all(pending);

    const first = await harness.pullOutgoing();
    const second = await harness.pullOutgoing();
    const third = await harness.pullOutgoing();
    const completionPull = harness.pullOutgoing().catch(() => undefined);
    await Promise.all([a1, a2, b1]);

    expect([first.TunnelID, second.TunnelID, third.TunnelID]).toEqual([
      "tunnel-a", "tunnel-b", "tunnel-a",
    ]);
    await harness.stop();
    await completionPull;
  });

  test("clears each delivered frame after the transport requests its successor", async () => {
    const harness = new TunnelHarness(false);
    harness.manager.openOutput("tunnel-clear", { maxBufferedBytes: 64 });

    const firstSend = harness.manager.send(tunnelSend("tunnel-clear", "first-secret"));
    let firstSendSettled = false;
    void firstSend.then(
      () => { firstSendSettled = true; },
      () => { firstSendSettled = true; },
    );
    const first = await harness.pullOutgoing();
    expect(Buffer.from(first.Data ?? []).toString()).toBe("first-secret");
    await Promise.resolve();
    expect(firstSendSettled).toBe(false);

    const next = harness.pullOutgoing();
    await firstSend;
    expect(first.Data?.every((byte) => byte === 0)).toBe(true);
    const secondSend = harness.manager.send(tunnelSend("tunnel-clear", "second-secret"));
    const second = await next;
    expect(Buffer.from(second.Data ?? []).toString()).toBe("second-secret");

    const completionPull = harness.pullOutgoing().catch(() => undefined);
    await secondSend;
    expect(second.Data?.every((byte) => byte === 0)).toBe(true);
    await harness.stop();
    await completionPull;
  });

  test("rejects a delivered-frame send when stopped before a successor pull", async () => {
    const harness = new TunnelHarness(false);
    harness.manager.openOutput("tunnel-stop", { maxBufferedBytes: 64 });

    const send = harness.manager.send(tunnelSend("tunnel-stop", "stop-secret"));
    const delivered = await harness.pullOutgoing();
    expect(Buffer.from(delivered.Data ?? []).toString()).toBe("stop-secret");

    await harness.stop();
    await expect(send).rejects.toThrow("Tunnel is closed");
    expect(delivered.Data?.every((byte) => byte === 0)).toBe(true);
  });

  test("rejects and clears only the delivered frame owned by a cancelled tunnel", async () => {
    const harness = new TunnelHarness(false);
    harness.manager.openOutput("tunnel-cancel", { maxBufferedBytes: 64 });

    const send = harness.manager.send(tunnelSend("tunnel-cancel", "cancel-secret"));
    const rejection = expect(send).rejects.toThrow("Tunnel is closed");
    const delivered = await harness.pullOutgoing();
    harness.manager.cancelTunnel("tunnel-cancel");

    await rejection;
    expect(delivered.Data?.every((byte) => byte === 0)).toBe(true);
  });

  test("does not clear another tunnel's delivered frame during cancellation", async () => {
    const harness = new TunnelHarness(false);
    harness.manager.openOutput("tunnel-live", { maxBufferedBytes: 64 });
    harness.manager.openOutput("tunnel-other", { maxBufferedBytes: 64 });

    const send = harness.manager.send(tunnelSend("tunnel-live", "live-secret"));
    let sendSettled = false;
    void send.then(
      () => { sendSettled = true; },
      () => { sendSettled = true; },
    );
    const delivered = await harness.pullOutgoing();
    harness.manager.cancelTunnel("tunnel-other");
    await Promise.resolve();

    expect(sendSettled).toBe(false);
    expect(Buffer.from(delivered.Data ?? []).toString()).toBe("live-secret");
    const completionPull = harness.pullOutgoing().catch(() => undefined);
    await send;
    expect(delivered.Data?.every((byte) => byte === 0)).toBe(true);
    await harness.stop();
    await completionPull;
  });

  test("rejects and clears a delivered frame when the transport iterator returns", async () => {
    const harness = new TunnelHarness(false);
    harness.manager.openOutput("tunnel-return", { maxBufferedBytes: 64 });

    const send = harness.manager.send(tunnelSend("tunnel-return", "return-secret"));
    const rejection = expect(send).rejects.toThrow("Tunnel is closed");
    const delivered = await harness.pullOutgoing();
    await harness.returnOutgoing();

    await rejection;
    expect(delivered.Data?.every((byte) => byte === 0)).toBe(true);
  });

  test("caps active tunnels and fails output overflow without retaining data", async () => {
    const harness = new TunnelHarness();
    const failure = jest.fn();
    const output = harness.manager.openOutput("overflow", {
      maxBufferedBytes: 3,
      onFailure: failure,
    });
    harness.incoming.push(tunnelMessage("overflow", "session", Buffer.from("ab")));
    harness.incoming.push(tunnelMessage("overflow", "session", Buffer.from("cd")));
    await waitFor(() => failure.mock.calls.length === 1);

    await expect(output[Symbol.asyncIterator]().next()).rejects.toThrow("bounded buffer");
    expect(failure).toHaveBeenCalledWith("overflow");
    expect(harness.manager.stats()).toEqual({ activeTunnels: 0, queuedFrames: 0, queuedBytes: 0 });

    for (let index = 0; index < TUNNEL_MANAGER_MAX_ACTIVE_TUNNELS; index += 1) {
      harness.manager.openOutput(`capacity-${index}`, { maxBufferedBytes: 1 });
    }
    expect(() => harness.manager.openOutput("one-too-many", { maxBufferedBytes: 1 })).toThrow(
      "capacity is exhausted",
    );
  });

  test("isolates a single-frame output overflow to its tunnel", async () => {
    const harness = new TunnelHarness();
    const overflowFailure = jest.fn();
    const healthyFailure = jest.fn();
    const overflowOutput = harness.manager.openOutput("single-overflow", {
      maxBufferedBytes: 1,
      onFailure: overflowFailure,
    });
    const healthyOutput = harness.manager.openOutput("healthy", {
      maxBufferedBytes: 4,
      onFailure: healthyFailure,
    });

    harness.incoming.push(tunnelMessage("single-overflow", "session", Buffer.from("ab")));
    harness.incoming.push(tunnelMessage("healthy", "session", Buffer.from("ok")));
    await waitFor(() => overflowFailure.mock.calls.length === 1);

    await expect(overflowOutput[Symbol.asyncIterator]().next()).rejects.toThrow("bounded buffer");
    await expect(healthyOutput[Symbol.asyncIterator]().next()).resolves.toEqual({
      value: Uint8Array.from(Buffer.from("ok")), done: false,
    });
    expect(overflowFailure).toHaveBeenCalledWith("overflow");
    expect(healthyFailure).not.toHaveBeenCalled();
    expect(harness.manager.stats().activeTunnels).toBe(1);
  });

  test("reports transport failure as a sanitized RxJS error", async () => {
    const harness = new TunnelHarness();
    const errors: Error[] = [];
    const completed = jest.fn();
    harness.manager.subscribe("legacy-transport").subscribe({
      error: (error) => errors.push(error as Error),
      complete: completed,
    });

    harness.incoming.fail(new Error("TOP-SECRET-TRANSPORT-DETAIL"));
    await waitFor(() => errors.length === 1);

    expect(errors[0]?.message).toBe("Tunnel transport disconnected");
    expect(errors[0]?.message).not.toMatch(/TOP-SECRET/u);
    expect(completed).not.toHaveBeenCalled();
  });
});

class TunnelHarness {
  readonly manager = new TunnelManager();
  readonly incoming = new PushAsyncIterable<TunnelData>();
  readonly outbound: Array<DeepPartial<TunnelData>> = [];

  private outgoingIterator: AsyncIterator<DeepPartial<TunnelData>> | null = null;
  private stopped = false;

  get streamStarted(): boolean {
    return this.outgoingIterator !== null;
  }

  constructor(
    autoConsume = true,
    private readonly onOutbound?: (message: DeepPartial<TunnelData>) => void,
    private readonly echoRemoteClose = true,
  ) {
    activeHarnesses.add(this);
    this.manager.start({
      tunnelData: (outgoing: AsyncIterable<DeepPartial<TunnelData>>, options: { signal: AbortSignal }) => {
        this.outgoingIterator = outgoing[Symbol.asyncIterator]();
        options.signal.addEventListener("abort", () => this.incoming.close(), { once: true });
        if (autoConsume) void this.consumeOutgoing().catch(() => undefined);
        return this.incoming;
      },
    } as never);
  }

  async pullOutgoing(): Promise<DeepPartial<TunnelData>> {
    if (!this.outgoingIterator) throw new Error("Missing tunnel request iterator");
    const result = await this.outgoingIterator.next();
    if (result.done) throw new Error("Tunnel request iterator ended unexpectedly");
    return result.value;
  }

  async returnOutgoing(): Promise<void> {
    if (!this.outgoingIterator?.return) throw new Error("Missing tunnel request iterator return");
    await this.outgoingIterator.return();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.incoming.close();
    await this.manager.stop();
    activeHarnesses.delete(this);
  }

  private async consumeOutgoing(): Promise<void> {
    if (!this.outgoingIterator) return;
    for (;;) {
      const result = await this.outgoingIterator.next();
      if (result.done) return;
      const message = result.value.Data
        ? { ...result.value, Data: Buffer.from(result.value.Data) }
        : result.value;
      this.outbound.push(message);
      this.onOutbound?.(message);
      if (this.echoRemoteClose && Buffer.from(message.Data ?? []).toString("utf8") === "logout\n") {
        this.incoming.push(tunnelMessage(
          message.TunnelID ?? "", message.SessionID ?? "", Buffer.alloc(0), true,
        ));
      }
    }
  }
}

class PushAsyncIterable<T> implements AsyncIterable<T> {
  private readonly queue: T[] = [];
  private waiter: {
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  } | null = null;
  private closed = false;
  private failure: unknown | null = null;

  push(value: T): void {
    if (this.closed) return;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.resolve({ value, done: false });
      return;
    }
    this.queue.push(value);
  }

  close(): void {
    this.closed = true;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.resolve({ value: undefined as never, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.closed) return;
    this.failure = error;
    this.closed = true;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        if (this.failure !== null) throw this.failure;
        const value = this.queue.shift();
        if (value !== undefined) return { value, done: false };
        if (this.closed) return { value: undefined as never, done: true };
        return new Promise((resolve, reject) => {
          this.waiter = { resolve, reject };
        });
      },
    };
  }
}

function clientWithShellRpc(
  manager: TunnelManager,
  control: Record<string, unknown>,
): SliverClient {
  const client = new SliverClient(baseConfig());
  const internals = client as unknown as { rpcClients: Record<string, unknown>; tunnels: TunnelManager };
  internals.rpcClients.control = control;
  internals.rpcClients.artifact = control;
  internals.tunnels = manager;
  return client;
}

function baseConfig(): SliverClientConfig {
  return {
    operator: "test",
    lhost: "127.0.0.1",
    lport: 31_337,
    ca_certificate: "ca",
    certificate: "certificate",
    private_key: "private-key",
    token: "token",
  };
}

function shellResponse(tunnelId: string, path: string, pid: number, pty: boolean, error = "") {
  return {
    Path: path,
    EnablePTY: pty,
    Pid: pid,
    TunnelID: tunnelId,
    Response: error ? { Err: error, Async: false, BeaconID: "", TaskID: "" } : undefined,
  };
}

function tunnelSend(tunnelId: string, data: string): DeepPartial<TunnelData> {
  return { TunnelID: tunnelId, SessionID: "session", Data: Buffer.from(data) };
}

function tunnelMessage(tunnelId: string, sessionId: string, data: Buffer, closed = false): TunnelData {
  return {
    Data: data,
    Closed: closed,
    Sequence: "0",
    Ack: "0",
    Resend: false,
    CreateReverse: false,
    TunnelID: tunnelId,
    SessionID: sessionId,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for test condition");
}
