import { SliverClient } from "../client";
import type { SliverClientConfig } from "../config";
import { Version } from "../pb/clientpb/client";
import { timeoutSecondsToNanoseconds, withTimeoutSignal } from "../internal/timeout";

const MAX_TIMEOUT_SECONDS = 2_147_483;
const invalidTimeouts = [
  -1,
  0.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  MAX_TIMEOUT_SECONDS + 1,
  Number.MAX_SAFE_INTEGER,
] as const;

describe("Sliver operation timeout encoding", () => {
  test("matches the pinned Go client's nanoseconds-minus-one wire values", () => {
    expect(timeoutSecondsToNanoseconds(0)).toBe("0");
    expect(timeoutSecondsToNanoseconds(1)).toBe("999999999");
    expect(timeoutSecondsToNanoseconds(60)).toBe("59999999999");
    expect(timeoutSecondsToNanoseconds(MAX_TIMEOUT_SECONDS)).toBe("2147482999999999");
  });

  test.each(invalidTimeouts)("rejects invalid timeout %s before encoding", (timeout) => {
    expect(() => timeoutSecondsToNanoseconds(timeout)).toThrow(RangeError);
  });

  test.each(invalidTimeouts)("rejects invalid timeout %s before invoking a callback", async (timeout) => {
    const callback = jest.fn(async (_signal: AbortSignal) => "called");

    await expect(withTimeoutSignal(timeout, callback)).rejects.toBeInstanceOf(RangeError);
    expect(callback).not.toHaveBeenCalled();
  });

  test.each(invalidTimeouts)("rejects invalid timeout %s before RPC dispatch", async (timeout) => {
    const getVersion = jest.fn(async () => Version.create());
    const client = clientWithControlRpc({ getVersion });

    await expect(client.getVersion(timeout)).rejects.toBeInstanceOf(RangeError);
    expect(getVersion).not.toHaveBeenCalled();
  });

  test("accepts zero and the supported timer ceiling", async () => {
    const callback = jest.fn(async (signal: AbortSignal) => signal.aborted);

    await expect(withTimeoutSignal(0, callback)).resolves.toBe(false);
    await expect(withTimeoutSignal(MAX_TIMEOUT_SECONDS, callback)).resolves.toBe(false);
    expect(callback).toHaveBeenCalledTimes(2);
  });
});

function clientWithControlRpc(controlRpc: object): SliverClient {
  const config: SliverClientConfig = {
    operator: "timeout-test",
    lhost: "127.0.0.1",
    lport: 31_337,
    ca_certificate: "fixture-ca",
    certificate: "fixture-cert",
    private_key: "fixture-key",
    token: "fixture-token",
  };
  const client = new SliverClient(config);
  const internals = client as unknown as { rpcClients: Record<string, object> };
  internals.rpcClients.control = controlRpc;
  return client;
}
