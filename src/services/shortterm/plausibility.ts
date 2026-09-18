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
  /** |stop − nearest structural support| as % of entry; null when no support level is known. */
  stopToSupportPct: number | null;
  gapRiskNote: string;
  targetPlausible: boolean;
  stopStructural: boolean;
  qualityPenalty: number; // 0..40 subtracted from entry quality
  reasons: string[];
}

/**
 * Varsity TA 19.5 (the Scout): "If the S&R level is more than 4% away from the
 * stoploss, I stop evaluating the chart further." A stop that does not sit at
 * structure is not a structural stop, however many ATRs away it is.
 */
export const MAX_STOP_TO_SUPPORT_PCT = 4;

export function assessLevels(opts: {
  entry: number;
  stop: number;
  target1: number;
  atr14: number | null;
  ev: EvEvidence | null;
  gapPctRecent: number | null;
  /** Nearest structural support (swing low) in price terms, if known. */
  supportPrice?: number | null;
}): LevelPlausibility {
  const reasons: string[] = [];
  const atr = opts.atr14 && opts.atr14 > 0 ? opts.atr14 : null;
  const t1Atr = atr ? (opts.target1 - opts.entry) / atr : null;
  const stopAtr = atr ? (opts.entry - opts.stop) / atr : null;
  const reach = opts.ev?.targetReachRate ?? null;
  const noise = opts.ev?.stopHitRate ?? null;
  const stopToSupportPct =
    opts.supportPrice != null && opts.supportPrice > 0 && opts.entry > 0
      ? (Math.abs(opts.stop - opts.supportPrice) / opts.entry) * 100
      : null;

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

  // Stop plausibility: a stop inside ~1 ATR is noise-prone…
  const stopInsideNoise = stopAtr != null && stopAtr < 1.0;
  if (stopInsideNoise) {
    penalty += 15;
    reasons.push(`stop is only ${stopAtr!.toFixed(2)} ATR away — inside ordinary daily noise (noise-stop risk)`);
  }
  // …and a stop far from the nearest support is not anchored to structure at
  // all (Varsity's 4% rule). Both conditions make the stop non-structural.
  const stopFarFromSupport = stopToSupportPct != null && stopToSupportPct > MAX_STOP_TO_SUPPORT_PCT;
  if (stopFarFromSupport) {
    penalty += 15;
    reasons.push(
      `stop sits ${stopToSupportPct!.toFixed(1)}% from the nearest support (> ${MAX_STOP_TO_SUPPORT_PCT}%) — not anchored to structure; Varsity's scout rule skips the chart`
    );
  }
  const stopStructural = !stopInsideNoise && !stopFarFromSupport;
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
    stopToSupportPct: stopToSupportPct != null ? Math.round(stopToSupportPct * 100) / 100 : null,
    gapRiskNote,
    targetPlausible,
    stopStructural,
    qualityPenalty: Math.min(40, penalty),
    reasons,
  };
}
