/**
 * V7 Module A1 — shared pure helpers for the direction-model pool.
 * No DB, no HTTP, no imports outside the quant module.
 */

import { Bar, Horizon } from "../types";

export const PROB_MIN = 0.05;
export const PROB_MAX = 0.95;

export const MODEL_HORIZONS: Horizon[] = [1, 3, 7, 15, 30];

export function clampProb(p: number): number {
  if (!Number.isFinite(p)) return 0.5;
  return Math.min(PROB_MAX, Math.max(PROB_MIN, p));
}

export function logistic(x: number): number {
  if (!Number.isFinite(x)) return 0.5;
  return 1 / (1 + Math.exp(-x));
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Trailing simple return over the last k trading bars, as a FRACTION. Null when unavailable. */
export function trailingReturn(closes: number[], k: number): number | null {
  if (k <= 0 || closes.length < k + 1) return null;
  const past = closes[closes.length - 1 - k];
  if (past <= 0) return null;
  return closes[closes.length - 1] / past - 1;
}

/** SMA of the LAST `period` values. Null when unavailable. */
export function smaLast(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

/**
 * Std dev (sample) of the last `window` daily returns (fractions).
 * Returns null with fewer than 5 usable returns; floors at 1e-6 so a flat
 * series never divides by zero.
 */
export function trailingDailyVol(closes: number[], window: number): number | null {
  const rets: number[] = [];
  const start = Math.max(1, closes.length - window);
  for (let i = start; i < closes.length; i++) {
    if (closes[i - 1] > 0) rets.push(closes[i] / closes[i - 1] - 1);
  }
  if (rets.length < 5) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance =
    rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (rets.length - 1);
  const sd = Math.sqrt(variance);
  return Number.isFinite(sd) ? Math.max(sd, 1e-6) : null;
}

export function round4(x: number): number {
  const r = Math.round(x * 10_000) / 10_000;
  return Object.is(r, -0) ? 0 : r;
}

/** Map every horizon through fn — keeps Record<Horizon, number> literal-safe. */
export function perHorizon(fn: (h: Horizon) => number): Record<Horizon, number> {
  return {
    1: round4(clampProb(fn(1))),
    3: round4(clampProb(fn(3))),
    7: round4(clampProb(fn(7))),
    15: round4(clampProb(fn(15))),
    30: round4(clampProb(fn(30))),
  };
}

export function closesOf(bars: Bar[]): number[] {
  return bars.map((b) => b.close);
}
