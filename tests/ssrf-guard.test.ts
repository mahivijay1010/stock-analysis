/**
 * P0 security #10 — SSRF guard. Private/reserved addresses, non-HTTPS,
 * off-allowlist hosts, embedded credentials and DNS-rebinding (public host
 * that resolves to a private IP) must all be blocked.
 */

import { isBlockedIp, hostAllowed, assertUrlAllowed } from "../src/services/intelligence/ssrfGuard";

describe("isBlockedIp", () => {
  test.each([
    "127.0.0.1",
    "0.0.0.0",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // CGNAT
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "224.0.0.1", // multicast
    "999.1.1.1", // malformed ⇒ block
  ])("blocks %s", (ip) => expect(isBlockedIp(ip)).toBe(true));

  test.each(["8.8.8.8", "1.1.1.1", "13.107.42.14", "142.250.72.14"])("allows public %s", (ip) => expect(isBlockedIp(ip)).toBe(false));

  test("172.15 and 172.32 are public (boundary)", () => {
    expect(isBlockedIp("172.15.0.1")).toBe(false);
    expect(isBlockedIp("172.32.0.1")).toBe(false);
  });
});

describe("hostAllowed", () => {
  const allow = ["nseindia.com", "bseindia.com"];
  test("exact + subdomain match", () => {
    expect(hostAllowed("nseindia.com", allow)).toBe(true);
    expect(hostAllowed("www.nseindia.com", allow)).toBe(true);
  });
  test("rejects look-alikes and off-list hosts", () => {
    expect(hostAllowed("evil-nseindia.com", allow)).toBe(false);
    expect(hostAllowed("attacker.com", allow)).toBe(false);
  });
});

describe("assertUrlAllowed", () => {
  const policy = { allowedHosts: ["nseindia.com"], maxBytes: 1000 };
  const publicDns = async () => ["13.107.42.14"];
  const privateDns = async () => ["169.254.169.254"];

  test("allows an approved host resolving to a public IP", async () => {
    await expect(assertUrlAllowed("https://www.nseindia.com/x", policy, publicDns)).resolves.toBeInstanceOf(URL);
  });

  test("blocks non-HTTPS", async () => {
    await expect(assertUrlAllowed("http://www.nseindia.com/x", policy, publicDns)).rejects.toThrow(/non-HTTPS/);
  });

  test("blocks off-allowlist host", async () => {
    await expect(assertUrlAllowed("https://attacker.com/x", policy, publicDns)).rejects.toThrow(/unapproved host/);
  });

  test("blocks DNS rebinding — approved host that resolves to metadata IP", async () => {
    await expect(assertUrlAllowed("https://www.nseindia.com/x", policy, privateDns)).rejects.toThrow(/private\/reserved/);
  });

  test("blocks embedded credentials", async () => {
    await expect(assertUrlAllowed("https://user:pass@www.nseindia.com/x", policy, publicDns)).rejects.toThrow(/credentials/);
  });

  test("blocks a raw private-IP literal host even if 'allowed'", async () => {
    const p = { allowedHosts: ["169.254.169.254"], maxBytes: 1000 };
    await expect(assertUrlAllowed("https://169.254.169.254/latest/meta-data", p, publicDns)).rejects.toThrow(/private\/reserved/);
  });
});
