/**
 * Target + stop plausibility (Parts 16/17) — PURE, driven by the EV-engine's
 * own bracket-MC distribution so levels can't be chosen just to flatter R:R.
 *
 * A target that the horizon's return distribution rarely reaches lowers entry
 * quality; a stop that sits inside ordinary daily noise (< ~1 ATR) is flagged
 * as noise-prone. Nothing here widens stops or moves targets — it only scores
 * how believable the given levels are.
 */

import { EvEvidence } from "./evUncertainty";

export interface LevelPlausibility {
  target1DistanceAtr: number | null;
  target1ReachRate: number | null; // from bracket MC: fraction of paths that touched T1 first
  stopDistanceAtr: number | null;
  stopNoiseRate: number | null; // fraction of paths that hit the stop first
  gapRiskNote: string;
  targetPlausible: boolean;
  stopStructural: boolean;
  qualityPenalty: number; // 0..40 subtracted from entry quality
  reasons: string[];
}

export function assessLevels(opts: {
  entry: number;
  stop: number;
  target1: number;
  atr14: number | null;
  ev: EvEvidence | null;
  gapPctRecent: number | null;
}): LevelPlausibility {
  const reasons: string[] = [];
  const atr = opts.atr14 && opts.atr14 > 0 ? opts.atr14 : null;
  const t1Atr = atr ? (opts.target1 - opts.entry) / atr : null;
  const stopAtr = atr ? (opts.entry - opts.stop) / atr : null;
  const reach = opts.ev?.targetReachRate ?? null;
  const noise = opts.ev?.stopHitRate ?? null;

  let penalty = 0;
  // Target plausibility: must be reachable often enough within the horizon.
  const targetPlausible = reach != null ? reach >= 0.2 : t1Atr != null ? t1Atr <= 3 : true;
  if (reach != null && reach < 0.2) {
    penalty += 20;
    reasons.push(`target reached in only ${(reach * 100).toFixed(0)}% of horizon paths — implausible within the window`);
  }
  if (t1Atr != null && t1Atr > 3) {
    penalty += 10;
    reasons.push(`target is ${t1Atr.toFixed(1)} ATR away — far for the horizon`);
  }

  // Stop plausibility: a stop inside ~1 ATR is noise-prone.
  const stopStructural = stopAtr == null || stopAtr >= 1.0;
  if (stopAtr != null && stopAtr < 1.0) {
    penalty += 15;
    reasons.push(`stop is only ${stopAtr.toFixed(2)} ATR away — inside ordinary daily noise (noise-stop risk)`);
  }
  if (noise != null && noise > 0.4) {
    penalty += 10;
    reasons.push(`stop hit first in ${(noise * 100).toFixed(0)}% of paths — high noise-out probability`);
  }

  const gapRiskNote =
    opts.gapPctRecent != null && stopAtr != null && atr != null && Math.abs(opts.gapPctRecent) * opts.entry * 0.01 > 0.5 * atr
      ? "recent gaps are large relative to ATR — an overnight gap can jump the stop"
      : "gap risk within normal range for this stock";

  return {
    target1DistanceAtr: t1Atr != null ? Math.round(t1Atr * 100) / 100 : null,
    target1ReachRate: reach,
    stopDistanceAtr: stopAtr != null ? Math.round(stopAtr * 100) / 100 : null,
    stopNoiseRate: noise,
    gapRiskNote,
    targetPlausible,
    stopStructural,
    qualityPenalty: Math.min(40, penalty),
    reasons,
  };
}
