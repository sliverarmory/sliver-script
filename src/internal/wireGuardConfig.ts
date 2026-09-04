import { isIP } from "node:net";

export function validateWireGuardKey(value: string, field: string): void {
  if (!/^[0-9a-fA-F]{64}$/u.test(value)) {
    throw new Error(`Invalid sliver config: wg.${field} must be exactly 64 hexadecimal characters`);
  }
  if (/^0{64}$/u.test(value)) {
    throw new Error(`Invalid sliver config: wg.${field} must not be an all-zero WireGuard key`);
  }
}

export function wireGuardAddressFamily(value: string, field: string): 4 | 6 {
  if (value !== value.trim()) {
    throw new Error(`Invalid sliver config: wg.${field} is not a valid IP address or prefix`);
  }
  const parts = value.split("/");
  if (parts.length > 2) {
    throw new Error(`Invalid sliver config: wg.${field} is not a valid IP address or prefix`);
  }
  const address = parts[0] ?? "";
  const family = isIP(address);
  if (family !== 4 && family !== 6) {
    throw new Error(`Invalid sliver config: wg.${field} is not a valid IP address or prefix`);
  }
  if (address.includes("%") || (family === 6 && isIPv4MappedIPv6(address))) {
    throw new Error(`Invalid sliver config: wg.${field} is not a valid IP address or prefix`);
  }
  if (parts.length === 2) {
    const prefix = parts[1] ?? "";
    const maximum = family === 4 ? 32 : 128;
    if (!/^(0|[1-9][0-9]*)$/u.test(prefix) || Number(prefix) !== maximum) {
      throw new Error(`Invalid sliver config: wg.${field} is not a valid IP address or prefix`);
    }
  }
  return family;
}

function isIPv4MappedIPv6(value: string): boolean {
  let normalized = value.toLowerCase();
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const octets = normalized.slice(lastColon + 1).split(".").map(Number);
    if (lastColon < 0 || octets.length !== 4) return false;
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    normalized = `${normalized.slice(0, lastColon)}:${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return false;
  const left = halves[0] === "" ? [] : (halves[0] ?? "").split(":");
  const right = halves.length === 1 || halves[1] === "" ? [] : (halves[1] ?? "").split(":");
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  const hextets = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ].map((hextet) => Number.parseInt(hextet, 16));
  return hextets.length === 8
    && hextets.slice(0, 5).every((hextet) => hextet === 0)
    && hextets[5] === 0xffff;
}
