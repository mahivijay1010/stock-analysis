/**
 * Angel One SmartAPI session (real-time market data, docs/intraday-study-notes.md
 * §4 item 6 follow-up). PURE-ish: the only I/O is the login POST, injectable
 * for tests.
 *
 * Auth flow (SmartAPI loginByPassword): clientcode + PIN + a 6-digit TOTP
 * derived from the BASE32 secret shown when 2FA was enabled. Returns a
 * jwtToken (REST auth), a refreshToken, and a feedToken — the WebSocket needs
 * jwtToken + feedToken + apiKey + clientcode together.
 *
 * Credentials live ONLY in the environment (.env, gitignored; template in
 * .env.example). Nothing here logs a secret, and `describeConfig()` exists so
 * operators can verify wiring without printing one. Absent credentials are a
 * clean, honest "not configured" — never a silent fallback that pretends the
 * feed is live.
 */

import axios from "axios";
import { createHmac } from "crypto";

const LOGIN_URL = "https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword";

/**
 * RFC 4648 BASE32 → bytes. Angel One shows the TOTP seed in BASE32; padding
 * and lower case are tolerated, any other character is a configuration error
 * worth failing loudly on (a silently mis-decoded seed produces valid-looking
 * but always-wrong codes, which is far harder to diagnose than a throw).
 */
export function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  if (!clean) throw new Error("TOTP secret is empty");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) throw new Error(`TOTP secret is not valid BASE32 (bad character "${ch}")`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * RFC 6238 TOTP (HMAC-SHA1, 30s step, 6 digits) — the parameters every
 * authenticator app and Angel One use. Implemented on Node's crypto rather
 * than pulled from a package: it is ~15 lines, and the obvious library
 * (otplib v13) is ESM-only and breaks both ts-jest and tsc here.
 */
export function generateTotp(secret: string, atMs: number = Date.now(), stepSeconds = 30, digits = 6): string {
  const counter = Math.floor(atMs / 1000 / stepSeconds);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(counterBuf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return (binary % 10 ** digits).toString().padStart(digits, "0");
}

export interface AngelOneCredentials {
  apiKey: string;
  clientCode: string;
  pin: string;
  totpSecret: string;
}

export interface AngelOneSession {
  jwtToken: string;
  refreshToken: string | null;
  feedToken: string;
  apiKey: string;
  clientCode: string;
  issuedAt: number;
}

/** Read credentials from the environment. Returns null when not fully configured. */
export function readAngelOneCredentials(env: NodeJS.ProcessEnv = process.env): AngelOneCredentials | null {
  const apiKey = env.ANGELONE_API_KEY?.trim();
  const clientCode = env.ANGELONE_CLIENT_CODE?.trim();
  const pin = env.ANGELONE_PIN?.trim();
  const totpSecret = env.ANGELONE_TOTP_SECRET?.trim();
  if (!apiKey || !clientCode || !pin || !totpSecret) return null;
  return { apiKey, clientCode, pin, totpSecret };
}

/** Operator-facing wiring check that never reveals a secret. */
export function describeConfig(env: NodeJS.ProcessEnv = process.env): { configured: boolean; missing: string[] } {
  const keys = ["ANGELONE_API_KEY", "ANGELONE_CLIENT_CODE", "ANGELONE_PIN", "ANGELONE_TOTP_SECRET"] as const;
  const missing = keys.filter((k) => !env[k]?.trim());
  return { configured: missing.length === 0, missing };
}

/** Current 6-digit TOTP for the stored BASE32 seed. Exposed for testability. */
export function currentTotp(secret: string, atMs: number = Date.now()): string {
  return generateTotp(secret, atMs);
}

export type LoginTransport = (url: string, body: unknown, headers: Record<string, string>) => Promise<unknown>;

const axiosTransport: LoginTransport = async (url, body, headers) => {
  const res = await axios.post(url, body, { headers, timeout: 15_000 });
  return res.data;
};

/**
 * SmartAPI requires these client-identity headers on login. The IP/MAC values
 * are informational to the broker; we send stable placeholders rather than
 * fingerprinting the host. X-PrivateKey MUST be the API key.
 */
function loginHeaders(creds: AngelOneCredentials): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-UserType": "USER",
    "X-SourceID": "WEB",
    "X-ClientLocalIP": "127.0.0.1",
    "X-ClientPublicIP": "127.0.0.1",
    "X-MACAddress": "00:00:00:00:00:00",
    "X-PrivateKey": creds.apiKey,
  };
}

/**
 * Log in and return a session. Throws with the broker's own message on
 * failure — a failed login must be loud, never a degraded-but-silent state.
 */
export async function loginAngelOne(
  creds: AngelOneCredentials,
  transport: LoginTransport = axiosTransport,
  now: () => number = Date.now
): Promise<AngelOneSession> {
  const totp = currentTotp(creds.totpSecret);
  const body = { clientcode: creds.clientCode, password: creds.pin, totp };
  const data = (await transport(LOGIN_URL, body, loginHeaders(creds))) as {
    status?: boolean;
    message?: string;
    errorcode?: string;
    data?: { jwtToken?: string; refreshToken?: string; feedToken?: string };
  };

  if (!data || data.status === false) {
    const msg = data?.message || data?.errorcode || "unknown error";
    throw new Error(`Angel One login failed: ${msg}`);
  }
  const jwtToken = data.data?.jwtToken?.trim();
  const feedToken = data.data?.feedToken?.trim();
  if (!jwtToken || !feedToken) {
    throw new Error("Angel One login returned no jwtToken/feedToken — cannot open a live feed");
  }
  return {
    jwtToken,
    refreshToken: data.data?.refreshToken?.trim() || null,
    feedToken,
    apiKey: creds.apiKey,
    clientCode: creds.clientCode,
    issuedAt: now(),
  };
}
