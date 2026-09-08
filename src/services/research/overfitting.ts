/**
 * Backtest-overfitting controls (autonomous directive, Part T) — PURE.
 *
 *  - deflatedSharpeRatio: Bailey & López de Prado — the probability that the
 *    observed Sharpe exceeds the expected maximum Sharpe of `nTrials` random
 *    strategies, adjusting for skew/kurtosis and sample length. DSR < 0.95 ⇒
 *    the "winner" is indistinguishable from selection luck.
 *  - probabilityOfBacktestOverfitting (CSCV-lite): split the per-period
 *    performance matrix into S blocks; for every S/2 in-sample combination,
 *    pick the best strategy in-sample and record whether it falls in the
 *    bottom half out-of-sample. PBO = fraction of combinations where it does.
 *  - forecastDisagreement (Part Q): dispersion across model outputs — high
 *    disagreement must lower confidence, never be averaged away.
 */

export function normCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (z > 0) p = 1 - p;
  return p;
}

/** Expected maximum Sharpe of nTrials iid trials (Bailey–LdP approximation). */
export function expectedMaxSharpe(nTrials: number, varSharpe = 1): number {
  if (nTrials <= 1) return 0;
  const emc = 0.5772156649;
  const n = nTrials;
  const z1 = Math.sqrt(varSharpe) * ((1 - emc) * invNorm(1 - 1 / n) + emc * invNorm(1 - 1 / (n * Math.E)));
  return z1;
}

/** Inverse normal CDF (Acklam approximation, sufficient for DSR). */
export function invNorm(p: number): number {
  if (p <= 0 || p >= 1) return p <= 0 ? -8 : 8;
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const pl = 0.02425;
  let q: number;
  let r: number;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - pl) {
    q = p - 0.5;
    r = q * q;
    return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

export interface DsrResult {
  observedSharpe: number;
  expectedMaxSharpeUnderNull: number;
  deflatedSharpeProbability: number; // P(true SR > 0 given selection from nTrials)
  passes: boolean; // ≥ 0.95
}

/**
 * @param sharpe        observed (per-period) Sharpe of the SELECTED strategy
 * @param nPeriods      number of performance periods behind the Sharpe
 * @param nTrials       how many strategies/configurations were examined
 * @param skew,kurtosis of the per-period returns (kurtosis = 3 for normal)
 */
export function deflatedSharpeRatio(sharpe: number, nPeriods: number, nTrials: number, skew = 0, kurtosis = 3): DsrResult {
  const sr0 = expectedMaxSharpe(Math.max(2, nTrials));
  const denom = Math.sqrt(Math.max(1e-9, (1 - skew * sharpe + ((kurtosis - 1) / 4) * sharpe * sharpe) / Math.max(1, nPeriods - 1)));
  const z = ((sharpe - sr0) * 1) / denom;
  const p = normCdf(z);
  return {
    observedSharpe: Math.round(sharpe * 10000) / 10000,
    expectedMaxSharpeUnderNull: Math.round(sr0 * 10000) / 10000,
    deflatedSharpeProbability: Math.round(p * 10000) / 10000,
    passes: p >= 0.95,
  };
}

/**
 * CSCV-lite PBO: rows = strategies, cols = chronological performance periods.
 * Splits columns into S blocks and enumerates in/out combinations (S ≤ 12).
 */
export function probabilityOfBacktestOverfitting(perf: number[][], S = 8): { pbo: number; combinations: number } | null {
  const nStrat = perf.length;
  if (nStrat < 2) return null;
  const T = perf[0].length;
  if (perf.some((row) => row.length !== T) || T < S * 2) return null;
  const blockSize = Math.floor(T / S);
  const blocks: number[][] = Array.from({ length: S }, (_, b) => Array.from({ length: blockSize }, (_, i) => b * blockSize + i));
  // enumerate C(S, S/2) combinations
  const half = S / 2;
  const combos: number[][] = [];
  const rec = (start: number, acc: number[]) => {
    if (acc.length === half) {
      combos.push([...acc]);
      return;
    }
    for (let i = start; i < S; i++) rec(i + 1, [...acc, i]);
  };
  rec(0, []);
  let overfit = 0;
  for (const inBlocks of combos) {
    const inCols = inBlocks.flatMap((b) => blocks[b]);
    const outCols = blocks.flatMap((blk, b) => (inBlocks.includes(b) ? [] : blk));
    const mean = (row: number[], cols: number[]) => cols.reduce((a, c) => a + row[c], 0) / cols.length;
    let best = 0;
    let bestVal = -Infinity;
    for (let sIdx = 0; sIdx < nStrat; sIdx++) {
      const v = mean(perf[sIdx], inCols);
      if (v > bestVal) {
        bestVal = v;
        best = sIdx;
      }
    }
    const outVals = perf.map((row) => mean(row, outCols));
    const rankOfBest = outVals.filter((v) => v < outVals[best]).length / (nStrat - 1);
    if (rankOfBest < 0.5) overfit++;
  }
  return { pbo: Math.round((overfit / combos.length) * 10000) / 10000, combinations: combos.length };
}

// ── Part Q: cross-model forecast disagreement ────────────────────────────────

export interface DisagreementMetrics {
  nModels: number;
  returnDispersion: number | null; // stdev of expectedReturn across models
  probDispersion: number | null; // stdev of direction probabilities
  signDisagreementPct: number | null; // % of model pairs disagreeing on sign
}

export function forecastDisagreement(
  outputs: Array<{ expectedReturn: number | null; rawDirectionProbability: number | null }>
): DisagreementMetrics {
  const rets = outputs.map((o) => o.expectedReturn).filter((x): x is number => x != null && Number.isFinite(x));
  const probs = outputs.map((o) => o.rawDirectionProbability).filter((x): x is number => x != null && Number.isFinite(x));
  const sd = (xs: number[]): number | null => {
    if (xs.length < 2) return null;
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.round(Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)) * 1e6) / 1e6;
  };
  let pairs = 0;
  let disagree = 0;
  for (let i = 0; i < rets.length; i++)
    for (let j = i + 1; j < rets.length; j++) {
      pairs++;
      if (Math.sign(rets[i]) !== Math.sign(rets[j])) disagree++;
    }
  return {
    nModels: outputs.length,
    returnDispersion: sd(rets),
    probDispersion: sd(probs),
    signDisagreementPct: pairs > 0 ? Math.round((disagree / pairs) * 10000) / 100 : null,
  };
}
