/**
 * Gap policy + PreEntryRevalidationService (Parts 12/13).
 *
 * A plan computed after yesterday's close must NOT blindly trigger today. The
 * gap policy classifies the next-session opening/current price against the
 * plan using ATR-scaled thresholds, and revalidation re-checks freshness,
 * events, regime, zone/stop validity and EV before any entry. The system
 * never chases a stock just because it once printed an entry zone.
 */

export type GapDecision = "PROCEED" | "WAIT" | "RECOMPUTE" | "DO_NOT_CHASE" | "INVALIDATED";

/** ATR-scaled thresholds (documented in docs/short-term-gap-policy.md). */
export const GAP_THRESHOLDS = {
  belowZoneAtr: 0.5, // gap this far below the zone low ⇒ recompute
  aboveZoneAtr: 0.35, // gap this far above the zone high ⇒ do not chase
  nearTargetFracToT1: 0.7, // opened ≥70% of the way to T1 ⇒ invalidated as a NEW entry
} as const;

export interface GapAssessment {
  decision: GapDecision;
  reason: string;
  gapAtr: number | null;
}

export function assessGap(opts: {
  referencePrice: number; // current/opening price at revalidation
  entryZoneLow: number | null;
  entryZoneHigh: number | null;
  initialStop: number | null;
  target1: number | null;
  atr14: number | null;
  entryType: string;
}): GapAssessment {
  const { referencePrice: px, entryZoneLow: lo, entryZoneHigh: hi, initialStop: stop, target1, atr14: atr } = opts;
  if (atr == null || !(atr > 0)) return { decision: "WAIT", reason: "ATR unavailable — cannot size the gap", gapAtr: null };

  if (stop != null && px <= stop) return { decision: "INVALIDATED", reason: `price ₹${px} gapped at/through the stop ₹${stop}`, gapAtr: (px - stop) / atr };

  if (target1 != null && lo != null) {
    const distToT1 = target1 - lo;
    if (distToT1 > 0 && px - lo >= GAP_THRESHOLDS.nearTargetFracToT1 * distToT1)
      return { decision: "INVALIDATED", reason: `price ₹${px} opened most of the way to T1 — the reward is gone as a new entry`, gapAtr: (px - lo) / atr };
  }

  if (opts.entryType === "BREAKOUT_TRIGGER") {
    // For breakouts the trigger price is the reference; below it we simply wait.
    if (hi != null && px < hi) return { decision: "WAIT", reason: "below the breakout trigger — awaiting a confirmed close above it", gapAtr: (px - hi) / atr };
    return { decision: "PROCEED", reason: "trading above the breakout trigger", gapAtr: (px - (hi ?? px)) / atr };
  }

  if (lo != null && hi != null) {
    if (px >= lo && px <= hi) return { decision: "PROCEED", reason: "price is inside the entry zone", gapAtr: 0 };
    if (px < lo) {
      const gap = (lo - px) / atr;
      return gap >= GAP_THRESHOLDS.belowZoneAtr
        ? { decision: "RECOMPUTE", reason: `price gapped ${gap.toFixed(2)} ATR below the zone — recompute the plan`, gapAtr: -gap }
        : { decision: "WAIT", reason: "just below the zone — wait for it to trade back into range", gapAtr: -gap };
    }
    const gapUp = (px - hi) / atr;
    return gapUp >= GAP_THRESHOLDS.aboveZoneAtr
      ? { decision: "DO_NOT_CHASE", reason: `price gapped ${gapUp.toFixed(2)} ATR above the zone — do not chase`, gapAtr: gapUp }
      : { decision: "WAIT", reason: "just above the zone — wait for a pullback into range", gapAtr: gapUp };
  }
  return { decision: "WAIT", reason: "no valid entry zone to evaluate the gap against", gapAtr: null };
}

export interface RevalidationResult {
  ok: boolean;
  gap: GapAssessment;
  vetoes: string[];
}

/**
 * Pre-entry revalidation (Part 12): PURE — the caller supplies fresh state.
 * Returns ok=true only when the gap policy says PROCEED and no veto fires.
 */
export function revalidate(opts: {
  gap: GapAssessment;
  freshEnough: boolean;
  newAdverseEvent: boolean;
  marketRegimeOk: boolean;
  riskAllowed: boolean;
  evLowerBoundPositive: boolean;
}): RevalidationResult {
  const vetoes: string[] = [];
  if (!opts.freshEnough) vetoes.push("data not fresh enough to enter");
  if (opts.newAdverseEvent) vetoes.push("adverse material event since the scan");
  if (!opts.marketRegimeOk) vetoes.push("market regime deteriorated");
  if (!opts.riskAllowed) vetoes.push("portfolio risk limit blocks new entries");
  if (!opts.evLowerBoundPositive) vetoes.push("EV lower bound no longer positive");
  if (opts.gap.decision !== "PROCEED") vetoes.push(`gap policy: ${opts.gap.decision.toLowerCase()} (${opts.gap.reason})`);
  return { ok: vetoes.length === 0, gap: opts.gap, vetoes };
}
