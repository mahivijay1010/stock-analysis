/**
 * MaterialityDetector (reviewer #16) — the numerical engine evaluates all
 * stocks every checkpoint, but the LLM fires ONLY when something meaningful
 * changed. This keeps the AI cost bounded and the audit trail legible. PURE.
 *
 * A ₹1435.20 → ₹1435.25 drift is NOT material; a confirmed breakout, a VWAP
 * flip, a relative-strength shock, a regime/gate change, or a data-quality
 * deterioration IS.
 */

import { StateDelta } from "./types";

export interface MaterialityThresholds {
  minRelativeStrengthDelta: number; // percentile/points move that counts
  minRelativeVolumeDelta: number;
  minPostureDelta: number;
}

export const DEFAULT_MATERIALITY_THRESHOLDS: MaterialityThresholds = {
  minRelativeStrengthDelta: 10,
  minRelativeVolumeDelta: 0.5,
  minPostureDelta: 0.2,
};

export interface MaterialityResult {
  material: boolean;
  reasons: string[];
}

export function detectMateriality(delta: StateDelta, thresholds: Partial<MaterialityThresholds> = {}): MaterialityResult {
  const t = { ...DEFAULT_MATERIALITY_THRESHOLDS, ...thresholds };
  const reasons: string[] = [];

  if (delta.newBreakout) reasons.push("BREAKOUT_CONFIRMED");
  if (delta.failedBreakout) reasons.push("BREAKOUT_FAILED");
  if (delta.vwapCrossed) reasons.push("VWAP_CROSS");
  if (delta.setupChanged) reasons.push("SETUP_CHANGED");
  if (delta.trendChanged) reasons.push("TREND_CHANGED");
  if (delta.gateChanged) reasons.push("GATE_CHANGED");
  if (delta.entryQualityChanged) reasons.push("ENTRY_QUALITY_CHANGED");
  if (delta.riskChanged) reasons.push("RISK_CHANGED");
  if (delta.dataQualityChanged) reasons.push("DATA_QUALITY_CHANGED");
  if (delta.relativeStrengthDelta != null && Math.abs(delta.relativeStrengthDelta) >= t.minRelativeStrengthDelta) reasons.push("RELATIVE_STRENGTH_SHOCK");
  if (delta.relativeVolumeDelta != null && Math.abs(delta.relativeVolumeDelta) >= t.minRelativeVolumeDelta) reasons.push("VOLUME_SHOCK");
  if (Math.abs(delta.postureDelta) >= t.minPostureDelta) reasons.push("POSTURE_SHIFT");

  return { material: reasons.length > 0, reasons };
}
