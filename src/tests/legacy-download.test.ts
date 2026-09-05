import { gzipSync } from "node:zlib";

jest.mock("../messageBudget", () => {
  const actual = jest.requireActual<typeof import("../messageBudget")>("../messageBudget");
  return {
    ...actual,
    RPC_MESSAGE_BUDGETS: Object.freeze({
      ...actual.RPC_MESSAGE_BUDGETS,
      artifact: Object.freeze({
        ...actual.RPC_MESSAGE_BUDGETS.artifact,
        maxReceiveBytes: 32,
      }),
    }),
  };
});

import { InteractiveSession } from "../client";

function sessionWithDownload(download: jest.Mock): InteractiveSession {
  return new InteractiveSession(
    {} as never,
    { download } as never,
    {} as never,
    "session-legacy-download",
  );
}

describe("legacy bounded download compatibility", () => {
  test("decodes a valid gzip response within the legacy transport budget", async () => {
    const compressed = gzipSync(Buffer.from("valid payload"));
    const download = jest.fn(async () => ({
      Data: compressed,
      Encoder: "gzip",
      Exists: true,
      IsDir: false,
      Response: undefined,
    }));

    const decoded = await sessionWithDownload(download).download("/tmp/valid.bin", 0);
    expect(decoded.toString()).toBe("valid payload");
    expect(compressed.every((byte) => byte === 0)).toBe(true);
    decoded.fill(0);
  });

  test("aborts gzip expansion at the artifact-channel budget and clears compressed input", async () => {
    const compressed = gzipSync(Buffer.alloc(4_096, 0x41));
    const download = jest.fn(async () => ({
      Data: compressed,
      Encoder: "gzip",
      Exists: true,
      IsDir: false,
      Response: undefined,
    }));

    await expect(sessionWithDownload(download).download("/tmp/expansion.bin", 0)).rejects.toThrow(
      "Download exceeds the 32-byte decoded limit or is invalid gzip",
    );
    expect(compressed.every((byte) => byte === 0)).toBe(true);
  });

  test("clears unavailable and target-error payloads before returning safe errors", async () => {
    const unavailable = Buffer.from("unavailable-target-data");
    const rejected = Buffer.from("rejected-target-data");
    const download = jest
      .fn()
      .mockResolvedValueOnce({
        Data: unavailable,
        Encoder: "",
        Exists: false,
        IsDir: false,
        Response: undefined,
      })
      .mockResolvedValueOnce({
        Data: rejected,
        Encoder: "",
        Exists: true,
        IsDir: false,
        Response: { Err: "TOP-SECRET-TARGET-DETAIL" },
      });
    const session = sessionWithDownload(download);

    await expect(session.download("/tmp/missing.bin", 0)).rejects.toThrow(
      "Download is unavailable or is not a single file",
    );
    const targetError = session.download("/tmp/rejected.bin", 0);
    await expect(targetError).rejects.toThrow(
      "Download was rejected by the target",
    );
    await expect(targetError).rejects.not.toThrow(/TOP-SECRET/u);
    expect(unavailable.every((byte) => byte === 0)).toBe(true);
    expect(rejected.every((byte) => byte === 0)).toBe(true);
  });

  test("clears truncated gzip input after wiping emitted partial plaintext", async () => {
    const complete = gzipSync(Buffer.from("partial-output"));
    const truncated = Buffer.from(complete.subarray(0, complete.length - 8));
    complete.fill(0);
    const download = jest.fn(async () => ({
      Data: truncated,
      Encoder: "gzip",
      Exists: true,
      IsDir: false,
      Response: undefined,
    }));

    await expect(sessionWithDownload(download).download("/tmp/truncated.bin", 0)).rejects.toThrow(
      /invalid gzip/u,
    );
    expect(truncated.every((byte) => byte === 0)).toBe(true);
  });
});
