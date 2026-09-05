import { gunzipSync } from "node:zlib";

jest.mock("../messageBudget", () => {
  const actual = jest.requireActual<typeof import("../messageBudget")>("../messageBudget");
  return {
    ...actual,
    WORKBENCH_ARTIFACT_MAX_PAYLOAD_BYTES: 32,
  };
});

import { InteractiveSession } from "../client";

function sessionWithUpload(upload: jest.Mock): InteractiveSession {
  return new InteractiveSession(
    {} as never,
    { upload } as never,
    {} as never,
    "session-legacy-upload",
  );
}

describe("legacy bounded upload compatibility", () => {
  test("rejects decoded input beyond the reviewed ceiling before compression or dispatch", () => {
    const upload = jest.fn();
    const session = sessionWithUpload(upload);

    expect(() => session.upload("/tmp/oversized.bin", Buffer.alloc(33), 0)).toThrow(
      "Upload exceeds the 32-byte workbench limit",
    );
    expect(upload).not.toHaveBeenCalled();
  });

  test.each(["success", "RPC rejection"] as const)(
    "clears the owned compressed payload after %s without mutating caller bytes",
    async (outcome) => {
      const source = Buffer.from("caller-owned upload bytes");
      const expected = Buffer.from(source);
      let compressed: Buffer | undefined;
      const upload = jest.fn(async (request: { Data: Buffer }) => {
        compressed = request.Data;
        expect(gunzipSync(request.Data)).toEqual(expected);
        if (outcome === "RPC rejection") throw new Error("transport rejected upload");
        return {};
      });
      const pending = sessionWithUpload(upload).upload("/tmp/upload.bin", source, 0);

      if (outcome === "RPC rejection") {
        await expect(pending).rejects.toThrow("transport rejected upload");
      } else {
        await expect(pending).resolves.toEqual({});
      }
      expect(source).toEqual(expected);
      expect(compressed).toBeDefined();
      expect(compressed!.every((byte) => byte === 0)).toBe(true);
    },
  );

  test("snapshots caller bytes before asynchronous compression", async () => {
    const source = Buffer.alloc(32, 0x41);
    const expected = Buffer.from(source);
    const upload = jest.fn(async (request: { Data: Buffer }) => {
      expect(gunzipSync(request.Data)).toEqual(expected);
      return {};
    });

    const pending = sessionWithUpload(upload).upload("/tmp/upload.bin", source, 0);
    source.fill(0);

    await expect(pending).resolves.toEqual({});
    expect(upload).toHaveBeenCalledTimes(1);
  });
});
