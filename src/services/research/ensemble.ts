/**
 * EnsembleForecastService (completion directive, Phase 8) — PURE combination
 * logic with hard eligibility rules and OUT-OF-SAMPLE weights.
 *
 * Eligibility (all required, evaluated on the VALIDATION segment — never on
 * the test observations the ensemble is finally judged against):
 *  - enough effective (overlap-adjusted) validation samples,
 *  - Brier no worse than the constant-50 floor + tolerance (a model that is
 *    confidently wrong is worse than no model),
 *  - ECE below a sanity ceiling (no catastrophically miscalibrated members),
 *  - the model actually emits the field being ensembled.
 *
 * Weights: inverse-Brier-excess on validation (Brier skill floor-clipped at
 * 0 ⇒ a no-skill model gets the minimum weight, never a negative one).
 * Sector-/regime-aware variants are NOT built: per-sector/per-regime
 * validation slices fall far below the effective-sample floor on this
 * dataset — stated, not faked.
 *
 * If no member is eligible for a horizon, the ensemble abstains (null) —
 * an honest non-forecast, exactly like every other layer.
 */

import { PredRecord } from "./harness";
import { ModelOutput } from "./models";
import { round4 } from "./metrics";

export const ENSEMBLE_VERSION = "ensemble-v1";

export interface EnsembleMember {
  model: string;
  weight: number;
  valBrier: number;
  valEffSamples: number;
}

export interface EnsembleSpec {
  version: string;
  horizonDays: number;
  members: EnsembleMember[];
  excluded: Array<{ model: string; reason: string }>;
}

export const ENSEMBLE_ELIGIBILITY = {
  minValEffSamples: 10,
  maxValBrier: 0.26, // constant-50 floor (0.25) + tolerance — confidently-wrong models are out
  maxValEce: 0.1,
} as const;

const flat = (r: number): 0 | 1 => (r > 0 ? 1 : 0);

function valStats(preds: PredRecord[], overlapTd: number): { brier: number | null; ece: number | null; effN: number } {
  const withProb = preds.filter((p) => p.output.rawDirectionProbability != null);
  const dates = new Set(withProb.map((p) => p.date)).size;
  const effN = Math.max(1, Math.floor(dates / Math.max(1, overlapTd)));
  if (withProb.length === 0) return { brier: null, ece: null, effN };
  const probs = withProb.map((p) => p.output.rawDirectionProbability as number);
  const ys = withProb.map((p) => flat(p.target));
  const brier = round4(probs.reduce((a, p, i) => a + (p - ys[i]) ** 2, 0) / probs.length);
  // 10-bin ECE inline (keep pure, avoid import cycle)
  const bins = 10;
  const sums = Array(bins).fill(0);
  const hits = Array(bins).fill(0);
  const counts = Array(bins).fill(0);
  for (let i = 0; i < probs.length; i++) {
    const b = Math.min(bins - 1, Math.floor(probs[i] * bins));
    sums[b] += probs[i];
    hits[b] += ys[i];
    counts[b]++;
  }
  let ece = 0;
  for (let b = 0; b < bins; b++) {
    if (counts[b] === 0) continue;
    ece += (counts[b] / probs.length) * Math.abs(hits[b] / counts[b] - sums[b] / counts[b]);
  }
  return { brier, ece: round4(ece), effN };
}

/**
 * Build the ensemble spec for one horizon from VALIDATION predictions only.
 */
export function buildEnsemble(
  validationByModel: Record<string, PredRecord[]>,
  horizonDays: number,
  overlapTd: number
): EnsembleSpec {
  const members: EnsembleMember[] = [];
  const excluded: Array<{ model: string; reason: string }> = [];
  for (const [model, preds] of Object.entries(validationByModel)) {
    const { brier, ece, effN } = valStats(preds, overlapTd);
    if (brier == null) {
      excluded.push({ model, reason: "emits no direction probability" });
      continue;
    }
    if (effN < ENSEMBLE_ELIGIBILITY.minValEffSamples) {
      excluded.push({ model, reason: `only ~${effN} independent validation obs (< ${ENSEMBLE_ELIGIBILITY.minValEffSamples})` });
      continue;
    }
    if (brier > ENSEMBLE_ELIGIBILITY.maxValBrier) {
      excluded.push({ model, reason: `validation Brier ${brier} > ${ENSEMBLE_ELIGIBILITY.maxValBrier} (confidently wrong)` });
      continue;
    }
    if (ece != null && ece > ENSEMBLE_ELIGIBILITY.maxValEce) {
      excluded.push({ model, reason: `validation ECE ${ece} > ${ENSEMBLE_ELIGIBILITY.maxValEce} (miscalibrated)` });
      continue;
    }
    // Inverse-Brier-excess weight, floored: skill ≤ 0 ⇒ minimal but non-negative.
    const skill = Math.max(0, 0.25 - brier);
    members.push({ model, weight: 0.01 + skill, valBrier: brier, valEffSamples: effN });
  }
  const total = members.reduce((a, m) => a + m.weight, 0);
  for (const m of members) m.weight = round4(total > 0 ? m.weight / total : 0);
  return { version: ENSEMBLE_VERSION, horizonDays, members, excluded };
}

/** Combine member outputs for one row (weighted means; abstains when empty). */
export function combineOutputs(
  spec: EnsembleSpec,
  outputsByModel: Record<string, ModelOutput | undefined>,
  featureTimestamp: string
): ModelOutput | null {
  const present = spec.members.filter((m) => outputsByModel[m.model]);
  if (present.length === 0) return null;
  const wTotal = present.reduce((a, m) => a + m.weight, 0);
  if (wTotal <= 0) return null;

  let prob: number | null = null;
  let probW = 0;
  let er: number | null = null;
  let erW = 0;
  const q = { p10: 0, p50: 0, p90: 0 };
  let qW = 0;
  for (const m of present) {
    const o = outputsByModel[m.model]!;
    if (o.rawDirectionProbability != null) {
      prob = (prob ?? 0) + m.weight * o.rawDirectionProbability;
      probW += m.weight;
    }
    if (o.expectedReturn != null) {
      er = (er ?? 0) + m.weight * o.expectedReturn;
      erW += m.weight;
    }
    if (o.quantiles) {
      q.p10 += m.weight * o.quantiles.p10;
      q.p50 += m.weight * o.quantiles.p50;
      q.p90 += m.weight * o.quantiles.p90;
      qW += m.weight;
    }
  }
  return {
    modelName: "ensemble-global",
    modelVersion: ENSEMBLE_VERSION,
    horizonDays: spec.horizonDays,
    expectedReturn: er != null && erW > 0 ? round4(er / erW) : null,
    medianReturn: qW > 0 ? round4(q.p50 / qW) : null,
    quantiles: qW > 0 ? { p10: round4(q.p10 / qW), p50: round4(q.p50 / qW), p90: round4(q.p90 / qW) } : null,
    rawDirectionProbability: prob != null && probW > 0 ? round4(prob / probW) : null,
    featureTimestamp,
    trainingEndDate: spec.members.map((m) => m.model).join("+"),
  };
}
