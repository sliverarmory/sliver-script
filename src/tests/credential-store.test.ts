import { SliverClient } from "../client";
import type { SliverClientConfig } from "../config";
import { Credential, HashType } from "../pb/clientpb/client";

describe("credential-store RPC wrappers", () => {
  test("isolates inventory reads from control detail and hash-type requests", async () => {
    const stored = Credential.create({ ID: "credential-1", Username: "alice", Plaintext: "secret" });
    const creds = jest.fn(async () => ({ Credentials: [stored] }));
    const getCredByID = jest.fn(async () => stored);
    const credsSniffHashType = jest.fn(async () => ({ HashType: HashType.SHA2_256 }));
    const wrongChannel = {
      creds: jest.fn(), getCredByID: jest.fn(), credsSniffHashType: jest.fn(),
    };
    const client = clientWithRpc({
      inventory: { creds, getCredByID: wrongChannel.getCredByID, credsSniffHashType: wrongChannel.credsSniffHashType },
      control: { getCredByID, credsSniffHashType, creds: wrongChannel.creds },
    });

    await expect(client.credentialsAll(0)).resolves.toEqual([stored]);
    await expect(client.credentialById("credential-1", 0)).resolves.toBe(stored);
    await expect(client.credentialSniffHashType("sha256-value", 0)).resolves.toBe(HashType.SHA2_256);

    expect(creds).toHaveBeenCalledWith({}, { signal: expect.any(AbortSignal) });
    expect(getCredByID).toHaveBeenCalledWith(
      { ID: "credential-1" }, { signal: expect.any(AbortSignal) },
    );
    expect(credsSniffHashType).toHaveBeenCalledWith(
      { Hash: "sha256-value" }, { signal: expect.any(AbortSignal) },
    );
    for (const rpc of Object.values(wrongChannel)) expect(rpc).not.toHaveBeenCalled();
  });

  test("uses singular canonical add and remove envelopes on the control channel", async () => {
    const credsAdd = jest.fn(async () => ({}));
    const credsRm = jest.fn(async () => ({}));
    const inventory = { credsAdd: jest.fn(), credsRm: jest.fn() };
    const client = clientWithRpc({ control: { credsAdd, credsRm }, inventory });
    const callerCredential = Credential.create({
      ID: "caller-controlled-id",
      Username: "alice",
      Plaintext: "password",
      Hash: "hash",
      HashType: HashType.SHA2_256,
      IsCracked: false,
      OriginHostUUID: "caller-controlled-origin",
      Collection: "review",
    });

    await expect(client.credentialAdd(callerCredential, 0)).resolves.toBeUndefined();
    await expect(client.credentialRemove("credential-1", 0)).resolves.toBeUndefined();

    expect(credsAdd).toHaveBeenCalledWith(
      {
        Credentials: [{
          ID: "",
          Username: "alice",
          Plaintext: "password",
          Hash: "hash",
          HashType: HashType.SHA2_256,
          IsCracked: true,
          OriginHostUUID: "",
          Collection: "review",
        }],
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(credsRm).toHaveBeenCalledWith(
      { Credentials: [{ ID: "credential-1" }] },
      { signal: expect.any(AbortSignal) },
    );
    expect(inventory.credsAdd).not.toHaveBeenCalled();
    expect(inventory.credsRm).not.toHaveBeenCalled();
  });

  test("rejects invalid IDs, metadata, secrets, and hash modes before dispatch", () => {
    const control = {
      getCredByID: jest.fn(), credsAdd: jest.fn(), credsRm: jest.fn(), credsSniffHashType: jest.fn(),
    };
    const client = clientWithRpc({ control });
    const valid = Credential.create({ Username: "alice", Plaintext: "password", Collection: "review" });

    expect(() => client.credentialById(" ", 0)).toThrow(/Credential id must not be empty/u);
    expect(() => client.credentialById("i".repeat(65), 0)).toThrow(/must not exceed 64 characters/u);
    expect(() => client.credentialRemove("i".repeat(65), 0)).toThrow(/must not exceed 64 characters/u);
    expect(() => client.credentialAdd({ ...valid, Username: "u".repeat(257) }, 0))
      .toThrow(/username must not exceed 256 characters/u);
    expect(() => client.credentialAdd({ ...valid, Collection: "c".repeat(257) }, 0))
      .toThrow(/collection must not exceed 256 characters/u);
    expect(() => client.credentialAdd({ ...valid, Plaintext: "", Hash: "" }, 0))
      .toThrow(/plaintext or hash must not be empty/u);
    expect(() => client.credentialAdd({ ...valid, Plaintext: "x".repeat(65_537) }, 0))
      .toThrow(/must not exceed 65536 bytes/u);
    expect(() => client.credentialAdd({ ...valid, HashType: 1.5 as never }, 0))
      .toThrow(/hash type must be an integer/u);
    expect(() => client.credentialSniffHashType("", 0)).toThrow(/hash must not be empty/u);
    expect(() => client.credentialSniffHashType("x".repeat(65_537), 0))
      .toThrow(/must not exceed 65536 bytes/u);

    for (const rpc of Object.values(control)) expect(rpc).not.toHaveBeenCalled();
  });

  test("propagates control-plane mutation failures without falling back to inventory", async () => {
    const addFailure = new Error("add mutation failed");
    const removeFailure = new Error("remove mutation failed");
    const credsAdd = jest.fn(async () => Promise.reject(addFailure));
    const credsRm = jest.fn(async () => Promise.reject(removeFailure));
    const inventory = { credsAdd: jest.fn(), credsRm: jest.fn() };
    const client = clientWithRpc({ control: { credsAdd, credsRm }, inventory });

    await expect(client.credentialAdd(Credential.create({ Username: "alice", Plaintext: "password" }), 0))
      .rejects.toBe(addFailure);
    await expect(client.credentialRemove("credential-1", 0)).rejects.toBe(removeFailure);
    expect(inventory.credsAdd).not.toHaveBeenCalled();
    expect(inventory.credsRm).not.toHaveBeenCalled();
  });
});

function clientWithRpc(rpc: Record<string, Record<string, unknown>>): SliverClient {
  const config: SliverClientConfig = {
    operator: "credential-test",
    lhost: "127.0.0.1",
    lport: 31_337,
    ca_certificate: "fixture-ca",
    certificate: "fixture-cert",
    private_key: "fixture-key",
    token: "fixture-token",
  };
  const client = new SliverClient(config);
  const internals = client as unknown as { rpcClients: Record<string, unknown> };
  Object.assign(internals.rpcClients, rpc);
  return client;
}
