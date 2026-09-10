/**
 * SSRF guard (P0 security defect #10) — PURE, unit-tested.
 *
 * Blocks requests whose hostname resolves to a private, loopback, link-local,
 * carrier-grade-NAT, or cloud-metadata address, and enforces an approved-host
 * allowlist. Every redirect hop must be re-validated by the caller — this
 * module gives the primitives; http.ts follows redirects manually and calls
 * `assertUrlAllowed` on each hop.
 */

import { lookup } from "dns/promises";

/** True for an IPv4/IPv6 literal that must never be fetched server-side. */
export function isBlockedIp(ip: string): boolean {
  const v = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  // IPv6
  if (v.includes(":")) {
    if (v === "::1" || v === "::") return true; // loopback / unspecified
    if (v.startsWith("fe80") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb")) return true; // link-local fe80::/10
    if (v.startsWith("fc") || v.startsWith("fd")) return true; // unique-local fc00::/7
    // IPv4-mapped IPv6 (::ffff:a.b.c.d)
    const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]);
    return false;
  }
  const parts = v.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // malformed ⇒ block
  const [a, b] = parts;
  if (a === 0 || a === 127) return true; // this-network / loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local + 169.254.169.254 metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 & 192.0.2.0/24 (test)
  if (a >= 224) return true; // multicast / reserved / broadcast
  return false;
}

export interface HostPolicy {
  allowedHosts: string[];
  maxBytes: number;
}

/** Hostname is on the allowlist (exact or a subdomain of an allowed apex). */
export function hostAllowed(hostname: string, allowedHosts: string[]): boolean {
  const h = hostname.toLowerCase();
  return allowedHosts.some((allowed) => h === allowed.toLowerCase() || h.endsWith(`.${allowed.toLowerCase()}`));
}

/**
 * Validate a single URL (one redirect hop): https only, host on the
 * allowlist, and EVERY resolved IP non-private. Throws with a precise reason.
 * `resolveDns` is injectable for tests.
 */
export async function assertUrlAllowed(
  url: string,
  policy: HostPolicy,
  resolveDns: (host: string) => Promise<string[]> = defaultResolve
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Blocked malformed URL: ${url}`);
  }
  if (parsed.protocol !== "https:") throw new Error(`Blocked non-HTTPS URL: ${parsed.protocol}//`);
  if (parsed.username || parsed.password) throw new Error("Blocked URL with embedded credentials");
  if (!hostAllowed(parsed.hostname, policy.allowedHosts)) throw new Error(`Blocked unapproved host: ${parsed.hostname}`);
  // If the host is an IP literal, check it directly; else resolve and check all.
  const literal = parsed.hostname.replace(/^\[|\]$/g, "");
  const ips = /^[\d.]+$/.test(literal) || literal.includes(":") ? [literal] : await resolveDns(parsed.hostname);
  if (ips.length === 0) throw new Error(`Blocked host with no DNS resolution: ${parsed.hostname}`);
  for (const ip of ips) {
    if (isBlockedIp(ip)) throw new Error(`Blocked private/reserved address ${ip} for host ${parsed.hostname}`);
  }
  return parsed;
}

async function defaultResolve(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true });
  return records.map((r) => r.address);
}
