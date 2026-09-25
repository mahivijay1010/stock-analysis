/**
 * Lane C outcome grader (decision-grader-v1) — PURE.
 *
 * Grades a published DecisionSnapshot against what the market subsequently did.
 * A snapshot publishes a STANCE (decisionStatus) and CLAIMS (EV after costs,
 * p10/p90 return band at a horizon) — it publishes NO entry/stop/target
 * bracket, so this grader never invents one retroactively. It grades exactly
 * what was claimed, in two reference frames:
 *
 *  CLAIM frame   anchor close → terminal close. The published quantiles and EV
 *                were stated against the anchor close, so band coverage and EV
 *                error are graded here (gross — the claim already priced its
 *                own transaction costs into evAfterCostsPct).
 *  ACTION frame  NEXT session's OPEN → terminal close, net of the SAME cost
 *                model the claim used. Nobody can buy yesterday's close; a
 *                grader that assumes so flatters every result. Direction hits
 *                for BUY_CANDIDATE are graded here, after costs.
 *
 * Returns are computed on the ADJUSTED basis (per-bar adjClose/close factor)
 * so a split or dividend inside the window cannot masquerade as a move.
 *
 * Honesty flags instead of silent choices:
 *  - AMBIGUOUS_INTRABAR cannot occur here by construction (no intrabar
 *    ordering is needed to grade open→close over whole sessions); the
 *    analogous unobservables are ENTRY_UNAVAILABLE and TRUNCATED_HORIZON.
 *  - COST_MODEL_IMPUTED when the snapshot predates stored EV costs.
 *  - ENTRY_GAP when the actionable open differs from the anchor close by >1%.
 */

import { addCalendarDays, calendarDaysBetween } from "../forecast/dates";
import { estimateRoundTripFees } from "../framework/fees";
import { EV_NOTIONAL_INR, SLIPPAGE_PCT_PER_SIDE } from "./expectedValue";

export const DECISION_GRADER_VERSION = "decision-grader-v1";

/** Sessions after anchor with no bar at/after the horizon date AND a feed this
 *  stale ⇒ the series ended (delisting/suspension) — grade TRUNCATED. */
export const TRUNCATION_STALE_DAYS = 7;
/** Default claim horizon when a snapshot stored no EV report (pre-T1 rows). */
export const DEFAULT_HORIZON_DAYS = 30;

export type DecisionStance = "BUY_CANDIDATE" | "WAIT" | "AVOID_NEW_ENTRY" | "INSUFFICIENT_EVIDENCE";

export type OutcomeStatus =
  | "GRADED" //            full horizon observed
  | "TRUNCATED" //         series ended early — graded at the last bar, flagged
  | "ENTRY_UNAVAILABLE" // no session ever traded after the anchor
  | "DATA_INVALID" //      malformed bars inside the window — never scored
  | "PENDING"; //          horizon not reached and the feed is current — no row

export interface GraderBar {
  date: string; // YYYY-MM-DD ascending
  open: number;
  close: number;
  adjustedClose?: number | null;
}

/** What the snapshot actually claimed — extracted by the caller from the row. */
export interface SnapshotClaim {
  snapshotId: string;
  ticker: string;
  decisionStatus: DecisionStance;
  /** IST date of the bar the decision anchored on (snapshot as_of). */
  asOfDate: string;
  horizonDays: number;
  /** From the stored expectedValue report; null on pre-T1 snapshots. */
  evAfterCostsPct: number | null;
  p10RetPct: number | null; // expectedDownsidePct
  p90RetPct: number | null; // expectedUpsidePct
  transactionCostPct: number | null; // the claim's OWN cost model
}

export interface DecisionOutcome {
  snapshotId: string;
  ticker: string;
  decisionStatus: DecisionStance;
  asOfDate: string;
  horizonDays: number;
  graderVersion: string;
  outcomeStatus: OutcomeStatus;
  anchorDate: string | null;
  entryDate: string | null;
  terminalDate: string | null;
  sessionsObserved: number;
  /** CLAIM frame: anchor close → terminal close, adjusted, gross. */
  claimGrossReturnPct: number | null;
  /** ACTION frame: next-session open → terminal close, adjusted. */
  tradeableGrossReturnPct: number | null;
  tradeableNetReturnPct: number | null;
  costPct: number | null;
  entryGapPct: number | null;
  /** BUY: net > 0. AVOID: claim-frame gross ≤ 0 (no trade ⇒ no costs).
   *  WAIT / INSUFFICIENT_EVIDENCE: null — an abstention has no hit. */
  directionHit: boolean | null;
  withinBand80: boolean | null;
  /** tradeableNet − claimed evAfterCostsPct: how far reality landed from the claim. */
  evErrorPct: number | null;
  flags: string[];
}

const r4 = (x: number): number => Math.round(x * 10000) / 10000;

function adjClose(b: GraderBar): number {
  return b.adjustedClose != null && b.adjustedClose > 0 ? b.adjustedClose : b.close;
}
/** Adjusted open via the bar's own close-adjustment factor. */
function adjOpen(b: GraderBar): number {
  const f = b.adjustedClose != null && b.close > 0 ? b.adjustedClose / b.close : 1;
  return b.open * f;
}

export function gradeDecisionOutcome(claim: SnapshotClaim, bars: GraderBar[], todayIst: string): DecisionOutcome {
  const base: DecisionOutcome = {
    snapshotId: claim.snapshotId,
    ticker: claim.ticker,
    decisionStatus: claim.decisionStatus,
    asOfDate: claim.asOfDate,
    horizonDays: claim.horizonDays,
    graderVersion: DECISION_GRADER_VERSION,
    outcomeStatus: "PENDING",
    anchorDate: null,
    entryDate: null,
    terminalDate: null,
    sessionsObserved: 0,
    claimGrossReturnPct: null,
    tradeableGrossReturnPct: null,
    tradeableNetReturnPct: null,
    costPct: null,
    entryGapPct: null,
    directionHit: null,
    withinBand80: null,
    evErrorPct: null,
    flags: [],
  };
  if (bars.length === 0) return { ...base, outcomeStatus: "ENTRY_UNAVAILABLE", flags: ["NO_BARS_FOR_TICKER"] };

  // Anchor: the last bar at/before the decision date (history may be revised).
  let anchorIdx = -1;
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].date <= claim.asOfDate) {
      anchorIdx = i;
      break;
    }
  }
  if (anchorIdx < 0) return { ...base, outcomeStatus: "ENTRY_UNAVAILABLE", flags: ["ANCHOR_BEFORE_HISTORY"] };
  const flags: string[] = [];
  if (bars[anchorIdx].date !== claim.asOfDate) flags.push(`ANCHOR_SHIFTED_TO_${bars[anchorIdx].date}`);

  const feedStale = calendarDaysBetween(bars[bars.length - 1].date, todayIst) > TRUNCATION_STALE_DAYS;

  // Entry: the first session AFTER the anchor. If none ever traded and the
  // feed has clearly ended, the decision was never actionable.
  const entryIdx = anchorIdx + 1;
  if (entryIdx > bars.length - 1) {
    return feedStale
      ? { ...base, outcomeStatus: "ENTRY_UNAVAILABLE", anchorDate: bars[anchorIdx].date, flags: [...flags, "SERIES_ENDED_AT_ANCHOR"] }
      : { ...base, anchorDate: bars[anchorIdx].date, flags }; // PENDING — next session hasn't printed yet
  }

  // Terminal: first bar at/after anchor date + horizon (calendar days — the
  // claim's quantiles were stated at a calendar horizon).
  const horizonDate = addCalendarDays(bars[anchorIdx].date, claim.horizonDays);
  let terminalIdx = -1;
  for (let i = entryIdx; i < bars.length; i++) {
    if (bars[i].date >= horizonDate) {
      terminalIdx = i;
      break;
    }
  }
  let truncated = false;
  if (terminalIdx < 0) {
    if (!feedStale) return { ...base, anchorDate: bars[anchorIdx].date, flags }; // PENDING — horizon simply not reached yet
    terminalIdx = bars.length - 1; // series ended inside the window
    truncated = true;
    flags.push(`TRUNCATED_HORIZON_${calendarDaysBetween(bars[anchorIdx].date, bars[terminalIdx].date)}_OF_${claim.horizonDays}D`);
  }

  // Validate every bar the grade touches — refuse to score around a bad print.
  for (let i = anchorIdx; i <= terminalIdx; i++) {
    const b = bars[i];
    if (!(b.close > 0) || !(b.open > 0) || !Number.isFinite(b.close) || !Number.isFinite(b.open)) {
      return { ...base, outcomeStatus: "DATA_INVALID", anchorDate: bars[anchorIdx].date, sessionsObserved: i - anchorIdx, flags: [...flags, `MALFORMED_BAR_${b.date}`] };
    }
  }

  const anchorClose = adjClose(bars[anchorIdx]);
  const entryOpen = adjOpen(bars[entryIdx]);
  const terminalClose = adjClose(bars[terminalIdx]);

  // Surface a mid-window corporate action: the raw and adjusted frames
  // disagree materially somewhere inside the graded window.
  for (let i = anchorIdx; i <= terminalIdx; i++) {
    const b = bars[i];
    if (b.adjustedClose != null && b.close > 0 && Math.abs(b.adjustedClose / b.close - 1) > 0.005) {
      flags.push("ADJUSTED_BASIS_APPLIED");
      break;
    }
  }

  const claimGross = r4((terminalClose / anchorClose - 1) * 100);
  const tradeableGross = r4((terminalClose / entryOpen - 1) * 100);
  const entryGap = r4((entryOpen / anchorClose - 1) * 100);
  if (Math.abs(entryGap) > 1) flags.push(`ENTRY_GAP_${entryGap}PCT`);

  let costPct: number;
  if (claim.transactionCostPct != null && Number.isFinite(claim.transactionCostPct)) {
    costPct = claim.transactionCostPct;
  } else {
    costPct = r4(estimateRoundTripFees(EV_NOTIONAL_INR).roundTripPct + 2 * SLIPPAGE_PCT_PER_SIDE);
    flags.push("COST_MODEL_IMPUTED");
  }
  const tradeableNet = r4(tradeableGross - costPct);

  const directionHit =
    claim.decisionStatus === "BUY_CANDIDATE" ? tradeableNet > 0 : claim.decisionStatus === "AVOID_NEW_ENTRY" ? claimGross <= 0 : null;

  const withinBand80 =
    claim.p10RetPct != null && claim.p90RetPct != null ? claimGross >= claim.p10RetPct && claimGross <= claim.p90RetPct : null;

  const evErrorPct = claim.evAfterCostsPct != null ? r4(tradeableNet - claim.evAfterCostsPct) : null;

  return {
    ...base,
    outcomeStatus: truncated ? "TRUNCATED" : "GRADED",
    anchorDate: bars[anchorIdx].date,
    entryDate: bars[entryIdx].date,
    terminalDate: bars[terminalIdx].date,
    sessionsObserved: terminalIdx - anchorIdx,
    claimGrossReturnPct: claimGross,
    tradeableGrossReturnPct: tradeableGross,
    tradeableNetReturnPct: tradeableNet,
    costPct: r4(costPct),
    entryGapPct: entryGap,
    directionHit,
    withinBand80,
    evErrorPct,
    flags,
  };
}
