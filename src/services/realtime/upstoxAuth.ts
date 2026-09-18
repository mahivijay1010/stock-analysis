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
 * The access token is deliberately held in memory only: it is valid for hours,
 * not days, and writing it to disk would create a credential file with no
 * lifecycle. A restart costs one browser login — the same login the 03:30
 * expiry already forces.
 */

import axios from "axios";

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

  constructor(private readonly now: () => number = Date.now) {}

  set(token: UpstoxToken): void {
    this.token = token;
  }

  clear(): void {
    this.token = null;
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
    return { state: "VALID", expiresAt: this.token.expiresAt, msRemaining: remaining, reason: "token valid" };
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

export const upstoxTokenStore = new UpstoxTokenStore();
