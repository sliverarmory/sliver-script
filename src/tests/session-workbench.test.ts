import { gunzipSync, gzipSync } from "node:zlib";

import { SliverClient } from "../client";
import type { SliverClientConfig } from "../config";

describe("explicit session workbench wrappers", () => {
  test("binds requests to the selected session and excludes remote service hostnames", async () => {
    const services = jest.fn(async () => ({ Services: [] }));
    const currentTokenOwner = jest.fn(async () => ({ Output: "SYSTEM" }));
    const registryRead = jest.fn(async () => ({ Value: "value" }));
    const client = clientWithRpc({ control: { services, currentTokenOwner, registryRead } });

    await client.servicesSession("session-42", 0);
    await client.currentTokenOwnerSession("session-42", 0);
    await client.registryReadSession("session-42", "HKLM", "Software\\Example", "Value", 0);

    const target = { Async: false, Timeout: "0", BeaconID: "", SessionID: "session-42" };
    expect(services).toHaveBeenCalledWith(
      { Hostname: "", Request: target },
      { signal: expect.any(AbortSignal) },
    );
    expect(currentTokenOwner).toHaveBeenCalledWith(
      { Request: target },
      { signal: expect.any(AbortSignal) },
    );
    expect(registryRead).toHaveBeenCalledWith(
      expect.objectContaining({ Hostname: "", Request: target }),
      { signal: expect.any(AbortSignal) },
    );
  });

  test("routes bounded binary wrappers only through the workbench artifact channel", async () => {
    const workbench = {
      download: jest.fn(async () => ({
        Data: Buffer.from("download"), Encoder: "", Exists: true, IsDir: false, Response: undefined,
      })),
      upload: jest.fn(async () => ({ Path: "/tmp/upload.bin", Response: undefined })),
      screenshot: jest.fn(async () => ({ Data: Buffer.from("png"), Response: undefined })),
      processDump: jest.fn(async () => ({ Data: Buffer.from("dump"), Response: undefined })),
      registryReadHive: jest.fn(async () => ({ Data: Buffer.from("hive"), Encoder: "", Response: undefined })),
    };
    const legacy = {
      download: jest.fn(), upload: jest.fn(), screenshot: jest.fn(), processDump: jest.fn(), registryReadHive: jest.fn(),
    };
    const client = clientWithRpc({ "workbench-artifact": workbench, artifact: legacy });

    await client.downloadFileSession("session-a", "/tmp/download.bin", { maxBytes: 128 }, 0);
    await client.uploadSession("session-a", "/tmp/upload.bin", Buffer.from("upload"), {}, 0);
    await client.screenshotSession("session-a", 0);
    await client.processDumpSession("session-a", 123, 60, 0);
    await client.registryReadHiveSession("session-a", "HKLM", "SAM", 128, 0);

    for (const rpc of Object.values(workbench)) expect(rpc).toHaveBeenCalledTimes(1);
    for (const rpc of Object.values(legacy)) expect(rpc).not.toHaveBeenCalled();
    expect(workbench.download).toHaveBeenCalledWith(
      expect.objectContaining({
        Path: "/tmp/download.bin",
        Recurse: false,
        RestrictedToFile: true,
        MaxBytes: "128",
        Request: expect.objectContaining({ SessionID: "session-a", BeaconID: "" }),
      }),
      { signal: expect.any(AbortSignal) },
    );
  });

  test("maps tail reads to negative MaxBytes and clears an oversized target buffer", async () => {
    const remoteBytes = Buffer.alloc(65_538, 0x41);
    const download = jest.fn(async () => ({
      Data: remoteBytes, Encoder: "", Exists: true, IsDir: false, Response: undefined,
    }));
    const client = clientWithRpc({ "workbench-artifact": { download } });

    await expect(client.downloadFileSession(
      "session-tail", "/tmp/tail.txt", { maxBytes: 65_537, fromEnd: true }, 0,
    )).rejects.toThrow(/65537-byte workbench limit/u);
    expect(download).toHaveBeenCalledWith(
      expect.objectContaining({ MaxBytes: "-65537", MaxLines: "0", RestrictedToFile: true }),
      { signal: expect.any(AbortSignal) },
    );
    expect(remoteBytes.every((byte) => byte === 0)).toBe(true);
  });

  test("clears unavailable download data before rejecting it", async () => {
    const unavailableBytes = Buffer.from("target-controlled-unavailable-data");
    const download = jest.fn(async () => ({
      Data: unavailableBytes, Encoder: "", Exists: false, IsDir: false, Response: undefined,
    }));
    const client = clientWithRpc({ "workbench-artifact": { download } });

    await expect(client.downloadFileSession(
      "session-unavailable", "/tmp/missing.bin", { maxBytes: 128 }, 0,
    )).rejects.toThrow("Download is unavailable or is not a single file");
    expect(unavailableBytes.every((byte) => byte === 0)).toBe(true);
  });

  test("binds a byte ceiling for line reads and rejects ambiguous options before dispatch", async () => {
    const download = jest.fn(async () => ({
      Data: Buffer.from("line\n"), Encoder: "", Exists: true, IsDir: false, Response: undefined,
    }));
    const client = clientWithRpc({ "workbench-artifact": { download } });

    await client.downloadFileSession("session-lines", "/tmp/lines.txt", { maxLines: 5 }, 0);
    expect(download).toHaveBeenCalledWith(
      expect.objectContaining({ MaxBytes: String(64 * 1_024 * 1_024), MaxLines: "5" }),
      { signal: expect.any(AbortSignal) },
    );

    expect(() => client.downloadFileSession(
      "session-tail", "/tmp/tail.txt", { maxBytes: 32, fromEnd: true, maxLines: 1 }, 0,
    )).toThrow(/cannot be combined/u);
    expect(() => client.downloadFileSession(
      "session-tail", "/tmp/tail.txt", { maxBytes: 32, fromEnd: "yes" as never }, 0,
    )).toThrow(/must be a boolean/u);
    expect(download).toHaveBeenCalledTimes(1);
  });

  test("uses the explicit process-dump deadline for the request and AbortSignal", async () => {
    const processDump = jest.fn(async (
      _request: { Pid: number; Timeout: number; Request: { Timeout: string } },
      _options: { signal: AbortSignal },
    ) => ({ Data: Buffer.from("dump"), Response: undefined }));
    const client = clientWithRpc({ "workbench-artifact": { processDump } });

    await client.processDumpSession("session-timeout", 42, 120, 150);

    const [request, options] = processDump.mock.calls[0]!;
    expect(request).toMatchObject({
      Pid: 42,
      Timeout: 120,
      Request: { Async: false, BeaconID: "", SessionID: "session-timeout" },
    });
    expect(request.Request.Timeout).toBe("149999999999");
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  test("gives the default process-dump transport deadline time to outlive the target deadline", async () => {
    const processDump = jest.fn(async () => ({ Data: Buffer.from("dump"), Response: undefined }));
    const client = clientWithRpc({ "workbench-artifact": { processDump } });

    await client.processDumpSession("session-default-timeout", 42);

    expect(processDump).toHaveBeenCalledWith(
      expect.objectContaining({
        Timeout: 60,
        Request: expect.objectContaining({ Timeout: "89999999999" }),
      }),
      { signal: expect.any(AbortSignal) },
    );
  });

  test.each([0, 1.5, 2_147_483_648])(
    "rejects process-dump timeout %p outside positive int32 before dispatch",
    (dumpTimeoutSeconds) => {
      const processDump = jest.fn();
      const client = clientWithRpc({ "workbench-artifact": { processDump } });

      expect(() => client.processDumpSession(
        "session-timeout-boundary", 42, dumpTimeoutSeconds, 0,
      )).toThrow(/Process dump timeout/u);
      expect(processDump).not.toHaveBeenCalled();
    },
  );

  test("accepts the maximum process-dump int32 timeout", async () => {
    const processDump = jest.fn(async () => ({ Data: Buffer.alloc(0), Response: undefined }));
    const client = clientWithRpc({ "workbench-artifact": { processDump } });

    await client.processDumpSession("session-timeout-boundary", 42, 2_147_483_647, 0);

    expect(processDump).toHaveBeenCalledWith(
      expect.objectContaining({ Timeout: 2_147_483_647 }),
      { signal: expect.any(AbortSignal) },
    );
  });

  test("enforces protobuf int32 bounds for grep context lines before dispatch", async () => {
    const grep = jest.fn(async () => ({}));
    const client = clientWithRpc({ control: { grep } });

    await client.grepSession(
      "session-grep-boundary",
      "/tmp/file",
      "needle",
      { linesBefore: 2_147_483_647, linesAfter: 2_147_483_647 },
      0,
    );
    expect(grep).toHaveBeenCalledWith(
      expect.objectContaining({ LinesBefore: 2_147_483_647, LinesAfter: 2_147_483_647 }),
      { signal: expect.any(AbortSignal) },
    );

    grep.mockClear();
    expect(() => client.grepSession(
      "session-grep-boundary",
      "/tmp/file",
      "needle",
      { linesBefore: 2_147_483_648 },
      0,
    )).toThrow(/Grep lines before/u);
    expect(grep).not.toHaveBeenCalled();
  });

  test("caps decoded gzip expansion and redacts target errors while clearing buffers", async () => {
    const encoded = gzipSync(Buffer.alloc(4_096, 0x41));
    const targetBytes = Buffer.from("sensitive-target-artifact");
    const download = jest.fn(async () => ({
      Data: encoded, Encoder: "gzip", Exists: true, IsDir: false, Response: undefined,
    }));
    const screenshot = jest.fn(async () => ({
      Data: targetBytes, Response: { Err: "TOP-SECRET-TARGET-ERROR" },
    }));
    const client = clientWithRpc({ "workbench-artifact": { download, screenshot } });

    await expect(client.downloadFileSession(
      "session-b", "/tmp/compressed.bin", { maxBytes: 32 }, 0,
    )).rejects.toThrow(/32-byte decoded limit/u);
    expect(encoded.every((byte) => byte === 0)).toBe(true);

    await expect(client.screenshotSession("session-error", 0)).rejects.toThrow(
      "Screenshot was rejected by the target",
    );
    await expect(client.screenshotSession("session-error", 0)).rejects.not.toThrow(/TOP-SECRET/u);
    expect(targetBytes.every((byte) => byte === 0)).toBe(true);
  });

  test("clears operation-owned upload bytes and rejects oversized input before dispatch", async () => {
    let compressed: Buffer | undefined;
    const expected = Buffer.from("operator upload bytes");
    const upload = jest.fn(async (request: { Data: Buffer }) => {
      compressed = request.Data;
      expect(gunzipSync(request.Data)).toEqual(expected);
      return { Path: "/tmp/upload.bin", Response: { Err: "target-controlled failure" } };
    });
    const client = clientWithRpc({ "workbench-artifact": { upload } });
    const source = Buffer.from(expected);

    const pending = client.uploadSession("session-upload", "/tmp/upload.bin", source, {}, 0);
    source.fill(0);
    await expect(pending).resolves.toMatchObject({
      Response: { Err: "target-controlled failure" },
    });
    expect(compressed).toBeDefined();
    expect(compressed!.every((byte) => byte === 0)).toBe(true);
    expect(source.every((byte) => byte === 0)).toBe(true);

    const oversized = Buffer.alloc((64 * 1_024 * 1_024) + 1);
    expect(() => client.uploadSession("session-c", "/tmp/large.bin", oversized, {}, 0))
      .toThrow(/workbench limit/u);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  test("rejects registry QWORD values outside unsigned 64-bit bounds", () => {
    const registryWrite = jest.fn();
    const client = clientWithRpc({ control: { registryWrite } });

    expect(() => client.registryWriteSession(
      "session-d", "HKLM", "Software\\Example", "Counter",
      { type: "qword", value: "18446744073709551616" }, 0,
    )).toThrow(/unsigned 64-bit/u);
    expect(registryWrite).not.toHaveBeenCalled();
  });

  test("owns, clears, and control-bounds registry binary writes", async () => {
    let finishWrite: ((value: { Response: undefined }) => void) | undefined;
    let captured: Buffer | undefined;
    const registryWrite = jest.fn((request: { ByteValue: Buffer }) => {
      captured = request.ByteValue;
      return new Promise<{ Response: undefined }>((resolve) => {
        finishWrite = resolve;
      });
    });
    const client = clientWithRpc({ control: { registryWrite } });
    const source = Buffer.from("registry binary bytes");

    const pending = client.registryWriteSession(
      "session-d", "HKLM", "Software\\Example", "Payload",
      { type: "binary", value: source }, 0,
    );
    source.fill(0);
    expect(captured?.toString()).toBe("registry binary bytes");
    finishWrite!({ Response: undefined });
    await expect(pending).resolves.toEqual({ Response: undefined });
    expect(captured!.every((byte) => byte === 0)).toBe(true);

    expect(() => client.registryWriteSession(
      "session-d", "HKLM", "Software\\Example", "Payload",
      { type: "binary", value: Buffer.alloc((4 * 1024 * 1024) + 1) }, 0,
    )).toThrow(/control limit/u);
    expect(registryWrite).toHaveBeenCalledTimes(1);
  });
});

function clientWithRpc(rpc: Record<string, Record<string, unknown>>): SliverClient {
  const config: SliverClientConfig = {
    operator: "test",
    lhost: "127.0.0.1",
    lport: 31_337,
    ca_certificate: "",
    certificate: "",
    private_key: "",
    token: "",
  };
  const client = new SliverClient(config);
  const internals = client as unknown as { rpcClients: Record<string, unknown> };
  Object.assign(internals.rpcClients, rpc);
  return client;
}
