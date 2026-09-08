/**
 * SHORT-TERM V2 — action states + evidence-based ceilings (Parts 1/2/19).
 *
 * The core V2 fix: a stock reaching a mathematically-computed entry ZONE does
 * NOT imply it is actionable. Every candidate's action is the MOST
 * CONSERVATIVE of its geometry-derived action and a set of ceilings imposed by
 * evidence tier, model health, model confidence, data freshness and
 * deterministic contradictions. AI can only lower further, never raise.
 *
 * ZONE_REACHED != ENTRY_CONFIRMED. ENTRY_CONFIRMED requires TIER A evidence,
 * a satisfied confirmation trigger, fresh data, positive EV lower bound, and
 * no active veto — none of which the LOW-confidence / INSUFFICIENT_HISTORY /
 * unvalidated-setup case can currently produce.
 */

export type ShortTermActionV2 =
  | "NO_SETUP"
  | "NO_TRADE"
  | "RESEARCH_WATCH"
  | "SETUP_DETECTED"
  | "ZONE_REACHED"
  | "WAIT_FOR_CONFIRMATION"
  | "ENTRY_CONFIRMED"
  | "ACTIVE_POSITION"
  | "TAKE_PARTIAL"
  | "TRAIL"
  | "EXIT"
  | "INVALIDATED";

/**
 * Actionability ladder (higher = closer to committing capital). Capping takes
 * the MINIMUM. Terminal/management states (ACTIVE_POSITION+) are above
 * ENTRY_CONFIRMED because they only apply to positions already opened; the
 * scanner never assigns them, so they never get capped down.
 */
const LADDER: Record<ShortTermActionV2, number> = {
  NO_SETUP: 0,
  NO_TRADE: 0,
  INVALIDATED: 0,
  RESEARCH_WATCH: 1,
  SETUP_DETECTED: 2,
  ZONE_REACHED: 3,
  WAIT_FOR_CONFIRMATION: 4,
  ENTRY_CONFIRMED: 5,
  ACTIVE_POSITION: 6,
  TAKE_PARTIAL: 6,
  TRAIL: 6,
  EXIT: 6,
};

export function actionRank(a: ShortTermActionV2): number {
  return LADDER[a] ?? 0;
}

/** The more conservative (lower-actionability) of two states. */
export function capAction(a: ShortTermActionV2, ceiling: ShortTermActionV2): ShortTermActionV2 {
  return actionRank(ceiling) < actionRank(a) ? ceiling : a;
}

export type EvidenceTier = "A" | "B" | "C" | "D";

/** Tier → maximum action it may EVER reach (Part 19). */
export function tierCeiling(tier: EvidenceTier): ShortTermActionV2 {
  switch (tier) {
    case "A":
      return "ENTRY_CONFIRMED";
    case "B":
      return "WAIT_FOR_CONFIRMATION";
    case "C":
      return "RESEARCH_WATCH";
    default:
      return "NO_TRADE";
  }
}

export type FreshnessV2 = "LIVE" | "DELAYED_INTRADAY" | "EOD_FINAL" | "STALE";

export interface CeilingInputs {
  tier: EvidenceTier;
  modelHealthState: string | null;
  modelConfidence: "LOW" | "MEDIUM" | "HIGH";
  freshness: FreshnessV2;
  confirmationSatisfied: boolean;
  evLowerBoundPositive: boolean;
  affordable: boolean;
  contradictionCeilings: ShortTermActionV2[];
}

export interface CeilingResult {
  ceiling: ShortTermActionV2;
  reasons: string[];
}

/**
 * Compose every evidence ceiling into a single maximum-allowed action, with
 * the binding reason(s) recorded. This is the deterministic heart of V2:
 * the acceptance-test combination (unvalidated setup + LOW + INSUFFICIENT_
 * HISTORY + no calibrated probability) can only ever yield RESEARCH_WATCH.
 */
export function composeCeiling(i: CeilingInputs): CeilingResult {
  const reasons: string[] = [];
  let ceiling: ShortTermActionV2 = "ENTRY_CONFIRMED";
  const apply = (c: ShortTermActionV2, why: string) => {
    if (actionRank(c) < actionRank(ceiling)) {
      ceiling = c;
      reasons.unshift(why); // most-binding last-applied floats to front only if stricter
    } else if (actionRank(c) === actionRank(ceiling)) {
      reasons.push(why);
    }
  };

  apply(tierCeiling(i.tier), `evidence tier ${i.tier} caps at ${tierCeiling(i.tier)}`);

  if (i.modelHealthState === "SUSPENDED") apply("NO_TRADE", "short-term model SUSPENDED ⇒ no trade");
  else if (i.modelHealthState === "SHADOW")
    apply("WAIT_FOR_CONFIRMATION", "short-term model in SHADOW (live authority not yet earned) ⇒ cannot confirm entry");
  else if (i.modelHealthState === "DEGRADED")
    apply("WAIT_FOR_CONFIRMATION", "short-term model DEGRADED ⇒ cannot confirm entry");
  else if (i.modelHealthState === "INSUFFICIENT_HISTORY")
    apply("WAIT_FOR_CONFIRMATION", "model health INSUFFICIENT_HISTORY ⇒ cannot confirm entry");

  if (i.modelConfidence === "LOW") apply("WAIT_FOR_CONFIRMATION", "model confidence LOW ⇒ cannot confirm entry");

  if (i.freshness === "STALE") apply("NO_TRADE", "data STALE ⇒ no trade");
  else if (i.freshness === "DELAYED_INTRADAY") apply("WAIT_FOR_CONFIRMATION", "delayed intraday data ⇒ awaiting fresh confirmation");

  if (!i.evLowerBoundPositive) apply("WAIT_FOR_CONFIRMATION", "EV lower confidence bound not > 0 ⇒ edge unproven");

  if (!i.confirmationSatisfied) apply("WAIT_FOR_CONFIRMATION", "confirmation trigger not yet satisfied");

  if (!i.affordable) apply("RESEARCH_WATCH", "not affordable under the current risk budget");

  for (const c of i.contradictionCeilings) apply(c, "deterministic contradiction cap");

  return { ceiling, reasons };
}
