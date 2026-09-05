/**
 * V7 Module A2/A3 — EnsembleSelector (PURE).
 *
 * Given stored per-model walk-forward briers for a (ticker, horizon), compute
 * inverse-Brier weights: w_m ∝ max(0.25 − brier_m, 0.001). A model that beats
 * the coin flip more gets more weight; one worse than the coin flip keeps a
 * floor weight of ~nothing (never negative, never exactly zero).
 *
 * A3: when live regret-updated weights (scripts/updateEnsemble.ts) are FRESHER
 * than the backtest stats, they are preferred. Fallback with no stored stats
 * at all: equal weights — an honest "we don't know yet".
 */

import { ModelHorizonStat } from "../types";
import { ModelName, MODEL_NAMES } from "./types";

const COIN_FLIP_BRIER = 0.25;
const EDGE_FLOOR = 0.001;

export type WeightsByModel = Record<ModelName, number>;

export interface EnsembleSelection {
  /** Normalized weights over all 6 models (sum = 1). */
  weights: WeightsByModel;
  /** Lowest-brier model from the stored backtest stats (null when none). */
  bestModel: { name: ModelName; brier: number; samples: number } | null;
  source: "live" | "backtest" | "equal";
}

function round6(x: number): number {
  return Math.round(x * 1_000_000) / 1_000_000;
}

export function equalWeights(): WeightsByModel {
  const w = {} as WeightsByModel;
  for (const name of MODEL_NAMES) w[name] = 1 / MODEL_NAMES.length;
  return w;
}

/**
 * Inverse-Brier weights: raw_m = max(0.25 − brier_m, 0.001), normalized.
 * Models missing a brier get the coin-flip edge floor (they are unproven,
 * not trusted). Returns equal weights when no model has a brier.
 */
export function inverseBrierWeights(
  briers: Partial<Record<ModelName, number>>
): WeightsByModel {
  const raw = {} as WeightsByModel;
  let any = false;
  for (const name of MODEL_NAMES) {
    const b = briers[name];
    if (b !== undefined && Number.isFinite(b)) {
      raw[name] = Math.max(COIN_FLIP_BRIER - b, EDGE_FLOOR);
      any = true;
    } else {
      raw[name] = EDGE_FLOOR;
    }
  }
  if (!any) return equalWeights();
  const sum = MODEL_NAMES.reduce((s, n) => s + raw[n], 0);
  const out = {} as WeightsByModel;
  for (const name of MODEL_NAMES) out[name] = round6(raw[name] / sum);
  return out;
}

/** Normalize an arbitrary stored weights jsonb over the 6 known models. */
export function normalizeStoredWeights(
  stored: Partial<Record<string, number>>
): WeightsByModel | null {
  const raw = {} as WeightsByModel;
  let sum = 0;
  for (const name of MODEL_NAMES) {
    const w = stored[name];
    raw[name] = w !== undefined && Number.isFinite(w) && w > 0 ? w : 0;
    sum += raw[name];
  }
  if (sum <= 0) return null;
  const out = {} as WeightsByModel;
  for (const name of MODEL_NAMES) out[name] = round6(raw[name] / sum);
  return out;
}

export interface SelectEnsembleInput {
  /** Per-model walk-forward stats for this (ticker, horizon) from ModelPerformance. */
  backtestStats?: Partial<Record<string, ModelHorizonStat>> | null;
  /** When the backtest stats were computed. */
  backtestRanAt?: Date | string | null;
  /** Live regret-updated weights row for this (ticker, horizon), if any. */
  liveWeights?: {
    weights: Partial<Record<string, number>>;
    updatedAt: Date | string;
  } | null;
}

export function selectEnsemble(input: SelectEnsembleInput): EnsembleSelection {
  const stats = input.backtestStats ?? null;

  // Best model (by stored backtest brier) is reported regardless of source.
  let bestModel: EnsembleSelection["bestModel"] = null;
  if (stats) {
    for (const name of MODEL_NAMES) {
      const s = stats[name];
      if (!s || !(s.samples > 0) || !Number.isFinite(s.brier)) continue;
      if (bestModel === null || s.brier < bestModel.brier) {
        bestModel = { name, brier: s.brier, samples: s.samples };
      }
    }
  }

  // A3: prefer live weights when fresher than the backtest stats.
  if (input.liveWeights) {
    const liveAt = new Date(input.liveWeights.updatedAt).getTime();
    const backAt = input.backtestRanAt ? new Date(input.backtestRanAt).getTime() : 0;
    if (Number.isFinite(liveAt) && liveAt >= backAt) {
      const w = normalizeStoredWeights(input.liveWeights.weights);
      if (w) return { weights: w, bestModel, source: "live" };
    }
  }

  if (bestModel !== null && stats) {
    const briers: Partial<Record<ModelName, number>> = {};
    for (const name of MODEL_NAMES) {
      const s = stats[name];
      if (s && s.samples > 0 && Number.isFinite(s.brier)) briers[name] = s.brier;
    }
    return { weights: inverseBrierWeights(briers), bestModel, source: "backtest" };
  }

  return { weights: equalWeights(), bestModel: null, source: "equal" };
}

/** Blend per-model probabilities with the selected weights. */
export function blendProb(
  weights: WeightsByModel,
  probs: Partial<Record<ModelName, number>>
): number {
  let p = 0;
  let wSum = 0;
  for (const name of MODEL_NAMES) {
    const prob = probs[name];
    if (prob === undefined || !Number.isFinite(prob)) continue;
    p += weights[name] * prob;
    wSum += weights[name];
  }
  if (wSum <= 0) return 0.5;
  return p / wSum;
}
