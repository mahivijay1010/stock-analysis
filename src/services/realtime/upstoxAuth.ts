/**
 * Upstox OAuth 2.0 + access-token lifecycle (real-time market data).
 *
 * THE CONSTRAINT THAT SHAPES THIS FILE: Upstox issues no refresh tokens, and
 * every access token dies at 03:30 IST regardless of when it was minted
 * (upstox.com/developer/api-documentation/authentication). Renewal therefore
 * REQUIRES a human browser login once per trading day — it cannot be automated
 * from stored credentials. Everything here is built around making that one
 * daily action short and unmistakable, and around failing loudly the moment
 * the token lapses rather than quietly serving a stale price.
 *
 * Flow: buildAuthorizationUrl() → user logs in at Upstox → Upstox redirects to
 * our local callback with ?code= → exchangeCodeForToken() → the token lands in
 * an in-memory TokenStore that knows its own expiry.
 *
 * Secrets (UPSTOX_API_KEY/UPSTOX_API_SECRET) come only from the environment.
 *
 * TOKEN PERSISTENCE (added 2026-09-24, superseding the original memory-only
 * design). The token was previously held in memory ONLY, on the reasoning that
 * a restart costs the same login the 03:30 expiry already forces. Three days of
 * live operation disproved that: restarts were not rare, they were the norm —
 * hot-reloads, deploys, crashes — and each one cost a login the expiry had NOT
 * yet forced. On 2026-09-23 a deploy at 11:46 took the feed down for the rest
 * of the session, and the first day of intraday-outcome persistence recorded
 * zero rows as a result.
 *
 * So the token is now cached, encrypted, via UpstoxTokenVault: AES-256-GCM
 * under a key derived from UPSTOX_API_SECRET (a secret that already exists and
 * already grants login), file mode 0600, gitignored, atomically written, and
 * DISCARDED on load if past its 03:30 expiry. The vault can only shorten the
 * gap between restarts and a working feed; it can never produce or extend a
 * token. The one daily browser login remains, because Upstox gives no way to
 * avoid it.
 */

import axios from "axios";
import { upstoxTokenVault } from "./upstoxTokenVault";

export const UPSTOX_AUTHORIZE_URL = "https://api.upstox.com/v2/login/authorization/dialog";
export const UPSTOX_TOKEN_URL = "https://api.upstox.com/v2/login/authorization/token";
/** Tokens expire at 03:30 IST daily, whenever they were issued. */
export const TOKEN_EXPIRY_IST_HOUR = 3;
export const TOKEN_EXPIRY_IST_MINUTE = 30;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export interface UpstoxCredentials {
  apiKey: string;
  apiSecret: string;
  redirectUri: string;
}

export interface UpstoxToken {
  accessToken: string;
  issuedAt: number;
  /** ms epoch of the next 03:30 IST boundary after issuedAt. */
  expiresAt: number;
  userId: string | null;
}

export function readUpstoxCredentials(env: NodeJS.ProcessEnv = process.env): UpstoxCredentials | null {
  const apiKey = env.UPSTOX_API_KEY?.trim();
  const apiSecret = env.UPSTOX_API_SECRET?.trim();
  const redirectUri = env.UPSTOX_REDIRECT_URI?.trim() || "http://localhost:5101/api/auth/upstox/callback";
  if (!apiKey || !apiSecret) return null;
  return { apiKey, apiSecret, redirectUri };
}

/** Operator wiring check that never prints a secret. */
export function describeConfig(env: NodeJS.ProcessEnv = process.env): { configured: boolean; missing: string[] } {
  const missing = (["UPSTOX_API_KEY", "UPSTOX_API_SECRET"] as const).filter((k) => !env[k]?.trim());
  return { configured: missing.length === 0, missing };
}

/**
 * Next 03:30 IST strictly after `from`. PURE — the whole expiry contract in
 * one testable function, because "valid until 3:30am" is easy to get wrong
 * across the IST offset and the day boundary.
 */
export function nextTokenExpiry(from: number): number {
  const ist = new Date(from + IST_OFFSET_MS);
  const boundary = Date.UTC(
    ist.getUTCFullYear(),
    ist.getUTCMonth(),
    ist.getUTCDate(),
    TOKEN_EXPIRY_IST_HOUR,
    TOKEN_EXPIRY_IST_MINUTE
  ) - IST_OFFSET_MS;
  return boundary > from ? boundary : boundary + 24 * 60 * 60 * 1000;
}

/** The URL the operator opens to log in. `state` guards against stray callbacks. */
export function buildAuthorizationUrl(creds: UpstoxCredentials, state: string): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: creds.apiKey,
    redirect_uri: creds.redirectUri,
    state,
  });
  return `${UPSTOX_AUTHORIZE_URL}?${q.toString()}`;
}

export type TokenTransport = (url: string, body: string, headers: Record<string, string>) => Promise<unknown>;

const axiosTransport: TokenTransport = async (url, body, headers) => {
  const res = await axios.post(url, body, { headers, timeout: 15_000 });
  return res.data;
};

/**
 * Exchange the single-use authorization code for an access token. Throws with
 * the broker's own message on failure — a failed exchange must be loud.
 */
export async function exchangeCodeForToken(
  creds: UpstoxCredentials,
  code: string,
  transport: TokenTransport = axiosTransport,
  now: () => number = Date.now
): Promise<UpstoxToken> {
  const body = new URLSearchParams({
    code,
    client_id: creds.apiKey,
    client_secret: creds.apiSecret,
    redirect_uri: creds.redirectUri,
    grant_type: "authorization_code",
  }).toString();

  const data = (await transport(UPSTOX_TOKEN_URL, body, {
    accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  })) as { access_token?: string; user_id?: string; errors?: Array<{ message?: string }>; message?: string };

  const accessToken = data?.access_token?.trim();
  if (!accessToken) {
    const msg = data?.errors?.[0]?.message || data?.message || "no access_token in response";
    throw new Error(`Upstox token exchange failed: ${msg}`);
  }
  const issuedAt = now();
  return { accessToken, issuedAt, expiresAt: nextTokenExpiry(issuedAt), userId: data.user_id?.trim() || null };
}

/**
 * Holds the current token and answers the only question the feed cares about:
 * may I connect right now, and if not, exactly why? In-memory by design.
 */
export class UpstoxTokenStore {
  private token: UpstoxToken | null = null;
  private pendingState: string | null = null;
  /** How the current token was obtained — surfaced so a restored token is never mistaken for a fresh login. */
  private source: "login" | "vault" | null = null;
  private vaultNote: string | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    /** Injected so tests can run without touching the filesystem. */
    private readonly vault: { save(t: UpstoxToken): { ok: boolean; reason?: string }; load(): { token: UpstoxToken | null; reason?: string }; clear(): { ok: boolean; reason?: string } } | null = null
  ) {}

  set(token: UpstoxToken): void {
    this.token = token;
    this.source = "login";
    if (this.vault) {
      const r = this.vault.save(token);
      this.vaultNote = r.ok ? "token cached for restarts" : `token NOT cached: ${r.reason ?? "unknown error"}`;
      // A failed cache is a degraded convenience, never a failed login.
      if (!r.ok) console.warn(`⚠️  Upstox token could not be cached (${r.reason}); a restart will require re-authorization`);
    }
  }

  clear(): void {
    this.token = null;
    this.source = null;
    this.vault?.clear();
  }

  /**
   * Restore a still-valid token from the vault at boot.
   *
   * Returns whether a token was recovered. Never throws, never returns an
   * expired token (the vault refuses those and clears itself), and marks the
   * source as "vault" so every surface can tell a restored token from a fresh
   * login.
   */
  restoreFromVault(): { restored: boolean; reason: string } {
    if (!this.vault) return { restored: false, reason: "no vault configured" };
    const { token, reason } = this.vault.load();
    if (!token) {
      this.vaultNote = reason ?? "no saved token";
      return { restored: false, reason: reason ?? "no saved token" };
    }
    this.token = token;
    this.source = "vault";
    this.vaultNote = "restored from encrypted cache";
    return { restored: true, reason: "restored a still-valid token from the encrypted cache" };
  }

  /** "login" | "vault" | null — how the live token got here. */
  tokenSource(): "login" | "vault" | null {
    return this.get() ? this.source : null;
  }

  /** The live token, or null when absent/expired. Never returns a stale token. */
  get(): UpstoxToken | null {
    if (!this.token) return null;
    return this.now() >= this.token.expiresAt ? null : this.token;
  }

  isValid(): boolean {
    return this.get() !== null;
  }

  /** Human-readable status for the operator and the feed's health reason. */
  status(): { state: "VALID" | "EXPIRED" | "ABSENT"; expiresAt: number | null; msRemaining: number | null; reason: string } {
    if (!this.token) {
      return { state: "ABSENT", expiresAt: null, msRemaining: null, reason: "no Upstox token — authorize at /api/auth/upstox/login" };
    }
    const remaining = this.token.expiresAt - this.now();
    if (remaining <= 0) {
      return {
        state: "EXPIRED",
        expiresAt: this.token.expiresAt,
        msRemaining: 0,
        reason: "Upstox token expired (they die at 03:30 IST daily; no refresh tokens) — re-authorize at /api/auth/upstox/login",
      };
    }
    return {
      state: "VALID",
      expiresAt: this.token.expiresAt,
      msRemaining: remaining,
      reason: this.source === "vault" ? "token valid (restored from encrypted cache)" : "token valid",
    };
  }

  /** CSRF guard for the OAuth round trip. */
  newState(random: () => string = () => Math.random().toString(36).slice(2)): string {
    this.pendingState = `st-${random()}`;
    return this.pendingState;
  }

  consumeState(state: string | null | undefined): boolean {
    if (!this.pendingState || !state || state !== this.pendingState) return false;
    this.pendingState = null;
    return true;
  }
}

export const upstoxTokenStore = new UpstoxTokenStore(Date.now, upstoxTokenVault);
