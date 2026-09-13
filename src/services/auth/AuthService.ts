/**
 * AuthService (Phase B2, spec §12; plan §8 Q1 option b) — minimal real
 * session auth for the single seeded owner account.
 *
 *  - POST /api/auth/login verifies bcrypt credentials and issues a signed
 *    JWT carried in an httpOnly SameSite=Strict cookie.
 *  - Identity is derived SERVER-SIDE from that cookie on every private route;
 *    account ids are never accepted from the client.
 *  - Registration is disabled (single-owner deployment, multi-user-ready
 *    schema). SESSION_SECRET must be set in the environment — there is no
 *    hardcoded fallback secret.
 *  - Brute-force guard: after 10 failed attempts for a username+IP within
 *    15 minutes, login answers 429 until the window passes.
 */
import { DataSource } from "typeorm";
import { createHash, timingSafeEqual } from "crypto";
import * as bcrypt from "bcrypt";
import * as jwt from "jsonwebtoken";
import { AppDataSource } from "../../config/database";
import { Account } from "../../entities/Account";
import { HttpError } from "../../types";

export interface SessionIdentity {
  accountId: string;
  username: string;
}

const TOKEN_TTL_SECONDS = 7 * 24 * 3600; // 7 days
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    throw new HttpError(500, "SESSION_SECRET is not configured (set a ≥16-char secret in .env).");
  }
  return s;
}

export class AuthService {
  private failures = new Map<string, { count: number; windowStart: number }>();

  constructor(private readonly ds: DataSource = AppDataSource) {}

  async login(username: string, password: string, ip: string): Promise<{ identity: SessionIdentity; token: string; expiresAt: string }> {
    if (typeof username !== "string" || typeof password !== "string" || !username.trim() || !password) {
      throw new HttpError(400, 'Body must include "username" and "password".');
    }
    const key = `${username.trim().toLowerCase()}|${ip}`;
    const f = this.failures.get(key);
    const now = Date.now();
    if (f && now - f.windowStart < FAILURE_WINDOW_MS && f.count >= MAX_FAILURES) {
      throw new HttpError(429, "Too many failed login attempts. Try again in a few minutes.");
    }

    const account = await this.ds.getRepository(Account).findOne({ where: { username: username.trim() } });
    // Constant-shape failure: same message whether the user or password is wrong.
    const ok = account ? await bcrypt.compare(password, account.passwordHash) : (await bcrypt.hash(password, 4), false);
    if (!account || !ok) {
      const cur = f && now - f.windowStart < FAILURE_WINDOW_MS ? f : { count: 0, windowStart: now };
      cur.count += 1;
      this.failures.set(key, cur);
      throw new HttpError(401, "Invalid username or password.");
    }
    this.failures.delete(key);

    const identity: SessionIdentity = { accountId: account.id, username: account.username };
    const token = jwt.sign({ sub: account.id, username: account.username }, secret(), {
      algorithm: "HS256",
      expiresIn: TOKEN_TTL_SECONDS,
    });
    return { identity, token, expiresAt: new Date(now + TOKEN_TTL_SECONDS * 1000).toISOString() };
  }

  /**
   * Admin passcode fast-path (owner-only convenience): a single secret passcode
   * logs in as the seeded owner account WITHOUT the username/password. The
   * passcode lives ONLY in ADMIN_PASSCODE (.env, gitignored) — never in source.
   * Same session cookie, same brute-force guard, constant-time compare. When
   * ADMIN_PASSCODE is unset the route is disabled (403), so a default build has
   * no passcode backdoor.
   */
  async loginWithPasscode(passcode: string, ip: string): Promise<{ identity: SessionIdentity; token: string; expiresAt: string }> {
    const configured = process.env.ADMIN_PASSCODE;
    if (!configured || configured.length < 6) {
      throw new HttpError(403, "Passcode login is not enabled (set ADMIN_PASSCODE, ≥6 chars, in .env).");
    }
    const key = `passcode|${ip}`;
    const f = this.failures.get(key);
    const now = Date.now();
    if (f && now - f.windowStart < FAILURE_WINDOW_MS && f.count >= MAX_FAILURES) {
      throw new HttpError(429, "Too many failed passcode attempts. Try again in a few minutes.");
    }

    const provided = typeof passcode === "string" ? passcode : "";
    if (!this.constantTimeEquals(provided, configured)) {
      const cur = f && now - f.windowStart < FAILURE_WINDOW_MS ? f : { count: 0, windowStart: now };
      cur.count += 1;
      this.failures.set(key, cur);
      throw new HttpError(401, "Invalid passcode.");
    }
    this.failures.delete(key);

    const ownerUser = process.env.OWNER_USER || "owner";
    const account = await this.ds.getRepository(Account).findOne({ where: { username: ownerUser } });
    if (!account) {
      throw new HttpError(500, `Owner account "${ownerUser}" not found — cannot complete passcode login.`);
    }
    const identity: SessionIdentity = { accountId: account.id, username: account.username };
    const token = jwt.sign({ sub: account.id, username: account.username }, secret(), { algorithm: "HS256", expiresIn: TOKEN_TTL_SECONDS });
    return { identity, token, expiresAt: new Date(now + TOKEN_TTL_SECONDS * 1000).toISOString() };
  }

  /** Length-independent constant-time comparison (avoids leaking length via timing). */
  private constantTimeEquals(a: string, b: string): boolean {
    const ab = Buffer.from(a, "utf8");
    const bb = Buffer.from(b, "utf8");
    // Compare fixed-size digests so unequal lengths don't early-return.
    const ah = createHash("sha256").update(ab).digest();
    const bh = createHash("sha256").update(bb).digest();
    return timingSafeEqual(ah, bh) && ab.length === bb.length;
  }

  verifyToken(token: string): SessionIdentity | null {
    try {
      const payload = jwt.verify(token, secret(), { algorithms: ["HS256"] }) as jwt.JwtPayload;
      if (!payload.sub || typeof payload.username !== "string") return null;
      return { accountId: String(payload.sub), username: payload.username };
    } catch (err) {
      if (err instanceof HttpError) throw err; // missing SESSION_SECRET is a config error, not a 401
      return null;
    }
  }
}

export const TOKEN_TTL = TOKEN_TTL_SECONDS;
export const authService = new AuthService();
