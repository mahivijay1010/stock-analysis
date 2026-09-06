/**
 * Module N2 — Monte Carlo forecast (PURE: no DB, no HTTP, no other services).
 *
 * Bootstrap resampling with replacement from the stock's own last ≤250 REAL
 * daily returns — captures the fat tails / skew that a normal approximation
 * misses. 10,000 paths × 21 trading-day steps, seeded PRNG (mulberry32) so
 * every run over the same inputs is bit-for-bit reproducible.
 *
 * ONE simulation pass records the cumulative return at trading-day offsets
 * {1, 2, 5, 10, 21} → calendar horizons {1, 3, 7, 15, 30}.
 */

import { Horizon } from "./types";

export interface MonteCarloHorizon {
  horizonDays: Horizon;
  pop: number; // P(return > 0), 0..1
  pDown10: number; // P(return ≤ −10%), 0..1
  pDown20: number; // P(return ≤ −20%), 0..1
  pUp10: number; // P(return ≥ +10%), 0..1
  percentiles: { p5: number; p25: number; p50: number; p75: number; p95: number }; // % returns
}

export interface MonteCarloForecast {
  paths: number;
  method: string;
  horizons: MonteCarloHorizon[];
  note: string;
}

export interface MonteCarloOptions {
  paths?: number; // default 10,000
  seed?: number; // default fixed → reproducible
  maxReturns?: number; // resample pool size cap, default 250
}

/** Calendar horizon → trading-day offset (mirrors the quant engine mapping). */
const HORIZON_OFFSETS: Array<{ horizonDays: Horizon; offset: number }> = [
  { horizonDays: 1, offset: 1 },
  { horizonDays: 3, offset: 2 },
  { horizonDays: 7, offset: 5 },
  { horizonDays: 15, offset: 10 },
  { horizonDays: 30, offset: 21 },
];

const STEPS = 21; // longest offset — one pass covers every horizon
const DEFAULT_PATHS = 10_000;
const DEFAULT_SEED = 20240915; // fixed → same inputs always give same output
const DEFAULT_MAX_RETURNS = 250;
const MIN_RETURNS = 60;

/** mulberry32 — tiny deterministic PRNG, uniform in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round2(x: number): number {
  const r = Math.round(x * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

function round4(x: number): number {
  const r = Math.round(x * 10_000) / 10_000;
  return Object.is(r, -0) ? 0 : r;
}

/** Linear-interpolated percentile of an ASCENDING-sorted array (p in 0..100). */
function percentileSorted(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const idx = (p / 100) * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/**
 * Bootstrap Monte Carlo over real daily returns (fractions, e.g. 0.012 = +1.2%).
 * Throws if fewer than 60 usable returns — never fabricates a forecast.
 */
export function simulateBootstrap(
  dailyReturns: number[],
  opts?: MonteCarloOptions
): MonteCarloForecast {
  const usable = (Array.isArray(dailyReturns) ? dailyReturns : []).filter(
    (r) => Number.isFinite(r) && r > -1
  );
  if (usable.length < MIN_RETURNS) {
    throw new Error(
      `simulateBootstrap requires at least ${MIN_RETURNS} real daily returns, got ${usable.length}`
    );
  }
  const maxReturns = opts?.maxReturns ?? DEFAULT_MAX_RETURNS;
  const pool = usable.slice(-maxReturns);
  const nPool = pool.length;
  const paths = opts?.paths ?? DEFAULT_PATHS;
  const seed = opts?.seed ?? DEFAULT_SEED;
  const rand = mulberry32(seed);

  // One pass: per path, walk 21 steps and record the cumulative return at
  // each horizon's trading-day offset.
  const byHorizon: number[][] = HORIZON_OFFSETS.map(() => new Array(paths));
  const offsetToSlot = new Map<number, number>(
    HORIZON_OFFSETS.map((h, slot) => [h.offset, slot])
  );
  for (let p = 0; p < paths; p++) {
    let cum = 1;
    for (let step = 1; step <= STEPS; step++) {
      cum *= 1 + pool[Math.floor(rand() * nPool)];
      const slot = offsetToSlot.get(step);
      if (slot !== undefined) byHorizon[slot][p] = cum - 1;
    }
  }

  const horizons: MonteCarloHorizon[] = HORIZON_OFFSETS.map((h, slot) => {
    const outcomes = byHorizon[slot];
    let up = 0;
    let down10 = 0;
    let down20 = 0;
    let up10 = 0;
    for (const r of outcomes) {
      if (r > 0) up++;
      if (r <= -0.1) down10++;
      if (r <= -0.2) down20++;
      if (r >= 0.1) up10++;
    }
    const sorted = outcomes.slice().sort((a, b) => a - b);
    return {
      horizonDays: h.horizonDays,
      pop: round4(up / paths),
      pDown10: round4(down10 / paths),
      pDown20: round4(down20 / paths),
      pUp10: round4(up10 / paths),
      percentiles: {
        p5: round2(percentileSorted(sorted, 5) * 100),
        p25: round2(percentileSorted(sorted, 25) * 100),
        p50: round2(percentileSorted(sorted, 50) * 100),
        p75: round2(percentileSorted(sorted, 75) * 100),
        p95: round2(percentileSorted(sorted, 95) * 100),
      },
    };
  });

  return {
    paths,
    method: `bootstrap resampling with replacement (seeded mulberry32, ${nPool}-day return pool, ${STEPS} steps)`,
    horizons,
    note:
      `${paths.toLocaleString("en-IN")} bootstrap paths resampled from this stock's own last ${nPool} daily returns — ` +
      `captures fat tails the normal approximation misses. Probabilities are frequencies ` +
      `across simulated paths, not promises.`,
  };
}

// ── Phase C (spec §5): per-trading-day cumulative-return quantiles ───────────

export interface DailyQuantileStep {
  /** Trading-day offset from the anchor (1 = next session). */
  offset: number;
  /** Cumulative return quantiles as FRACTIONS (0.012 = +1.2%). */
  q: { p05: number; p10: number; p25: number; p50: number; p75: number; p90: number; p95: number };
  /** Genuine sample mean of cumulative returns across paths. */
  mean: number;
  /** P(cumulative return > 0), 0..1. */
  pop: number;
}

export interface DailyQuantileForecast {
  paths: number;
  seed: number;
  poolSize: number;
  steps: number;
  method: string;
  perStep: DailyQuantileStep[]; // length === steps, offset 1..steps
}

/**
 * Same seeded bootstrap as simulateBootstrap, but records the cumulative
 * distribution at EVERY trading-day offset 1..steps — powering the day-wise
 * forecast table (p10–p90 = 80% interval, p05–p95 = 90%; never relabeled).
 * PURE and deterministic: identical inputs ⇒ bit-identical output.
 * Throws below 60 usable returns — never fabricates a forecast.
 */
export function simulateDailyQuantiles(
  dailyReturns: number[],
  steps: number,
  opts?: MonteCarloOptions
): DailyQuantileForecast {
  const usable = (Array.isArray(dailyReturns) ? dailyReturns : []).filter(
    (r) => Number.isFinite(r) && r > -1
  );
  if (usable.length < MIN_RETURNS) {
    throw new Error(
      `simulateDailyQuantiles requires at least ${MIN_RETURNS} real daily returns, got ${usable.length}`
    );
  }
  if (!Number.isInteger(steps) || steps < 1 || steps > 40) {
    throw new Error(`simulateDailyQuantiles steps must be an integer in 1..40, got ${steps}`);
  }
  const maxReturns = opts?.maxReturns ?? DEFAULT_MAX_RETURNS;
  const pool = usable.slice(-maxReturns);
  const nPool = pool.length;
  const paths = opts?.paths ?? DEFAULT_PATHS;
  const seed = opts?.seed ?? DEFAULT_SEED;
  const rand = mulberry32(seed);

  // paths × steps cumulative returns (10k × ≤40 ⇒ ≤3.2 MB of doubles — fine).
  const byStep: Float64Array[] = Array.from({ length: steps }, () => new Float64Array(paths));
  for (let p = 0; p < paths; p++) {
    let cum = 1;
    for (let step = 1; step <= steps; step++) {
      cum *= 1 + pool[Math.floor(rand() * nPool)];
      byStep[step - 1][p] = cum - 1;
    }
  }

  const perStep: DailyQuantileStep[] = byStep.map((outcomes, i) => {
    const sorted = Array.from(outcomes).sort((a, b) => a - b);
    let up = 0;
    let sum = 0;
    for (const r of outcomes) {
      if (r > 0) up++;
      sum += r;
    }
    const q = (p: number) => round4(percentileSorted(sorted, p));
    return {
      offset: i + 1,
      q: { p05: q(5), p10: q(10), p25: q(25), p50: q(50), p75: q(75), p90: q(90), p95: q(95) },
      mean: round4(sum / paths),
      pop: round4(up / paths),
    };
  });

  return {
    paths,
    seed,
    poolSize: nPool,
    steps,
    method: `bootstrap resampling with replacement (seeded mulberry32, ${nPool}-day return pool, per-step quantiles)`,
    perStep,
  };
}
