/**
 * Module 2 — walk-forward backtest (pure, zero lookahead).
 * For each trading day T in the last `testDays` (with ≥120 bars of lookback and the
 * horizon's future bar available), the prediction is computed from bars[0..T] ONLY.
 * actualPct = (close[T + offset] / close[T] - 1) * 100 with calendar→trading-day
 * offsets {1:1, 3:2, 7:5, 15:10, 30:21}.
 */

import { Bar, BacktestHorizonStats, BacktestResult, Horizon, ProbBucket } from './types';
import { analyzeBars, HORIZONS, TRADING_DAY_OFFSETS } from './engine';

const MIN_LOOKBACK = 120; // bars strictly before T
const NEAR_ZERO_ACTUAL_PCT = 0.05;
const NEAR_ZERO_PREDICTED_PCT = 0.3;
const MAX_SAMPLES = 50;

/**
 * Same one-line adjustment policy as market/canonical.ts's analysisCloses —
 * duplicated here (not imported) because this module is pure and must not
 * depend on src/services/market. `engine.ts` builds its return distribution
 * and predictions on this same adjusted-close basis (rescaled to today's
 * price units); grading actualPct against the RAW close instead (as this
 * function previously did) let a split or large dividend inside the horizon
 * window inject a spurious "actual" move the model was never scored fairly
 * against (docs/system-trust-review.md §5.2).
 */
function analysisClose(bar: Bar): number {
  const adj = bar.adjustedClose;
  return adj != null && Number.isFinite(adj) && adj > 0 ? adj : bar.close;
}

function round(x: number, dp: number): number {
  const f = Math.pow(10, dp);
  const r = Math.round(x * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

/**
 * Direction hit rule: strict sign match, except near-zero actual moves
 * (|actual| < 0.05%) which count as a hit only when the prediction was also
 * near-zero (|predicted| < 0.3%).
 */
export function isDirectionHit(predictedPct: number, actualPct: number): boolean {
  if (Math.abs(actualPct) < NEAR_ZERO_ACTUAL_PCT) {
    return Math.abs(predictedPct) < NEAR_ZERO_PREDICTED_PCT;
  }
  return Math.sign(predictedPct) === Math.sign(actualPct);
}

interface HorizonSample {
  predictedPct: number;
  actualPct: number;
  correct: boolean;
  withinBand: boolean;
  directionProb: number; // 0..1 stated P(up) at prediction time
}

/** V6 fixed reliability-bucket edges (see SPEC_CALIBRATION.md Module C1). */
export const PROB_BUCKET_EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 0.4],
  [0.4, 0.475],
  [0.475, 0.525],
  [0.525, 0.6],
  [0.6, 1],
];

/**
 * V6 calibration over (directionProb, actualPct) pairs — pure and reusable so
 * tests can feed synthetic probabilities directly.
 * outcome = 1 if actualPct > 0 else 0 (a flat close counts as "not up").
 * Returns null for an empty sample set (no honest number to report).
 */
export function computeCalibration(
  rows: Array<{ directionProb: number; actualPct: number }>
): { brierScore: number; probBuckets: ProbBucket[] } | null {
  if (rows.length === 0) return null;

  let sqErrSum = 0;
  const buckets = PROB_BUCKET_EDGES.map(([pLow, pHigh]) => ({
    pLow,
    pHigh,
    n: 0,
    probSum: 0,
    upCount: 0,
  }));

  for (const r of rows) {
    const p = Math.min(1, Math.max(0, r.directionProb));
    const outcome = r.actualPct > 0 ? 1 : 0;
    sqErrSum += (p - outcome) ** 2;
    // [pLow, pHigh) except the last bucket, which includes its upper edge (1).
    const b =
      buckets.find((x, i) => p >= x.pLow && (p < x.pHigh || i === buckets.length - 1)) ??
      buckets[buckets.length - 1];
    b.n += 1;
    b.probSum += p;
    b.upCount += outcome;
  }

  return {
    brierScore: round(sqErrSum / rows.length, 4),
    probBuckets: buckets.map((b) => ({
      pLow: b.pLow,
      pHigh: b.pHigh,
      n: b.n,
      meanPredicted: b.n > 0 ? round(b.probSum / b.n, 4) : 0,
      observedUpFreq: b.n > 0 ? round(b.upCount / b.n, 4) : 0,
    })),
  };
}

export function backtestBars(
  ticker: string,
  bars: Bar[],
  opts?: { testDays?: number }
): BacktestResult {
  const testDays = opts?.testDays ?? 60;
  const n = Array.isArray(bars) ? bars.length : 0;

  const perHorizon = new Map<Horizon, HorizonSample[]>();
  for (const h of HORIZONS) perHorizon.set(h, []);
  const samples: BacktestResult['samples'] = [];

  const startT = Math.max(MIN_LOOKBACK, n - testDays);
  for (let T = startT; T <= n - 2; T++) {
    // ZERO LOOKAHEAD: the analysis at day T sees bars[0..T] only.
    const analysis = analyzeBars(bars.slice(0, T + 1));
    const baseClose = analysisClose(bars[T]);
    if (!(baseClose > 0)) continue;

    for (const pred of analysis.predictions) {
      const offset = TRADING_DAY_OFFSETS[pred.horizonDays];
      const futureIdx = T + offset;
      if (futureIdx >= n) continue; // horizon has not matured within the data

      const actualPct = round((analysisClose(bars[futureIdx]) / baseClose - 1) * 100, 4);
      const predictedPct = pred.expectedReturnPct;
      const correct = isDirectionHit(predictedPct, actualPct);
      const withinBand = actualPct >= pred.low80Pct && actualPct <= pred.high80Pct;

      perHorizon
        .get(pred.horizonDays)!
        .push({ predictedPct, actualPct, correct, withinBand, directionProb: pred.directionProb });
      samples.push({
        date: bars[T].date,
        horizonDays: pred.horizonDays,
        predictedPct,
        actualPct,
        correct,
      });
    }
  }

  const horizons: BacktestHorizonStats[] = HORIZONS.map((h) => {
    const rows = perHorizon.get(h)!;
    const count = rows.length;
    if (count === 0) {
      return {
        horizonDays: h,
        samples: 0,
        directionHitRatePct: 0,
        avgAbsErrorPct: 0,
        avgPredictedPct: 0,
        avgActualPct: 0,
        withinBandPct: 0,
      };
    }
    const hits = rows.filter((r) => r.correct).length;
    const within = rows.filter((r) => r.withinBand).length;
    const absErr = rows.reduce((s, r) => s + Math.abs(r.predictedPct - r.actualPct), 0) / count;
    const avgPred = rows.reduce((s, r) => s + r.predictedPct, 0) / count;
    const avgActual = rows.reduce((s, r) => s + r.actualPct, 0) / count;
    // V6: calibration of the stated direction probabilities (count > 0 here,
    // so computeCalibration never returns null on this path).
    const calibration = computeCalibration(rows)!;
    return {
      horizonDays: h,
      samples: count,
      directionHitRatePct: round((hits / count) * 100, 2),
      avgAbsErrorPct: round(absErr, 4),
      avgPredictedPct: round(avgPred, 4),
      avgActualPct: round(avgActual, 4),
      withinBandPct: round((within / count) * 100, 2),
      brierScore: calibration.brierScore,
      probBuckets: calibration.probBuckets,
    };
  });

  return {
    ticker,
    testDays,
    ranAt: new Date().toISOString(),
    horizons,
    // most recent ≤50, newest first
    samples: samples.slice(-MAX_SAMPLES).reverse(),
  };
}
