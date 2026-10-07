/**
 * Split conformal prediction intervals (conformal-v1) — PURE.
 *
 * Model point forecasts are almost always over-confident. Split conformal turns
 * a set of PAST absolute residuals (|actual − predicted| on a held-out set the
 * model never trained on) into a finite-sample interval with a distribution-free
 * coverage guarantee: at level 1−α, the true value lands in the interval at
 * least (1−α) of the time, under exchangeability. No Gaussian assumption.
 *
 * The honesty rule: below MIN_CALIBRATION the interval is WITHHELD (null), the
 * same discipline as every other rate in this system — a band from 5 residuals
 * is theatre, not a guarantee.
 */

export const CONFORMAL_VERSION = "conformal-v1";
export const MIN_CALIBRATION = 20;

export interface ConformalResult {
  version: string;
  point: number;
  lower: number;
  upper: number;
  coverage: number;
  /** The (1−α)·(n+1)/n quantile of |residuals| — the half-width. */
  halfWidth: number;
  sampleSize: number;
}

/**
 * PURE. `residuals` are absolute errors on a calibration set. `coverage` is the
 * target (e.g. 0.8). Returns null below MIN_CALIBRATION — withheld, not faked.
 */
export function conformalInterval(point: number, residuals: number[], coverage = 0.8): ConformalResult | null {
  const abs = residuals.filter((r) => Number.isFinite(r)).map((r) => Math.abs(r));
  const n = abs.length;
  if (n < MIN_CALIBRATION || !Number.isFinite(point) || coverage <= 0 || coverage >= 1) return null;

  // Finite-sample conformal quantile: ceil((n+1)(1−α)) / n th order statistic.
  const sorted = [...abs].sort((a, b) => a - b);
  const rank = Math.ceil((n + 1) * coverage);
  // If the rank exceeds n the guarantee needs the max residual (interval is the widest observed).
  const idx = Math.min(n, rank) - 1;
  const halfWidth = sorted[idx];

  const round = (x: number): number => Math.round(x * 10000) / 10000;
  return {
    version: CONFORMAL_VERSION,
    point: round(point),
    lower: round(point - halfWidth),
    upper: round(point + halfWidth),
    coverage,
    halfWidth: round(halfWidth),
    sampleSize: n,
  };
}

/** Empirical coverage of a fitted interval width on a test residual set — the
 *  honest check that the interval actually delivers its promised coverage. */
export function empiricalCoverage(halfWidth: number, testResiduals: number[]): { covered: number; n: number; pct: number } | null {
  const abs = testResiduals.filter((r) => Number.isFinite(r)).map((r) => Math.abs(r));
  if (abs.length === 0) return null;
  const covered = abs.filter((r) => r <= halfWidth).length;
  return { covered, n: abs.length, pct: Math.round((covered / abs.length) * 1000) / 10 };
}
