/**
 * Phase D (spec §7/§8) — reproducible baselines every model must beat.
 * PURE functions over real observed values; nothing here fabricates data.
 *
 *  - lastPriceForecast: tomorrow = today (the no-change baseline for prices)
 *  - constant-50 Brier = 0.25 by definition (stated, not "discovered")
 *  - trainBaseRate: P(up) measured on the training window only
 *  - alwaysUpHitRate / majorityHitRate: directional baselines
 *  - ewmaVol: RiskMetrics-style volatility baseline (λ = 0.94 default)
 */

export interface DirectionBaselines {
  constant50Brier: number; // always 0.25 — the definitional benchmark
  trainBaseRateP: number; // P(up) fitted on TRAIN ONLY
  baseRateBrier: number; // Brier of predicting trainBaseRateP for every eval day
  alwaysUpHitRatePct: number; // % of eval days that were up
  majorityHitRatePct: number; // majority class (train) applied to eval
}

/** Brier for a constant probability p against binary outcomes. */
export function constantBrier(p: number, outcomes: Array<0 | 1>): number {
  if (outcomes.length === 0) return NaN;
  let s = 0;
  for (const y of outcomes) s += (p - y) ** 2;
  return s / outcomes.length;
}

/**
 * Directional baselines. trainUps/evalUps are binary arrays (1 = up) built by
 * the caller from REAL returns with an explicit flat-price rule.
 */
export function directionBaselines(trainUps: Array<0 | 1>, evalUps: Array<0 | 1>): DirectionBaselines {
  if (trainUps.length === 0 || evalUps.length === 0) {
    throw new Error("directionBaselines requires non-empty train and eval outcome arrays");
  }
  const trainBaseRateP = trainUps.reduce<number>((a, b) => a + b, 0) / trainUps.length;
  const evalUpShare = evalUps.reduce<number>((a, b) => a + b, 0) / evalUps.length;
  const majorityClass: 0 | 1 = trainBaseRateP >= 0.5 ? 1 : 0;
  const majorityHits = evalUps.filter((y) => y === majorityClass).length / evalUps.length;
  return {
    constant50Brier: 0.25,
    trainBaseRateP: round4(trainBaseRateP),
    baseRateBrier: round4(constantBrier(trainBaseRateP, evalUps)),
    alwaysUpHitRatePct: round2(evalUpShare * 100),
    majorityHitRatePct: round2(majorityHits * 100),
  };
}

/**
 * Last-price (no-change) forecast errors: for each (todayClose, futureClose)
 * pair the baseline predicts zero change. Returns MAE% and RMSE% — the bar a
 * price model must beat (spec §8: compare price forecasts to last price).
 */
export function lastPriceErrors(pairs: Array<{ anchor: number; actual: number }>): {
  maePct: number;
  rmsePct: number;
  n: number;
} {
  if (pairs.length === 0) return { maePct: NaN, rmsePct: NaN, n: 0 };
  let sumAbs = 0;
  let sumSq = 0;
  for (const { anchor, actual } of pairs) {
    const errPct = ((actual - anchor) / anchor) * 100;
    sumAbs += Math.abs(errPct);
    sumSq += errPct * errPct;
  }
  return {
    maePct: round4(sumAbs / pairs.length),
    rmsePct: round4(Math.sqrt(sumSq / pairs.length)),
    n: pairs.length,
  };
}

/**
 * EWMA volatility (λ default 0.94). Returns the DAILY vol series (fraction),
 * seeded with the variance of the first `seedLen` returns — a real estimate,
 * not an invented prior. Series aligns with `returns` (index i uses info ≤ i).
 */
export function ewmaVol(returns: number[], lambda = 0.94, seedLen = 20): number[] {
  if (returns.length < seedLen + 1) {
    throw new Error(`ewmaVol needs more than ${seedLen} returns, got ${returns.length}`);
  }
  const seed = returns.slice(0, seedLen);
  const mean = seed.reduce((a, b) => a + b, 0) / seedLen;
  let variance = seed.reduce((a, b) => a + (b - mean) ** 2, 0) / seedLen;
  const out: number[] = new Array(returns.length);
  for (let i = 0; i < returns.length; i++) {
    if (i >= seedLen) variance = lambda * variance + (1 - lambda) * returns[i - 1] ** 2;
    out[i] = Math.sqrt(variance);
  }
  return out;
}

/** Pinball (quantile) loss for one quantile level tau over (predicted, actual) pairs. */
export function quantileLoss(tau: number, pairs: Array<{ pred: number; actual: number }>): number {
  if (pairs.length === 0) return NaN;
  let s = 0;
  for (const { pred, actual } of pairs) {
    const diff = actual - pred;
    s += diff >= 0 ? tau * diff : (tau - 1) * diff;
  }
  return s / pairs.length;
}

/** Interval score (Gneiting-Raftery) for a central (1−alpha) interval. */
export function intervalScore(
  alpha: number,
  pairs: Array<{ lo: number; hi: number; actual: number }>
): { score: number; coveragePct: number; avgWidth: number } {
  if (pairs.length === 0) return { score: NaN, coveragePct: NaN, avgWidth: NaN };
  let s = 0;
  let covered = 0;
  let width = 0;
  for (const { lo, hi, actual } of pairs) {
    width += hi - lo;
    s += hi - lo;
    if (actual < lo) s += (2 / alpha) * (lo - actual);
    else if (actual > hi) s += (2 / alpha) * (actual - hi);
    else covered++;
  }
  return {
    score: round4(s / pairs.length),
    coveragePct: round2((covered / pairs.length) * 100),
    avgWidth: round4(width / pairs.length),
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}
