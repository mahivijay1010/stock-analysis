/**
 * Encrypted on-disk persistence for the Upstox access token.
 *
 * WHY THIS EXISTS, and what it does NOT solve.
 *
 * Upstox issues no refresh tokens and every access token dies at 03:30 IST, so
 * ONE interactive browser login per trading day is unavoidable — no stored
 * credential can mint a token. That constraint is not negotiable and this file
 * does not pretend otherwise.
 *
 * What it does remove is every OTHER reason the operator had to log in again.
 * Over 2026-09-21..23 the token was lost repeatedly not because it expired but
 * because the process restarted: a ts-node-dev hot-reload, a deploy, a crash.
 * The token was held in memory only, so each restart cost a fresh login and,
 * on 09-23, an entire afternoon of intraday outcomes that were never persisted
 * (docs/intraday-microstructure-notes.md §7). A token valid until 03:30 has no
 * business dying at 11:46 because a file changed.
 *
 * SECURITY POSTURE — stated plainly, because writing a bearer token to disk is
 * a real tradeoff and the original design explicitly rejected it:
 *
 *  - The token is encrypted with AES-256-GCM. The key is derived (scrypt) from
 *    UPSTOX_API_SECRET, which already lives in .env and already grants the
 *    ability to complete a login. The vault therefore adds NO new secret and
 *    widens no blast radius: an attacker who can read the vault file plus .env
 *    could already have obtained a token by other means.
 *  - The file is written 0600 (owner read/write only) into a gitignored
 *    directory, via write-to-temp + atomic rename so a crash cannot leave a
 *    half-written token.
 *  - It is bound to the expiry it was issued with. A token loaded after 03:30
 *    IST is DISCARDED, not used — the vault cannot resurrect a dead token, and
 *    a stale token must never quietly serve a stale price.
 *  - Contents are never logged. Failures log the reason, never the ciphertext
 *    or the plaintext.
 *
 * The honest summary: this converts "log in after every restart" into "log in
 * once per trading day", which is the floor the broker imposes.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import path from "path";
import { UpstoxToken } from "./upstoxAuth";

/** Where the vault lives. Gitignored; overridable for tests. */
export const DEFAULT_VAULT_PATH = path.join(process.cwd(), ".secrets", "upstox-token.enc");

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
/** Bumped if the on-disk shape ever changes, so an old file is refused rather than misread. */
const VAULT_FORMAT = 1;

interface VaultEnvelope {
  format: number;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

interface VaultPayload {
  accessToken: string;
  issuedAt: number;
  expiresAt: number;
  userId: string | null;
}

function deriveKey(secret: string, salt: Buffer): Buffer {
  return scryptSync(secret, salt, KEY_LENGTH);
}

export interface VaultResult {
  ok: boolean;
  /** Why the vault could not be used. Safe to log — never contains token material. */
  reason?: string;
}

/**
 * Persist and recover the daily token.
 *
 * Every method is failure-tolerant by design: the vault is a convenience, and
 * a broken vault must degrade to "you need to log in", never to a crash or —
 * far worse — to a stale token being used.
 */
export class UpstoxTokenVault {
  constructor(
    private readonly filePath: string = DEFAULT_VAULT_PATH,
    private readonly secretOf: () => string | undefined = () => process.env.UPSTOX_API_SECRET?.trim(),
    private readonly now: () => number = Date.now
  ) {}

  /** True when a vault file exists (says nothing about whether it is usable). */
  exists(): boolean {
    try {
      return existsSync(this.filePath);
    } catch {
      return false;
    }
  }

  /**
   * Encrypt and atomically write the token. Returns a result rather than
   * throwing: failing to cache a token must never break a successful login.
   */
  save(token: UpstoxToken): VaultResult {
    const secret = this.secretOf();
    if (!secret) return { ok: false, reason: "UPSTOX_API_SECRET not set — refusing to write an unencrypted token" };

    try {
      const salt = randomBytes(SALT_LENGTH);
      const iv = randomBytes(IV_LENGTH);
      const key = deriveKey(secret, salt);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const payload: VaultPayload = {
        accessToken: token.accessToken,
        issuedAt: token.issuedAt,
        expiresAt: token.expiresAt,
        userId: token.userId,
      };
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
      const envelope: VaultEnvelope = {
        format: VAULT_FORMAT,
        salt: salt.toString("base64"),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };

      const dir = path.dirname(this.filePath);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Write-then-rename so a crash mid-write cannot leave a truncated file
      // that would later decrypt to garbage.
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(envelope), { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, this.filePath);
      chmodSync(this.filePath, 0o600);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Load a still-valid token, or null.
   *
   * Returns null — never a token — when the file is missing, unreadable,
   * written by a different secret, in an unknown format, or EXPIRED. The
   * expiry check is the load-bearing one: a vault that hands back a dead
   * token would reintroduce exactly the stale-price failure the whole system
   * is built to prevent.
   */
  load(): { token: UpstoxToken | null; reason?: string } {
    if (!this.exists()) return { token: null, reason: "no saved token" };

    const secret = this.secretOf();
    if (!secret) return { token: null, reason: "UPSTOX_API_SECRET not set — cannot decrypt" };

    let envelope: VaultEnvelope;
    try {
      envelope = JSON.parse(readFileSync(this.filePath, "utf8")) as VaultEnvelope;
    } catch (err) {
      return { token: null, reason: `unreadable vault file: ${err instanceof Error ? err.message : String(err)}` };
    }

    if (envelope?.format !== VAULT_FORMAT) {
      return { token: null, reason: `unsupported vault format ${envelope?.format} (expected ${VAULT_FORMAT})` };
    }

    let payload: VaultPayload;
    try {
      const salt = Buffer.from(envelope.salt, "base64");
      const iv = Buffer.from(envelope.iv, "base64");
      const decipher = createDecipheriv(ALGORITHM, deriveKey(secret, salt), iv);
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]);
      payload = JSON.parse(plain.toString("utf8")) as VaultPayload;
    } catch {
      // Authentication failure means the secret changed or the file was
      // tampered with. Either way it is unusable; say so without detail.
      return { token: null, reason: "could not decrypt saved token (API secret changed, or file corrupt)" };
    }

    if (!payload?.accessToken || typeof payload.expiresAt !== "number") {
      return { token: null, reason: "saved token is malformed" };
    }

    if (this.now() >= payload.expiresAt) {
      // Dead tokens are cleared eagerly so a stale file cannot linger and be
      // re-examined every boot.
      this.clear();
      return { token: null, reason: "saved token had already expired (tokens die at 03:30 IST)" };
    }

    return {
      token: {
        accessToken: payload.accessToken,
        issuedAt: payload.issuedAt,
        expiresAt: payload.expiresAt,
        userId: payload.userId ?? null,
      },
    };
  }

  /** Remove the vault file. Used on expiry and on explicit logout. */
  clear(): VaultResult {
    try {
      if (existsSync(this.filePath)) unlinkSync(this.filePath);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }
}

export const upstoxTokenVault = new UpstoxTokenVault();
