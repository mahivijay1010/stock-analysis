/**
 * Quality tiers (Part 19) — the single evidence summary that decides whether
 * a candidate can be a QUALIFIED trade or belongs on the RESEARCH WATCHLIST.
 *
 * Tier is the MINIMUM (most conservative) of: the setup's out-of-sample
 * evidence tier, an EV-uncertainty cap, a model-health cap, a data-quality cap,
 * and a level-plausibility cap. It is NEVER derived from setup score alone.
 * Only Tier A may reach ENTRY_CONFIRMED.
 */

import { EvidenceTier } from "./actionStates";
import { EvEvidence, evGatePasses } from "./evUncertainty";
import { LevelPlausibility } from "./plausibility";
import { SetupEvidence } from "./setupEvidence";

const ORDER: EvidenceTier[] = ["A", "B", "C", "D"];
const worse = (a: EvidenceTier, b: EvidenceTier): EvidenceTier => (ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b);

export interface TierResult {
  tier: EvidenceTier;
  reasons: string[];
  caps: Array<{ source: string; cap: EvidenceTier }>;
}

export function computeTier(opts: {
  setupEvidence: SetupEvidence;
  ev: EvEvidence | null;
  plausibility: LevelPlausibility;
  /** SHORT-TERM model health (SHADOW/HEALTHY/DEGRADED/SUSPENDED) — NOT the long-term quant model. */
  shortTermHealthState: string | null;
  dataQuality: number;
}): TierResult {
  const caps: Array<{ source: string; cap: EvidenceTier }> = [];
  const reasons: string[] = [];

  // Tier reflects BACKTEST evidence strength; live authority (SHADOW) is a
  // separate ceiling applied downstream so a validated setup still shows as
  // tier A while being held below ENTRY_CONFIRMED until shadow-confirmed.
  caps.push({ source: `setup evidence (${opts.setupEvidence.note})`, cap: opts.setupEvidence.evidenceStrength });

  const evOk = evGatePasses(opts.ev);
  if (!evOk.ok) {
    caps.push({ source: "EV uncertainty", cap: "C" });
    reasons.push(...evOk.reasons);
  }

  if (opts.shortTermHealthState === "SUSPENDED") {
    caps.push({ source: "short-term model SUSPENDED", cap: "D" });
    reasons.push("short-term model suspended on live underperformance");
  } else if (opts.shortTermHealthState === "DEGRADED") {
    caps.push({ source: "short-term model DEGRADED", cap: "B" });
    reasons.push("short-term model degraded on live shadow evidence");
  }

  if (opts.dataQuality < 70) {
    caps.push({ source: `data quality ${opts.dataQuality}`, cap: "C" });
    reasons.push("data quality below the entry threshold");
  }

  if (!opts.plausibility.targetPlausible || !opts.plausibility.stopStructural) {
    caps.push({ source: "level plausibility", cap: "B" });
    reasons.push(...opts.plausibility.reasons);
  }

  const tier = caps.reduce<EvidenceTier>((acc, c) => worse(acc, c.cap), "A");
  return { tier, reasons, caps };
}
