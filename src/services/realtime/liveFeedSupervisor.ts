/**
 * LiveFeedSupervisor — keeps the live feed running without a human in the loop.
 *
 * The daily browser login cannot be automated (Upstox issues no refresh
 * tokens; see upstoxAuth.ts). Everything AROUND it can be, and that is what
 * kept costing sessions:
 *
 *  - 2026-09-21/22/23: the backend restarted (hot-reload, deploy) and the feed
 *    stayed down until someone noticed and pressed start.
 *  - 2026-09-23: the feed was down from 11:46 to the close because the deploy
 *    that ADDED outcome persistence also dropped the token — so the first day
 *    of persistence recorded nothing.
 *  - Most mornings the token was valid well before anyone started the feed.
 *
 * So: a supervisor that, on a fixed tick, starts the feed whenever it is
 * legitimately startable and is not already running. It is deliberately dumb
 * and idempotent — it holds no state machine beyond a backoff, and every
 * decision is recomputed from live facts.
 *
 * WHAT IT WILL NOT DO, by design:
 *
 *  - It never mints, refreshes or fabricates a token. No token ⇒ it waits and
 *    says so. The operator's one daily action stays the operator's.
 *  - It never starts outside market hours. A feed opened at 22:00 would burn
 *    the day's token on an empty socket and log an hour of STALE rows that
 *    look like a fault.
 *  - It backs off after consecutive failures rather than hammering the broker,
 *    and it surfaces the last failure verbatim instead of retrying silently.
 *
 * It does NOT supervise socket health during a session — UpstoxStreamProvider's
 * watchdog owns that (a hung socket reconnects itself in ~90s). This only
 * answers "should the feed be running at all, and is it?".
 */

import { LiveFeedService } from "./LiveFeedService";
import { UpstoxTokenStore, upstoxTokenStore } from "./upstoxAuth";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Session window, IST. Starts a few minutes BEFORE 09:15 so subscriptions are
 * established and the pre-open snapshot is absorbed before the first real
 * tick, and runs to the close.
 */
export const SESSION_START_IST_MINUTES = 9 * 60 + 8; // 09:08
export const SESSION_END_IST_MINUTES = 15 * 60 + 30; // 15:30

export const DEFAULT_TICK_MS = 60_000;
export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_MAX_MS = 15 * 60_000;

/** IST minutes-since-midnight and weekday (0=Sun..6=Sat). PURE. */
export function istClock(nowMs: number): { minutes: number; weekday: number } {
  const d = new Date(nowMs + IST_OFFSET_MS);
  return { minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), weekday: d.getUTCDay() };
}

/** Inside the trading window on a weekday? PURE. Holidays are not modelled — see shouldStart(). */
export function inSessionWindow(nowMs: number): boolean {
  const { minutes, weekday } = istClock(nowMs);
  if (weekday === 0 || weekday === 6) return false;
  return minutes >= SESSION_START_IST_MINUTES && minutes < SESSION_END_IST_MINUTES;
}

export type SupervisorVerdict =
  | { action: "start"; reason: string }
  | { action: "wait"; reason: string };

/**
 * The whole decision, as a pure function of observable facts. PURE so the
 * policy is unit-testable without a broker, a clock or a database.
 *
 * On an NSE holiday this returns "start" and the feed opens to a silent
 * socket: harmless (it reports STALE, fabricates nothing) and preferable to
 * bundling an exchange-holiday calendar that would itself go stale and could
 * suppress a real session.
 */
export function shouldStart(facts: {
  nowMs: number;
  feedRunning: boolean;
  tokenValid: boolean;
  tokenReason: string;
  backoffUntilMs: number | null;
}): SupervisorVerdict {
  if (facts.feedRunning) return { action: "wait", reason: "feed already running" };
  if (!inSessionWindow(facts.nowMs)) return { action: "wait", reason: "outside the IST trading window (09:08–15:30, Mon–Fri)" };
  if (!facts.tokenValid) return { action: "wait", reason: `no usable Upstox token: ${facts.tokenReason}` };
  if (facts.backoffUntilMs != null && facts.nowMs < facts.backoffUntilMs) {
    const secs = Math.ceil((facts.backoffUntilMs - facts.nowMs) / 1000);
    return { action: "wait", reason: `backing off after a failed start (${secs}s remaining)` };
  }
  return { action: "start", reason: "in session, token valid, feed down" };
}

export interface SupervisorStatus {
  enabled: boolean;
  lastCheckAt: string | null;
  lastVerdict: string | null;
  startsAttempted: number;
  startsSucceeded: number;
  consecutiveFailures: number;
  lastError: string | null;
  backoffUntil: string | null;
}

export class LiveFeedSupervisor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private starting = false;
  private startsAttempted = 0;
  private startsSucceeded = 0;
  private consecutiveFailures = 0;
  private lastError: string | null = null;
  private lastVerdict: string | null = null;
  private lastCheckAt: number | null = null;
  private backoffUntil: number | null = null;

  constructor(
    private readonly feed: LiveFeedService,
    private readonly tokens: UpstoxTokenStore = upstoxTokenStore,
    private readonly now: () => number = Date.now,
    private readonly tickMs: number = DEFAULT_TICK_MS
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
    // One immediate pass so a restart during market hours recovers in seconds
    // rather than at the next minute boundary.
    void this.tick();
    console.log(
      `🛰️  Live feed supervisor armed — auto-starts the feed on weekdays 09:08–15:30 IST whenever a valid token exists ` +
        `(the daily Upstox login still has to be done by hand: no refresh tokens exist)`
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): SupervisorStatus {
    return {
      enabled: this.timer != null,
      lastCheckAt: this.lastCheckAt ? new Date(this.lastCheckAt).toISOString() : null,
      lastVerdict: this.lastVerdict,
      startsAttempted: this.startsAttempted,
      startsSucceeded: this.startsSucceeded,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      backoffUntil: this.backoffUntil ? new Date(this.backoffUntil).toISOString() : null,
    };
  }

  /** One supervision pass. Never throws into the interval. */
  async tick(): Promise<void> {
    if (this.starting) return;
    const nowMs = this.now();
    this.lastCheckAt = nowMs;

    const tokenStatus = this.tokens.status();
    const verdict = shouldStart({
      nowMs,
      feedRunning: this.feed.isRunning(),
      tokenValid: tokenStatus.state === "VALID",
      tokenReason: tokenStatus.reason ?? tokenStatus.state,
      backoffUntilMs: this.backoffUntil,
    });
    this.lastVerdict = verdict.reason;
    if (verdict.action === "wait") return;

    this.starting = true;
    this.startsAttempted++;
    try {
      const status = await this.feed.start();
      this.startsSucceeded++;
      this.consecutiveFailures = 0;
      this.lastError = null;
      this.backoffUntil = null;
      console.log(`🛰️  [supervisor] live feed started automatically — ${status.subscribed}/${status.universeSize} instruments subscribed`);
    } catch (err) {
      this.consecutiveFailures++;
      this.lastError = err instanceof Error ? err.message : String(err);
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** (this.consecutiveFailures - 1), BACKOFF_MAX_MS);
      this.backoffUntil = this.now() + delay;
      console.error(
        `🛰️  [supervisor] auto-start failed (attempt ${this.consecutiveFailures}): ${this.lastError} — next try in ${Math.round(delay / 1000)}s`
      );
    } finally {
      this.starting = false;
    }
  }
}
