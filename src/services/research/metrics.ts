/**
 * Research metric helpers (completion directive, Phases 5+6) — PURE.
 * Autocorrelation-robust uncertainty (Newey–West) and CRPS from quantiles;
 * everything else reuses experiments/baselines.ts.
 */

export const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/**
 * Newey–West (HAC) standard error of the MEAN of a serially-correlated
 * series, Bartlett kernel with `lag` autocovariances (lag = horizon−1 for
 * daily-stepped h-day labels). This is what makes 39 overlapping 30d errors
 * behave like the handful of independent observations they really are.
 */
export function neweyWestSE(xs: number[], lag: number): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const e = xs.map((x) => x - mean);
  let variance = e.reduce((a, v) => a + v * v, 0) / n; // γ0
  const L = Math.min(Math.max(0, lag), n - 2);
  for (let l = 1; l <= L; l++) {
    let gamma = 0;
    for (let t = l; t < n; t++) gamma += e[t] * e[t - l];
    gamma /= n;
    variance += 2 * (1 - l / (L + 1)) * gamma; // Bartlett weight
  }
  variance = Math.max(variance, 0);
  return Math.sqrt(variance / n);
}

/**
 * CRPS approximated from a model's {p10,p50,p90} quantiles via the standard
 * pinball-loss identity: CRPS ≈ (2/K)·Σ pinball_τ(q_τ, y) over the available
 * quantile levels. An approximation — labeled as such wherever reported.
 */
export function crpsFromQuantiles(
  q: { p10: number; p50: number; p90: number },
  actual: number
): number {
  const levels: Array<[number, number]> = [
    [0.1, q.p10],
    [0.5, q.p50],
    [0.9, q.p90],
  ];
  let s = 0;
  for (const [tau, pred] of levels) {
    const diff = actual - pred;
    s += diff >= 0 ? tau * diff : (tau - 1) * diff;
  }
  return (2 / levels.length) * s;
}

/** Expected calibration error over equal-width probability bins. */
export function expectedCalibrationError(
  probs: number[],
  outcomes: Array<0 | 1>,
  bins = 10
): number | null {
  const n = probs.length;
  if (n === 0) return null;
  const sums = Array(bins).fill(0);
  const hits = Array(bins).fill(0);
  const counts = Array(bins).fill(0);
  for (let i = 0; i < n; i++) {
    const b = Math.min(bins - 1, Math.floor(probs[i] * bins));
    sums[b] += probs[i];
    hits[b] += outcomes[i];
    counts[b]++;
  }
  let ece = 0;
  for (let b = 0; b < bins; b++) {
    if (counts[b] === 0) continue;
    ece += (counts[b] / n) * Math.abs(hits[b] / counts[b] - sums[b] / counts[b]);
  }
  return round4(ece);
}
