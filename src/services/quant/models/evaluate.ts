/**
 * V7 Module A2 — walk-forward evaluation of the model pool (PURE, ZERO
 * lookahead).
 *
 * For each trading day T in the last `testDays` (≥120 bars of lookback and the
 * horizon's future bar available — the SAME loop shape as backtestBars), every
 * model predicts from bars[0..T] (and the index bars dated ≤ bars[T].date)
 * ONLY. Outcome = 1 if close[T+offset] > close[T] else 0.
 *
 * The BLENDED ensemble stat is also out-of-sample: the weights used at day T
 * are inverse-Brier weights computed from samples whose OUTCOME had already
 * matured by day T (T' + offset ≤ T). Before enough matured samples exist the
 * blend uses equal weights. No future information ever reaches a weight.
 *
 * Historical news sentiment and regime scores are not archived (free data),
 * so walk-forward inputs pass null for both — the sentiment model degrades to
 * its r5 term and the macro model to its index term. That is an honest
 * limitation, stated here rather than papered over.
 */

import { Bar, Horizon, ModelHorizonStat } from "../types";
import { HORIZONS, TRADING_DAY_OFFSETS } from "../engine";
import { ModelName, MODEL_NAMES } from "./types";
import { predictAll } from "./index";
import { inverseBrierWeights, blendProb, WeightsByModel, equalWeights } from "./selector";

const MIN_LOOKBACK = 120;
/** Minimum matured samples per model before inverse-Brier weights kick in. */
const MIN_PRIOR_SAMPLES = 5;

export interface ModelPoolHorizonStats {
  horizonDays: Horizon;
  models: Record<ModelName, ModelHorizonStat>;
  /** Out-of-sample blended-ensemble stat (online inverse-Brier weights). */
  ensemble: ModelHorizonStat;
}

export interface ModelPoolEvaluation {
  testDays: number;
  horizons: ModelPoolHorizonStats[];
}

interface Sample {
  t: number; // bar index the prediction was made on
  outcome: 0 | 1;
  probs: Record<ModelName, number>;
}

function round4(x: number): number {
  const r = Math.round(x * 10_000) / 10_000;
  return Object.is(r, -0) ? 0 : r;
}

function round2(x: number): number {
  const r = Math.round(x * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

/** hit = the model leaned the right way; p = 0.5 never counts as a hit. */
function isHit(p: number, outcome: 0 | 1): boolean {
  return (p - 0.5) * (outcome - 0.5) > 0;
}

function statFrom(rows: Array<{ p: number; outcome: 0 | 1 }>): ModelHorizonStat {
  const n = rows.length;
  if (n === 0) return { brier: 0, hitRatePct: 0, samples: 0 };
  let sqErr = 0;
  let hits = 0;
  for (const r of rows) {
    sqErr += (r.p - r.outcome) ** 2;
    if (isHit(r.p, r.outcome)) hits++;
  }
  return {
    brier: round4(sqErr / n),
    hitRatePct: round2((hits / n) * 100),
    samples: n,
  };
}

export function evaluateModelPool(
  bars: Bar[],
  opts?: { testDays?: number; niftyBars?: Bar[] | null }
): ModelPoolEvaluation {
  const testDays = opts?.testDays ?? 60;
  const nifty = opts?.niftyBars ?? null;
  const n = Array.isArray(bars) ? bars.length : 0;

  // Collect walk-forward samples per horizon, ordered by T.
  const samplesByHorizon = new Map<Horizon, Sample[]>();
  for (const h of HORIZONS) samplesByHorizon.set(h, []);

  const startT = Math.max(MIN_LOOKBACK, n - testDays);
  let niftyPtr = 0; // as-of pointer into the (chronological) index bars
  for (let T = startT; T <= n - 2; T++) {
    const baseClose = bars[T].close;
    if (!(baseClose > 0)) continue;

    // Index bars strictly as-of the prediction date (zero lookahead).
    let niftyAsOf: Bar[] | null = null;
    if (nifty && nifty.length > 0) {
      while (niftyPtr < nifty.length && nifty[niftyPtr].date <= bars[T].date) niftyPtr++;
      niftyAsOf = nifty.slice(0, niftyPtr);
    }

    const probs = predictAll({
      bars: bars.slice(0, T + 1),
      niftyBars: niftyAsOf,
      newsSentimentScore: null, // not archived historically — honest null
      regimeScore: null, // not archived historically — honest null
    });

    for (const h of HORIZONS) {
      const futureIdx = T + TRADING_DAY_OFFSETS[h];
      if (futureIdx >= n) continue; // horizon not matured within the data
      const outcome: 0 | 1 = bars[futureIdx].close > baseClose ? 1 : 0;
      const perModel = {} as Record<ModelName, number>;
      for (const name of MODEL_NAMES) perModel[name] = probs[name][h];
      samplesByHorizon.get(h)!.push({ t: T, outcome, probs: perModel });
    }
  }

  const horizons: ModelPoolHorizonStats[] = HORIZONS.map((h) => {
    const samples = samplesByHorizon.get(h)!;
    const offset = TRADING_DAY_OFFSETS[h];

    // Per-model stats over all samples.
    const models = {} as Record<ModelName, ModelHorizonStat>;
    for (const name of MODEL_NAMES) {
      models[name] = statFrom(samples.map((s) => ({ p: s.probs[name], outcome: s.outcome })));
    }

    // Out-of-sample online blend: weights at sample T use only samples whose
    // outcome bar (t' + offset) is ≤ T.
    const blendRows: Array<{ p: number; outcome: 0 | 1 }> = [];
    const maturedSqErr = {} as Record<ModelName, number>;
    let maturedCount = 0;
    for (const name of MODEL_NAMES) maturedSqErr[name] = 0;
    let maturedPtr = 0;

    for (const s of samples) {
      while (maturedPtr < samples.length && samples[maturedPtr].t + offset <= s.t) {
        const m = samples[maturedPtr];
        for (const name of MODEL_NAMES) {
          maturedSqErr[name] += (m.probs[name] - m.outcome) ** 2;
        }
        maturedCount++;
        maturedPtr++;
      }
      let weights: WeightsByModel;
      if (maturedCount >= MIN_PRIOR_SAMPLES) {
        const briers: Partial<Record<ModelName, number>> = {};
        for (const name of MODEL_NAMES) briers[name] = maturedSqErr[name] / maturedCount;
        weights = inverseBrierWeights(briers);
      } else {
        weights = equalWeights();
      }
      blendRows.push({ p: blendProb(weights, s.probs), outcome: s.outcome });
    }

    return { horizonDays: h, models, ensemble: statFrom(blendRows) };
  });

  return { testDays, horizons };
}

/**
 * Merge a pool evaluation into a BacktestResult's horizons (in place) so one
 * ModelPerformance row carries the V6 calibration AND the V7 model stats.
 */
export function mergeModelStats(
  horizons: Array<{ horizonDays: Horizon; models?: Record<string, ModelHorizonStat>; ensemble?: ModelHorizonStat }>,
  pool: ModelPoolEvaluation
): void {
  const byHorizon = new Map(pool.horizons.map((h) => [h.horizonDays, h]));
  for (const h of horizons) {
    const p = byHorizon.get(h.horizonDays);
    if (!p) continue;
    h.models = p.models;
    h.ensemble = p.ensemble;
  }
}
