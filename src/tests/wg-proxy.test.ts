import {
  hasWireGuardWrapper,
  packageRootForDirectory,
  serializeWireGuardHelperConfig,
  startWireGuardProxy,
  wireGuardHelperBuildEnvironment,
  wireGuardHelperRuntimeEnvironment,
} from "../internal/wgProxy";
import type { SliverClientConfig } from "../config";

const SERVER_PUBLIC_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const CLIENT_PRIVATE_KEY = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const CLIENT_PUBLIC_KEY = "2222222222222222222222222222222222222222222222222222222222222222";
const PRESHARED_KEY = "1111111111111111111111111111111111111111111111111111111111111111";

function config(): SliverClientConfig {
  return {
    operator: "operator-must-not-cross",
    token: "token-must-not-cross",
    lhost: "wireguard.example.test",
    lport: 31337,
    ca_certificate: "ca-must-not-cross",
    certificate: "certificate-must-not-cross",
    private_key: "rpc-key-must-not-cross",
    wg: {
      enabled: true,
      server_pub_key: SERVER_PUBLIC_KEY,
      client_private_key: CLIENT_PRIVATE_KEY,
      client_pub_key: CLIENT_PUBLIC_KEY,
      preshared_key: PRESHARED_KEY,
      client_ip: "100.65.0.2",
      server_ip: "100.65.0.1",
    },
  };
}

test("WireGuard helper payload exposes only the endpoint and consumed wg fields", () => {
  const serialized = serializeWireGuardHelperConfig(config());
  try {
    expect(JSON.parse(serialized.toString("utf8"))).toEqual({
      lhost: "wireguard.example.test",
      lport: 31337,
      wg: {
        server_pub_key: SERVER_PUBLIC_KEY,
        client_private_key: CLIENT_PRIVATE_KEY,
        preshared_key: PRESHARED_KEY,
        client_ip: "100.65.0.2",
        server_ip: "100.65.0.1",
      },
    });
    expect(serialized.at(-1)).toBe("\n".charCodeAt(0));
  } finally {
    serialized.fill(0);
  }
});

test("bundled mode has no current-working-directory trust fallback", () => {
  expect(packageRootForDirectory(undefined)).toBeNull();
});

test("runtime helper builds are hermetic Go-only module builds", () => {
  expect(wireGuardHelperBuildEnvironment({
    CGO_ENABLED: "1",
    GOTOOLCHAIN: "go1.26.6",
    GOWORK: "/untrusted/go.work",
    PATH: "/test/bin",
  })).toEqual({
    CGO_ENABLED: "0",
    GOTOOLCHAIN: "go1.26.6",
    GOWORK: "off",
    PATH: "/test/bin",
  });
  expect(wireGuardHelperBuildEnvironment({})).toEqual({
    CGO_ENABLED: "0",
    GOTOOLCHAIN: "local",
    GOWORK: "off",
  });
});

test("runtime helper receives no ambient credentials", () => {
  const environment = {
    PATH: "/secret/tool-path",
    HOME: "/secret/home",
    NPM_TOKEN: "npm-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    SLIVER_TOKEN: "sliver-secret",
    TMPDIR: "/safe/tmp",
    SystemRoot: "C:\\Windows",
    TEMP: "C:\\Temp",
  };
  expect(wireGuardHelperRuntimeEnvironment(environment, "darwin")).toEqual({
    TMPDIR: "/safe/tmp",
  });
  expect(wireGuardHelperRuntimeEnvironment(environment, "win32")).toEqual({
    SYSTEMROOT: "C:\\Windows",
    TEMP: "C:\\Temp",
  });
});

test("automatic transport selection requires the current explicit opt-in marker", () => {
  const enabled = config();
  expect(hasWireGuardWrapper(enabled)).toBe(true);
  expect(hasWireGuardWrapper({ ...enabled, wg: { ...enabled.wg!, enabled: false } })).toBe(false);
  const { enabled: _enabled, ...legacyWG } = enabled.wg!;
  expect(hasWireGuardWrapper({ ...enabled, wg: legacyWG })).toBe(false);
  expect(hasWireGuardWrapper({ ...enabled, wg: undefined })).toBe(false);
});

test("configured helper override must be an absolute non-symlink path", async () => {
  const previous = process.env.SLIVER_SCRIPT_WG_PROXY_BINARY;
  process.env.SLIVER_SCRIPT_WG_PROXY_BINARY = "cwd-planted-helper";
  try {
    await expect(startWireGuardProxy(config())).rejects.toThrow(
      "Configured WireGuard helper does not exist: cwd-planted-helper",
    );
  } finally {
    if (previous === undefined) {
      delete process.env.SLIVER_SCRIPT_WG_PROXY_BINARY;
    } else {
      process.env.SLIVER_SCRIPT_WG_PROXY_BINARY = previous;
    }
  }
});

test.each([
  ["short public key", { server_pub_key: "abcd" }],
  ["non-hex private key", { client_private_key: "z".repeat(64) }],
  ["newline directive injection", { server_pub_key: `${"a".repeat(64)}\nendpoint=attacker.example:1` }],
  ["invalid preshared key", { preshared_key: "g".repeat(64) }],
])("rejects %s before resolving or spawning the helper", async (_label, replacement) => {
  await expect(startWireGuardProxy({
    ...config(),
    wg: { ...config().wg!, ...replacement },
  })).rejects.toThrow(/exactly 64 hexadecimal characters/u);
});

test.each(["server_pub_key", "client_private_key", "client_pub_key", "preshared_key"] as const)(
  "rejects an all-zero %s before resolving or spawning the helper",
  async (field) => {
    await expect(startWireGuardProxy({
      ...config(),
      wg: { ...config().wg!, [field]: "0".repeat(64) },
    })).rejects.toThrow(/all-zero WireGuard key/u);
  },
);

test.each(["fe80::1%lo0", "::ffff:192.0.2.1", "0:0:0:0:0:ffff:c000:201", "100.65.0.2/24"])(
  "rejects unsupported address %s before resolving or spawning the helper",
  async (clientIP) => {
    await expect(startWireGuardProxy({
      ...config(),
      wg: {
        ...config().wg!,
        client_ip: clientIP,
        server_ip: clientIP.includes(":") ? "fd00::1" : "100.65.0.1",
      },
    })).rejects.toThrow(/valid IP address or prefix/u);
  },
);

test("rejects client/server address-family mismatch before resolving or spawning the helper", async () => {
  await expect(startWireGuardProxy({
    ...config(),
    wg: { ...config().wg!, client_ip: "fd00::2", server_ip: "100.65.0.1" },
  })).rejects.toThrow(/same address family/u);
});
