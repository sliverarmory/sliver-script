const createSsl = jest.fn();
const combineChannelCredentials = jest.fn();
const createFromMetadataGenerator = jest.fn();
const metadataSet = jest.fn();

jest.mock("@grpc/grpc-js", () => ({
  credentials: {
    createSsl: (...args: unknown[]) => createSsl(...args),
    combineChannelCredentials: (...args: unknown[]) => combineChannelCredentials(...args),
    createFromMetadataGenerator: (...args: unknown[]) => createFromMetadataGenerator(...args),
  },
  Metadata: class {
    set(...args: unknown[]) {
      metadataSet(...args);
    }
  },
}));

import { createSliverRpcCredentials } from "../internal/credentials";
import type { SliverClientConfig } from "../config";

function config(overrides: Partial<SliverClientConfig> = {}): SliverClientConfig {
  return {
    operator: "operator",
    lhost: "127.0.0.1",
    lport: 31_337,
    ca_certificate: "managed-ca",
    certificate: "operator-certificate",
    private_key: "operator-private-key",
    token: "operator-token",
    ...overrides,
  };
}

describe("Sliver channel credentials", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createSsl.mockReturnValue({ kind: "tls" });
    createFromMetadataGenerator.mockReturnValue({ kind: "token" });
    combineChannelCredentials.mockReturnValue({ kind: "combined" });
  });

  test("pins the managed CA and clears temporary TLS material", () => {
    const snapshots: string[] = [];
    let temporaryBuffers: Buffer[] = [];
    createSsl.mockImplementation((ca: Buffer, privateKey: Buffer, certificate: Buffer) => {
      temporaryBuffers = [ca, privateKey, certificate];
      snapshots.push(ca.toString(), privateKey.toString(), certificate.toString());
      return { kind: "tls" };
    });

    expect(createSliverRpcCredentials(config())).toEqual({ kind: "combined" });

    expect(snapshots).toEqual(["managed-ca", "operator-private-key", "operator-certificate"]);
    expect(temporaryBuffers).toHaveLength(3);
    for (const bytes of temporaryBuffers) expect(bytes.every((byte) => byte === 0)).toBe(true);
    expect(createSsl).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.any(Buffer),
      expect.any(Buffer),
      expect.objectContaining({ rejectUnauthorized: true, checkServerIdentity: expect.any(Function) }),
    );
  });

  test("rejects a blank managed CA before creating credentials", () => {
    expect(() => createSliverRpcCredentials(config({ ca_certificate: "  " }))).toThrow(
      "Sliver operator connections require the managed CA",
    );
    expect(createSsl).not.toHaveBeenCalled();
    expect(combineChannelCredentials).not.toHaveBeenCalled();
  });
});
