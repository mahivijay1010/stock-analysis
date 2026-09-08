/**
 * Deterministic counterfactual engine (Part 15) — "What would make this a BUY?"
 *
 * Conditions are COMPUTED from the published gate's own unmet gates plus the
 * calibration/monitoring state — never invented, never price targets. The AI
 * may only EXPLAIN these conditionIds in plain language (validated against
 * this exact id set); it cannot add conditions.
 */

import { DecisionSnapshot } from "../../entities";

export const COUNTERFACTUAL_VERSION = "counterfactual-v1";

export interface UpgradeCondition {
  conditionId: string;
  gate: string;
  current: string;
  required: string;
  category: "evidence" | "calibration" | "entry" | "regime" | "risk" | "monitoring" | "data";
}

const CATEGORY_BY_GATE: Array<{ match: RegExp; category: UpgradeCondition["category"] }> = [
  { match: /edge|sample|brier|band coverage|confidence/i, category: "evidence" },
  { match: /calibra/i, category: "calibration" },
  { match: /entry/i, category: "entry" },
  { match: /regime/i, category: "regime" },
  { match: /risk|volatility|expected value/i, category: "risk" },
  { match: /model health/i, category: "monitoring" },
  { match: /data quality|issuance/i, category: "data" },
];

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Pure: derive the exact upgrade conditions from a published snapshot. */
export function deriveUpgradeConditions(snapshot: Pick<DecisionSnapshot, "unmetGates" | "inputs" | "decisionStatus">): UpgradeCondition[] {
  const conditions: UpgradeCondition[] = [];
  const seen = new Set<string>();

  for (const g of snapshot.unmetGates ?? []) {
    const conditionId = `gate:${slug(g.gate)}`;
    if (seen.has(conditionId)) continue;
    seen.add(conditionId);
    conditions.push({
      conditionId,
      gate: g.gate,
      current: g.current,
      required: g.required,
      category: CATEGORY_BY_GATE.find((c) => c.match.test(g.gate))?.category ?? "evidence",
    });
  }

  const inputs = (snapshot.inputs ?? {}) as Record<string, any>;
  const dp = inputs.directionProbability as Record<string, any> | null;
  if (dp && dp.status !== "calibrated" && !seen.has("calibration:direction-probability")) {
    conditions.push({
      conditionId: "calibration:direction-probability",
      gate: "calibrated direction probability",
      current: "unavailable — no promoted calibrator at the 30d horizon",
      required: "a calibrator promoted on held-out evidence (≥10 independent obs, Brier improved, ECE not degraded)",
      category: "calibration",
    });
  }
  const mh = inputs.modelHealth as Record<string, any> | null;
  if (mh && mh.overallState === "INSUFFICIENT_HISTORY" && !seen.has("gate:model-health")) {
    conditions.push({
      conditionId: "monitoring:live-history",
      gate: "live monitoring history",
      current: String(mh.overallState),
      required: "≥10 overlap-adjusted resolved live predictions at an assessable horizon",
      category: "monitoring",
    });
  }
  return conditions;
}
