/**
 * Sub-₹100 wide-universe ledger core (wide-ledger-v1) — PURE.
 *
 * The wide sub-₹100 scan is deliberately kept OUT of the radar's shadow
 * evidence base (wideScan.ts runs shadow:false) so penny-stock outcomes can
 * never contaminate the 152-universe radar's live-authority stats. But "find
 * cheap stocks that give high returns" is an empty claim until the picks are
 * logged prospectively and graded — so the sub-₹100 lane gets its OWN ledger
 * (wide_shadow_predictions) and its OWN track record, held to the same
 * sample-size honesty as every other lane.
 *
 * This module is the pure heart of that lane:
 *  - selectPicksToLog:   which scan rows are GRADEABLE (real plan geometry).
 *  - summarizeScreenEvidence: the exact, citable evidence the AI scout may see
 *                        (quantitative only — no fabricated news).
 *  - applyAiCap:         the cap-only contract. The AI can only move a decision
 *                        DOWN the aggressiveness ladder, never up. Structurally
 *                        impossible for the model to manufacture a BUY.
 *  - aggregateWideTrackRecord: deduped per ticker-day, cohorted by decision,
 *                        Wilson-bounded, withheld below the sample-size floor.
 */

import { wilsonLb95 } from "../evidence/selectivity";

export const WIDE_LEDGER_VERSION = "wide-ledger-v1";
/** No cohort rate is reported below this many graded outcomes (noise floor). */
export const MIN_GRADED_FOR_WIDE_RATE = 10;

export type WideDecision = "BUY" | "WAIT" | "WATCH" | "NO TRADE";

/** Aggressiveness ladder — index is strictly increasing in how much the call
 *  commits you. The AI cap selects the LESS aggressive of (deterministic, cap). */
export const DECISION_LADDER: WideDecision[] = ["NO TRADE", "WATCH", "WAIT", "BUY"];

/** The scout's only levers. AFFIRM keeps the deterministic call; the other two
 *  can ONLY reduce it. There is deliberately no "BUY" the model can emit. */
export type AiCapAction = "AFFIRM" | "CAP_TO_WATCH" | "CAP_TO_NO_TRADE";

/**
 * Cap-only: the final decision is never MORE aggressive than the deterministic
 * one. AFFIRM passes it through; CAP_TO_WATCH floors it at WATCH; CAP_TO_NO_TRADE
 * forces NO TRADE. A cap that would RAISE the decision is ignored (returns the
 * deterministic value) — the model cannot upgrade, by construction.
 */
export function applyAiCap(deterministic: WideDecision, cap: AiCapAction): WideDecision {
  const detIdx = DECISION_LADDER.indexOf(deterministic);
  if (cap === "AFFIRM") return deterministic;
  const ceiling: WideDecision = cap === "CAP_TO_NO_TRADE" ? "NO TRADE" : "WATCH";
  const capIdx = DECISION_LADDER.indexOf(ceiling);
  // The LESS aggressive (lower index) of the two always wins.
  return DECISION_LADDER[Math.min(detIdx, capIdx)];
}

/** Compact, citable evidence summary from one wide-screen row. Quantitative
 *  ONLY — this is everything the scout is allowed to reason over, so it can
 *  never invent a catalyst it was not handed. */
export interface WideScreenEvidence {
  symbol: string;
  companyName: string | null;
  industry: string | null;
  price: number;
  medianTurnoverCr20: number | null;
  medianTrades20: number | null;
  avgDelivPct60: number | null;
  delivTrendPp: number | null;
  ret20Pct: number | null;
  ret60Pct: number | null;
  ret250Pct: number | null;
  vol60AnnPct: number | null;
  maxDrawdown1yPct: number | null;
  pctFrom1yHigh: number | null;
  indices: string[];
  surveillanceCodes: string[];
  corporateActionSuspect: boolean;
}

/** Shape of a scan row this module consumes (structurally typed to avoid an
 *  import cycle with wideScan). */
export interface LoggablePlan {
  initialStop?: number | null;
  target1?: number | null;
  entryType?: string | null;
  entryZoneLow?: number | null;
  entryZoneHigh?: number | null;
  entryTriggerPrice?: number | null;
  transactionCostPct?: number | null;
  estimatedSlippagePct?: number | null;
}
export interface LoggableRow {
  symbol: string;
  ticker: string;
  evaluation: {
    setupType?: string;
    freshness?: { lastUpdate?: string | null };
    plan?: LoggablePlan | null;
    gates?: { passed?: boolean } | null;
  } | null;
  decision: { newBuyer: WideDecision };
  screen?: Partial<WideScreenEvidence> | null;
}

export interface SelectedPick {
  symbol: string;
  ticker: string;
  setupType: string;
  anchorDate: string;
  decision: WideDecision;
  gatesPassed: boolean;
  plan: LoggablePlan;
  screen: Partial<WideScreenEvidence> | null;
}

export interface SelectionResult {
  picks: SelectedPick[];
  /** Rows seen but NOT logged, with the reason — never a silent truncation. */
  skipped: { ungradeable: number; noEvaluation: number };
}

/**
 * A row is GRADEABLE — and therefore loggable — only if it carries real plan
 * geometry (stop AND target1): the bracket simulator needs both to produce an
 * outcome. Rows without a plan are counted as skipped, never dropped silently.
 * Every decision cohort (BUY/WAIT/WATCH) is logged so each can be measured
 * separately; NO-TRADE rows with no plan are simply not trades to grade.
 */
export function selectPicksToLog(rows: LoggableRow[], fallbackAnchor: string): SelectionResult {
  const picks: SelectedPick[] = [];
  let ungradeable = 0;
  let noEvaluation = 0;
  for (const r of rows) {
    const v = r.evaluation;
    if (!v) {
      noEvaluation++;
      continue;
    }
    const plan = v.plan ?? null;
    if (!plan || plan.initialStop == null || plan.target1 == null) {
      ungradeable++;
      continue;
    }
    picks.push({
      symbol: r.symbol,
      ticker: r.ticker,
      setupType: v.setupType ?? "NONE",
      anchorDate: v.freshness?.lastUpdate?.slice(0, 10) ?? fallbackAnchor,
      decision: r.decision.newBuyer,
      gatesPassed: v.gates?.passed === true,
      plan,
      screen: r.screen ?? null,
    });
  }
  return { picks, skipped: { ungradeable, noEvaluation } };
}

// ── Track record ────────────────────────────────────────────────────────────

export interface WideOutcomeRow {
  decision: WideDecision;
  outcomeStatus: string; // from simulateBracket: TARGET_FIRST | STOP_FIRST | TIMEOUT | NEVER_ENTERED | AMBIGUOUS_INTRABAR | DATA_INVALID
  filled: boolean;
  realizedNetR: number | null; // OBSERVED only — null when unobservable
  returnPct: number | null;
}

export interface WideCohort {
  decision: WideDecision;
  logged: number;
  filled: number;
  neverEntered: number;
  ambiguous: number;
  /** Observed realized expectancy in R — withheld (null) below the floor. */
  expectancyR: number | null;
  /** Share of FILLED trades whose target was hit first — withheld below floor. */
  targetFirstRate: { hits: number; n: number; pct: number; wilsonLb95Pct: number } | null;
  withheldReason: string | null;
  meanReturnPct: number | null;
}

export interface WideTrackRecord {
  version: string;
  cohorts: WideCohort[];
  totals: { logged: number; resolved: number; pending: number };
  method: string[];
  headline: string;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Aggregate graded wide picks into per-decision cohorts, honestly. Rows must
 *  already be DEDUPED by the caller (latest pick per ticker-day). PURE. */
export function aggregateWideTrackRecord(rows: WideOutcomeRow[], totals: { logged: number; resolved: number; pending: number }): WideTrackRecord {
  const cohorts: WideCohort[] = [];
  for (const decision of DECISION_LADDER.slice().reverse()) {
    const cohort = rows.filter((r) => r.decision === decision);
    if (cohort.length === 0) continue;
    const filled = cohort.filter((r) => r.filled);
    const neverEntered = cohort.filter((r) => r.outcomeStatus === "NEVER_ENTERED").length;
    const ambiguous = cohort.filter((r) => r.outcomeStatus === "AMBIGUOUS_INTRABAR").length;
    // Observed-only: ambiguous (unobservable ordering) is EXCLUDED from realized stats.
    const observed = filled.filter((r) => r.realizedNetR != null);
    const rs = observed.map((r) => r.realizedNetR as number);
    const rets = observed.map((r) => r.returnPct).filter((v): v is number => v != null);
    const targetFirst = observed.filter((r) => r.outcomeStatus === "TARGET_FIRST").length;

    const enough = observed.length >= MIN_GRADED_FOR_WIDE_RATE;
    const wilson = enough ? wilsonLb95(targetFirst, observed.length) : null;
    cohorts.push({
      decision,
      logged: cohort.length,
      filled: filled.length,
      neverEntered,
      ambiguous,
      expectancyR: enough ? round2(rs.reduce((a, b) => a + b, 0) / rs.length) : null,
      targetFirstRate:
        wilson != null
          ? { hits: targetFirst, n: observed.length, pct: round2((targetFirst / observed.length) * 100), wilsonLb95Pct: round2(wilson * 100) }
          : null,
      withheldReason: enough ? null : `withheld — ${observed.length} observed outcome${observed.length === 1 ? "" : "s"} < ${MIN_GRADED_FOR_WIDE_RATE} minimum`,
      meanReturnPct: enough && rets.length ? round2(rets.reduce((a, b) => a + b, 0) / rets.length) : null,
    });
  }

  const buy = cohorts.find((c) => c.decision === "BUY");
  const headline =
    totals.resolved === 0
      ? `The sub-₹100 lane has logged ${totals.logged} picks but ZERO have matured yet — no track record exists. Nothing here says any cheap stock will rise.`
      : buy?.targetFirstRate
        ? `Sub-₹100 BUY picks hit target-first ${buy.targetFirstRate.pct}% of the time (Wilson 95% lower bound ${buy.targetFirstRate.wilsonLb95Pct}%, n=${buy.targetFirstRate.n}, observed fills only).`
        : `${totals.resolved} sub-₹100 picks resolved, but the BUY cohort is below the ${MIN_GRADED_FOR_WIDE_RATE}-outcome floor — its rate is withheld, not hidden: it does not exist yet.`;

  return {
    version: WIDE_LEDGER_VERSION,
    cohorts,
    totals,
    method: [
      "Each pick is logged prospectively the day it is produced; outcomes are graded later by the same bracket simulator as every other lane.",
      "Entry requires a FILL within the window; NEVER_ENTERED plans are not trades and are excluded from rates.",
      "Realized R is OBSERVED only — same-bar stop/target straddles (AMBIGUOUS_INTRABAR) are counted but excluded from expectancy.",
      `Rates require ≥${MIN_GRADED_FOR_WIDE_RATE} observed outcomes and carry a Wilson 95% lower bound.`,
      "Cohorts are split by the decision as-published (BUY/WAIT/WATCH) so each is measured on its own.",
      "This lane is isolated from the radar's evidence base — penny-stock outcomes never gate the 152-universe models.",
    ],
    headline,
  };
}
