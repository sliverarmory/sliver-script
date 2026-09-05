import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ParseConfig, ParseConfigFile } from "../config";

const TEST_CONFIG = JSON.stringify({
  operator: "moloch",
  token: "test-token",
  lhost: "localhost",
  lport: 31_337,
  ca_certificate: "test-ca",
  private_key: "test-private-key",
  certificate: "test-certificate",
});

test("ParseConfig validates a direct mTLS operator config", () => {
  const config = ParseConfig(Buffer.from(TEST_CONFIG));
  expect(config.operator).toBe("moloch");
  expect(config.lhost).toBe("localhost");
  expect(config.lport).toBe(31_337);
});

test("ParseConfigFile reads a direct mTLS operator config", async () => {
  const configPath = path.join(os.tmpdir(), `sliver-script-test-${Math.random()}`);
  fs.writeFileSync(configPath, Buffer.from(TEST_CONFIG), { mode: 0o600 });
  try {
    const config = await ParseConfigFile(configPath);
    expect(config.operator).toBe("moloch");
    expect(config.lhost).toBe("localhost");
    expect(config.lport).toBe(31_337);
    expect(config.token).toBe("test-token");
  } finally {
    fs.unlinkSync(configPath);
  }
});

test("ParseConfig retains wg only as passive unsupported-transport metadata", () => {
  const parsed = JSON.parse(TEST_CONFIG) as Record<string, unknown>;
  parsed.wg = { server_pub_key: "not-consumed" };
  const config = ParseConfig(Buffer.from(JSON.stringify(parsed)));

  expect(config.wg).toEqual({ server_pub_key: "not-consumed" });
});

test.each([0, -1, 65_536, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  "ParseConfig rejects invalid operator port %p",
  (lport) => {
    const parsed = JSON.parse(TEST_CONFIG) as Record<string, unknown>;
    parsed.lport = lport;
    expect(() => ParseConfig(Buffer.from(JSON.stringify(parsed)))).toThrow(/invalid lport/u);
  },
);
