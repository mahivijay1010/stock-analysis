/**
 * Deterministic contradiction detector (Part 29) — surfaces "WHY THIS IS NOT
 * ENTRY-CONFIRMED" and imposes an action ceiling BEFORE any AI is consulted.
 * Each contradiction returns the cap it forces; the caller takes the minimum.
 */

import { ShortTermActionV2 } from "./actionStates";
import { EvidenceTier } from "./actionStates";
import { EvEvidence } from "./evUncertainty";
import { SetupEvidence } from "./setupEvidence";
import { FreshnessV2 } from "./actionStates";

export interface Contradiction {
  code: string;
  message: string;
  cap: ShortTermActionV2;
}

export function detectContradictions(opts: {
  geometryAction: ShortTermActionV2; // the raw zone/breakout-derived action
  tier: EvidenceTier;
  modelConfidence: "LOW" | "MEDIUM" | "HIGH";
  modelHealthState: string | null;
  freshness: FreshnessV2;
  ev: EvEvidence | null;
  setupEvidence: SetupEvidence;
  positionSizeShares: number | null;
  rankingScore: number | null;
}): Contradiction[] {
  const out: Contradiction[] = [];
  const inZone = opts.geometryAction === "ZONE_REACHED" || opts.geometryAction === "ENTRY_CONFIRMED";

  if (inZone && opts.modelConfidence === "LOW")
    out.push({ code: "ZONE_LOW_CONF", message: "In the entry zone but model confidence is LOW", cap: "WAIT_FOR_CONFIRMATION" });
  if (inZone && opts.modelHealthState === "INSUFFICIENT_HISTORY")
    out.push({ code: "ZONE_INSUFFICIENT_HISTORY", message: "In the entry zone but the live model has INSUFFICIENT_HISTORY", cap: "WAIT_FOR_CONFIRMATION" });
  if (inZone && opts.setupEvidence.expectancyAfterCosts <= 0 && opts.setupEvidence.rawTrades > 0)
    out.push({ code: "ZONE_NEG_EXPECTANCY", message: `In the entry zone but this setup's realized after-cost expectancy is ${opts.setupEvidence.expectancyAfterCosts}R (not positive)`, cap: "RESEARCH_WATCH" });
  if (inZone && !opts.setupEvidence.usableForEntry)
    out.push({ code: "ZONE_UNVALIDATED_SETUP", message: "In the entry zone but the setup is not validated for entry (evidence tier below A)", cap: "RESEARCH_WATCH" });
  if (inZone && opts.freshness === "DELAYED_INTRADAY")
    out.push({ code: "ZONE_DELAYED_DATA", message: "In the entry zone but the quote is delayed intraday — awaiting a confirmed completed bar", cap: "WAIT_FOR_CONFIRMATION" });
  if (opts.ev && opts.ev.meanEvAfterCostsPct > 0 && opts.ev.ev80LowerPct <= 0)
    out.push({ code: "EV_POS_MEAN_NEG_LOWER", message: `Mean EV +${opts.ev.meanEvAfterCostsPct}% but its 80% lower bound ${opts.ev.ev80LowerPct}% is ≤ 0`, cap: "WAIT_FOR_CONFIRMATION" });
  if (opts.positionSizeShares != null && opts.positionSizeShares <= 0)
    out.push({ code: "NOT_AFFORDABLE", message: "Position size is 0 under the current budget/risk — untradeable", cap: "RESEARCH_WATCH" });
  if ((opts.rankingScore ?? 0) > 0 && !opts.setupEvidence.usableForEntry)
    out.push({ code: "RANKED_BUT_UNVALIDATED", message: "Ranked as interesting but the underlying setup is unvalidated", cap: "RESEARCH_WATCH" });

  return out;
}
