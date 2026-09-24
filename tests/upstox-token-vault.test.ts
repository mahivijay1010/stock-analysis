/**
 * Token vault + feed supervisor: the properties that make unattended operation
 * safe rather than merely convenient.
 *
 * The vault exists so a restart does not cost a browser login. The danger it
 * introduces is the opposite failure: handing back a token that has expired,
 * which would let the feed open on a dead credential and — far worse in this
 * codebase — serve prices that look live. The expiry tests below are the ones
 * that matter.
 *
 * The supervisor exists so nobody has to press "start". The danger there is
 * starting when it should not: outside market hours (burning the day's token
 * on an empty socket), or hammering the broker after a failure.
 */

import { mkdtempSync, rmSync, existsSync, writeFileSync, statSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { UpstoxTokenVault } from "../src/services/realtime/upstoxTokenVault";
import { UpstoxToken, UpstoxTokenStore, nextTokenExpiry } from "../src/services/realtime/upstoxAuth";
import {
  SESSION_END_IST_MINUTES,
  SESSION_START_IST_MINUTES,
  inSessionWindow,
  pastSessionStop,
  shouldStart,
} from "../src/services/realtime/liveFeedSupervisor";

const SECRET = "test-api-secret-value";
let dir: string;
let vaultPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "vault-"));
  vaultPath = path.join(dir, "token.enc");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A token valid until the next 03:30 IST after `issuedAt`. */
function token(issuedAt: number, over: Partial<UpstoxToken> = {}): UpstoxToken {
  return { accessToken: "ACCESS-TOKEN-SECRET", issuedAt, expiresAt: nextTokenExpiry(issuedAt), userId: "U1", ...over };
}

/** 2026-09-24 10:00 IST. */
const TEN_AM_IST = Date.UTC(2026, 8, 24, 4, 30);

describe("UpstoxTokenVault — a restart must not cost a login", () => {
  test("round-trips a valid token", () => {
    const v = new UpstoxTokenVault(vaultPath, () => SECRET, () => TEN_AM_IST);
    const t = token(TEN_AM_IST);
    expect(v.save(t).ok).toBe(true);
    const { token: loaded } = v.load();
    expect(loaded).toEqual(t);
  });

  test("REFUSES to return an expired token, and clears the file", () => {
    const v = new UpstoxTokenVault(vaultPath, () => SECRET, () => TEN_AM_IST);
    v.save(token(TEN_AM_IST));
    // Next day, 10:00 IST — past the 03:30 boundary the token was bound to.
    const nextDay = new UpstoxTokenVault(vaultPath, () => SECRET, () => TEN_AM_IST + 24 * 3600_000);
    const { token: loaded, reason } = nextDay.load();
    expect(loaded).toBeNull();
    expect(reason).toMatch(/expired/);
    // A dead token must not linger to be re-examined every boot.
    expect(existsSync(vaultPath)).toBe(false);
  });

  test("the plaintext token never appears on disk", () => {
    const v = new UpstoxTokenVault(vaultPath, () => SECRET, () => TEN_AM_IST);
    v.save(token(TEN_AM_IST));
    expect(require("fs").readFileSync(vaultPath, "utf8")).not.toContain("ACCESS-TOKEN-SECRET");
  });

  test("the file is owner-only (0600)", () => {
    const v = new UpstoxTokenVault(vaultPath, () => SECRET, () => TEN_AM_IST);
    v.save(token(TEN_AM_IST));
    expect(statSync(vaultPath).mode & 0o777).toBe(0o600);
  });

  test("a different API secret cannot decrypt it — no partial or silent success", () => {
    new UpstoxTokenVault(vaultPath, () => SECRET, () => TEN_AM_IST).save(token(TEN_AM_IST));
    const { token: loaded, reason } = new UpstoxTokenVault(vaultPath, () => "different-secret", () => TEN_AM_IST).load();
    expect(loaded).toBeNull();
    expect(reason).toMatch(/could not decrypt/);
  });

  test("a corrupt or truncated file degrades to 'no token', never a throw", () => {
    writeFileSync(vaultPath, "{not json");
    const { token: loaded, reason } = new UpstoxTokenVault(vaultPath, () => SECRET, () => TEN_AM_IST).load();
    expect(loaded).toBeNull();
    expect(reason).toMatch(/unreadable/);
  });

  test("refuses to write anything when no secret is configured", () => {
    const v = new UpstoxTokenVault(vaultPath, () => undefined, () => TEN_AM_IST);
    expect(v.save(token(TEN_AM_IST)).ok).toBe(false);
    expect(existsSync(vaultPath)).toBe(false);
  });

  test("missing vault is a normal state, not an error", () => {
    const { token: loaded, reason } = new UpstoxTokenVault(vaultPath, () => SECRET, () => TEN_AM_IST).load();
    expect(loaded).toBeNull();
    expect(reason).toMatch(/no saved token/);
  });
});

describe("UpstoxTokenStore + vault — provenance is never hidden", () => {
  function fakeVault() {
    let saved: UpstoxToken | null = null;
    return {
      saved: () => saved,
      save: (t: UpstoxToken) => {
        saved = t;
        return { ok: true };
      },
      load: () => ({ token: saved, reason: saved ? undefined : "no saved token" }),
      clear: () => {
        saved = null;
        return { ok: true };
      },
    };
  }

  test("a login caches the token; a fresh store restores it and reports the source", () => {
    const vault = fakeVault();
    const a = new UpstoxTokenStore(() => TEN_AM_IST, vault);
    a.set(token(TEN_AM_IST));
    expect(a.tokenSource()).toBe("login");

    const b = new UpstoxTokenStore(() => TEN_AM_IST, vault);
    expect(b.restoreFromVault().restored).toBe(true);
    expect(b.isValid()).toBe(true);
    expect(b.tokenSource()).toBe("vault");
    // The operator must be able to tell a restored token from a fresh login.
    expect(b.status().reason).toMatch(/restored/);
  });

  test("clear() wipes the cache too — a logout must not be undone by the next restart", () => {
    const vault = fakeVault();
    const store = new UpstoxTokenStore(() => TEN_AM_IST, vault);
    store.set(token(TEN_AM_IST));
    store.clear();
    expect(vault.saved()).toBeNull();
    expect(new UpstoxTokenStore(() => TEN_AM_IST, vault).restoreFromVault().restored).toBe(false);
  });

  test("a failed cache write never breaks the login", () => {
    const failing = {
      save: () => ({ ok: false, reason: "disk full" }),
      load: () => ({ token: null, reason: "none" }),
      clear: () => ({ ok: true }),
    };
    const store = new UpstoxTokenStore(() => TEN_AM_IST, failing);
    store.set(token(TEN_AM_IST));
    expect(store.isValid()).toBe(true); // the session works; only the convenience was lost
  });

  test("an expired cached token is not restored", () => {
    const vault = fakeVault();
    new UpstoxTokenStore(() => TEN_AM_IST, vault).set(token(TEN_AM_IST));
    const nextDay = new UpstoxTokenStore(() => TEN_AM_IST + 24 * 3600_000, vault);
    nextDay.restoreFromVault();
    // get() refuses a stale token even if a vault handed one back.
    expect(nextDay.isValid()).toBe(false);
    expect(nextDay.tokenSource()).toBeNull();
  });
});

describe("LiveFeedSupervisor.shouldStart — unattended, but never reckless", () => {
  /** IST wall-clock on Wednesday 2026-09-23 → ms epoch. */
  const istWed = (hh: number, mm: number) => Date.UTC(2026, 8, 23, hh, mm) - 5.5 * 3600_000;
  const istSat = (hh: number, mm: number) => Date.UTC(2026, 8, 26, hh, mm) - 5.5 * 3600_000;

  const base = { feedRunning: false, tokenValid: true, tokenReason: "token valid", backoffUntilMs: null };

  test("starts inside the weekday window when a token exists and the feed is down", () => {
    expect(shouldStart({ ...base, nowMs: istWed(10, 0) }).action).toBe("start");
  });

  test("never starts before the window opens or after the close", () => {
    expect(shouldStart({ ...base, nowMs: istWed(8, 0) }).action).toBe("wait");
    expect(shouldStart({ ...base, nowMs: istWed(16, 0) }).action).toBe("wait");
    expect(shouldStart({ ...base, nowMs: istWed(23, 0) }).action).toBe("wait");
  });

  test("never starts at the weekend", () => {
    expect(shouldStart({ ...base, nowMs: istSat(10, 0) }).action).toBe("wait");
    expect(inSessionWindow(istSat(10, 0))).toBe(false);
  });

  test("never starts without a token — it cannot mint one, and says why", () => {
    const v = shouldStart({ ...base, nowMs: istWed(10, 0), tokenValid: false, tokenReason: "no Upstox token" });
    expect(v.action).toBe("wait");
    expect(v.reason).toMatch(/no Upstox token/);
  });

  test("does nothing when the feed is already running — idempotent", () => {
    expect(shouldStart({ ...base, nowMs: istWed(10, 0), feedRunning: true }).action).toBe("wait");
  });

  test("respects backoff after a failed start rather than hammering the broker", () => {
    const now = istWed(10, 0);
    expect(shouldStart({ ...base, nowMs: now, backoffUntilMs: now + 60_000 }).action).toBe("wait");
    expect(shouldStart({ ...base, nowMs: now, backoffUntilMs: now - 1 }).action).toBe("start");
  });

  test("the window opens a few minutes before the 09:15 bell so subscriptions settle first", () => {
    expect(SESSION_START_IST_MINUTES).toBeLessThan(9 * 60 + 15);
    expect(SESSION_END_IST_MINUTES).toBe(15 * 60 + 30);
    expect(inSessionWindow(istWed(9, 8))).toBe(true);
    expect(inSessionWindow(istWed(9, 7))).toBe(false);
    expect(inSessionWindow(istWed(15, 29))).toBe(true);
    expect(inSessionWindow(istWed(15, 30))).toBe(false);
  });
});

describe("LiveFeedSupervisor — stops at the close (2026-09-24 post-close thrash)", () => {
  const istWed = (hh: number, mm: number) => Date.UTC(2026, 8, 23, hh, mm) - 5.5 * 3600_000;
  const running = { feedRunning: true, tokenValid: true, tokenReason: "token valid", backoffUntilMs: null };

  test("a running feed is STOPPED once the close plus grace has passed", () => {
    expect(shouldStart({ ...running, nowMs: istWed(15, 36) }).action).toBe("stop");
    expect(shouldStart({ ...running, nowMs: istWed(16, 30) }).action).toBe("stop");
  });

  test("but not during the grace window — the last bars and grades must land first", () => {
    expect(shouldStart({ ...running, nowMs: istWed(15, 31) }).action).toBe("wait");
    expect(shouldStart({ ...running, nowMs: istWed(15, 35) }).action).toBe("wait");
  });

  test("a running feed inside the session is left alone", () => {
    expect(shouldStart({ ...running, nowMs: istWed(11, 0) }).action).toBe("wait");
  });

  test("a feed still running at the weekend is stopped", () => {
    const istSat = Date.UTC(2026, 8, 26, 10, 0) - 5.5 * 3600_000;
    expect(shouldStart({ ...running, nowMs: istSat }).action).toBe("stop");
    expect(pastSessionStop(istSat)).toBe(true);
  });
});
