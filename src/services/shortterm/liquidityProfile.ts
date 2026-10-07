/**
 * Liquidity truth (liquidity-profile-v1) — PURE.
 *
 * Part 1 reality: most sub-₹100 names trade thin, lock on 5%/10% circuits, and
 * have delivery well under 20%. You cannot size large and you cannot always
 * exit at your stop. This module turns raw nse_delivery rows into the honest
 * liquidity picture a sizing/gating decision actually needs — median daily
 * VALUE (not shares), delivery trend, an inferred circuit band, and a
 * days-to-exit estimate at a target rupee size.
 *
 * Everything here is a FACT derived from observed prints. The one inference —
 * the circuit band — is labelled as inferred, never asserted, because NSE's
 * per-symbol band is not in this dataset.
 */

export const LIQUIDITY_PROFILE_VERSION = "liquidity-profile-v1";

/** Fraction of a day's traded value you can realistically be without moving
 *  the price — a conservative small-order assumption for days-to-exit. */
export const MAX_PARTICIPATION = 0.1;

export interface LiquidityDailyRow {
  date: string; // YYYY-MM-DD ascending
  close: number;
  turnoverLacs: number | null; // ₹ lakhs
  trades: number | null;
  delivPct: number | null; // 0..100
}

export interface LiquidityProfile {
  version: string;
  sessions: number;
  /** Median daily traded VALUE over the window, in ₹. */
  medianDailyValueInr20d: number | null;
  medianDailyValueInr60d: number | null;
  medianTrades20d: number | null;
  delivPct5d: number | null;
  delivPct20d: number | null;
  delivPct60d: number | null;
  /** 5d − 20d delivery: positive = delivery rising (accumulation), descriptive only. */
  deliveryDivergencePp: number | null;
  /** Largest |daily move| over 60d — the basis for the band inference. */
  maxDailyMovePct60d: number | null;
  /** Inferred NSE circuit band from the 60d move envelope (5/10/20) or null
   *  (no tight band detected). INFERRED, not asserted. */
  inferredCircuitBandPct: 5 | 10 | 20 | null;
  /** Days in the last 20 with a |move| ≥ 9% — a volatility/lock-risk proxy. */
  bigMoveDays20d: number;
  /** Trading days to liquidate ₹1 crore at MAX_PARTICIPATION of median value. */
  daysToExitAt1crore: number | null;
}

const median = (xs: number[]): number | null => {
  const v = xs.filter((x) => Number.isFinite(x));
  if (v.length === 0) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs: number[]): number | null => {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const tail = <T>(arr: T[], n: number): T[] => arr.slice(Math.max(0, arr.length - n));
const r2 = (x: number): number => Math.round(x * 100) / 100;

/** PURE: derive the liquidity profile from ascending daily rows. */
export function computeLiquidityProfile(rows: LiquidityDailyRow[]): LiquidityProfile {
  const empty: LiquidityProfile = {
    version: LIQUIDITY_PROFILE_VERSION,
    sessions: rows.length,
    medianDailyValueInr20d: null,
    medianDailyValueInr60d: null,
    medianTrades20d: null,
    delivPct5d: null,
    delivPct20d: null,
    delivPct60d: null,
    deliveryDivergencePp: null,
    maxDailyMovePct60d: null,
    inferredCircuitBandPct: null,
    bigMoveDays20d: 0,
    daysToExitAt1crore: null,
  };
  if (rows.length === 0) return empty;

  const toInr = (lacs: number | null): number => (lacs == null ? NaN : lacs * 100_000);
  const val20 = median(tail(rows, 20).map((r) => toInr(r.turnoverLacs)));
  const val60 = median(tail(rows, 60).map((r) => toInr(r.turnoverLacs)));
  const trades20 = median(tail(rows, 20).map((r) => (r.trades == null ? NaN : r.trades)));
  const d5 = mean(tail(rows, 5).map((r) => (r.delivPct == null ? NaN : r.delivPct)));
  const d20 = mean(tail(rows, 20).map((r) => (r.delivPct == null ? NaN : r.delivPct)));
  const d60 = mean(tail(rows, 60).map((r) => (r.delivPct == null ? NaN : r.delivPct)));

  // Daily moves over the last 60 sessions (from consecutive closes).
  const last60 = tail(rows, 61);
  const moves: number[] = [];
  for (let i = 1; i < last60.length; i++) {
    const prev = last60[i - 1].close;
    if (prev > 0) moves.push((last60[i].close / prev - 1) * 100);
  }
  const maxMove = moves.length ? Math.max(...moves.map((m) => Math.abs(m))) : null;
  // Band inference from the move envelope + a small tolerance. A stock that
  // never moved beyond ~5% for 60 sessions is very likely on a 5% band.
  let band: 5 | 10 | 20 | null = null;
  if (maxMove != null) {
    if (maxMove <= 5.6) band = 5;
    else if (maxMove <= 10.6) band = 10;
    else if (maxMove <= 20.6) band = 20;
  }
  const last20moves = tail(moves, 20);
  const bigMoveDays = last20moves.filter((m) => Math.abs(m) >= 9).length;

  const daysToExit = val20 != null && val20 > 0 ? r2(10_000_000 / (MAX_PARTICIPATION * val20)) : null;

  return {
    version: LIQUIDITY_PROFILE_VERSION,
    sessions: rows.length,
    medianDailyValueInr20d: val20 != null ? Math.round(val20) : null,
    medianDailyValueInr60d: val60 != null ? Math.round(val60) : null,
    medianTrades20d: trades20 != null ? Math.round(trades20) : null,
    delivPct5d: d5 != null ? r2(d5) : null,
    delivPct20d: d20 != null ? r2(d20) : null,
    delivPct60d: d60 != null ? r2(d60) : null,
    deliveryDivergencePp: d5 != null && d20 != null ? r2(d5 - d20) : null,
    maxDailyMovePct60d: maxMove != null ? r2(maxMove) : null,
    inferredCircuitBandPct: band,
    bigMoveDays20d: bigMoveDays,
    daysToExitAt1crore: daysToExit,
  };
}
