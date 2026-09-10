/**
 * OpportunityRanker (reviewer #16) — "find the best opportunities" done
 * honestly. Two deliberate rules:
 *
 *  1. NO revived conviction score. We rank on several INDEPENDENT fields via a
 *     deterministic lexicographic comparator (expected-R lower bound, then
 *     expected R, then relative strength, then entry quality, then −risk), not
 *     a single weighted headline number. Components stay separate and visible.
 *  2. Rank by expected R (risk-adjusted), NOT max upside %, and the ranking
 *     NEVER overrides the gate: only gate === BUY_CANDIDATE is actionable; a
 *     stale/insufficient stock cannot be promoted by a high score.
 *
 * Two lists (reviewer's interesting≠actionable): OpportunityRank (anything that
 * clears MINIMUM safety and is worth watching) and ActionableRank (only the
 * subset that clears the deterministic gate).
 */

import { LiveStockContext } from "./types";

export interface RankedRow {
  rank: number;
  securityId: string;
  ticker: string;
  expectedR: number | null;
  expectedRLowerBound: number | null;
  setupState: string;
  entryQuality: LiveStockContext["entryQuality"];
  riskState: LiveStockContext["riskState"];
  relativeStrengthPercentile: number | null;
  liveAssessment: LiveStockContext["liveAssessment"];
  gate: LiveStockContext["gate"];
}

export interface OpportunityRanking {
  /** Interesting: minimum-safe and worth watching, best-first. */
  opportunity: RankedRow[];
  /** Actionable: the subset that clears the deterministic gate. */
  actionable: RankedRow[];
  /** Excluded from both, with the reason (audit-friendly, never silent). */
  excluded: Array<{ securityId: string; reason: string }>;
}

const ENTRY_RANK: Record<LiveStockContext["entryQuality"], number> = { HIGH: 3, MEDIUM: 2, LOW: 1, NONE: 0 };
const RISK_RANK: Record<LiveStockContext["riskState"], number> = { NORMAL: 0, ELEVATED: 1, HIGH: 2 };

/** −1 if a ranks BEFORE b (a is the better opportunity). Deterministic; ties
 *  break on securityId so the order is stable across runs. */
function compare(a: LiveStockContext, b: LiveStockContext): number {
  const byLcb = numDesc(a.expectedRLowerBound, b.expectedRLowerBound);
  if (byLcb !== 0) return byLcb;
  const byEr = numDesc(a.expectedR, b.expectedR);
  if (byEr !== 0) return byEr;
  const byRs = numDesc(a.relativeStrength.marketPercentile, b.relativeStrength.marketPercentile);
  if (byRs !== 0) return byRs;
  const byEntry = ENTRY_RANK[b.entryQuality] - ENTRY_RANK[a.entryQuality];
  if (byEntry !== 0) return byEntry;
  const byRisk = RISK_RANK[a.riskState] - RISK_RANK[b.riskState]; // lower risk first
  if (byRisk !== 0) return byRisk;
  return a.securityId < b.securityId ? -1 : a.securityId > b.securityId ? 1 : 0;
}

/** Descending by numeric value; nulls sort last. */
function numDesc(a: number | null, b: number | null): number {
  const av = a != null && Number.isFinite(a) ? a : -Infinity;
  const bv = b != null && Number.isFinite(b) ? b : -Infinity;
  return bv - av;
}

function toRow(c: LiveStockContext, rank: number): RankedRow {
  return {
    rank,
    securityId: c.securityId,
    ticker: c.ticker,
    expectedR: c.expectedR,
    expectedRLowerBound: c.expectedRLowerBound,
    setupState: c.setupState,
    entryQuality: c.entryQuality,
    riskState: c.riskState,
    relativeStrengthPercentile: c.relativeStrength.marketPercentile,
    liveAssessment: c.liveAssessment,
    gate: c.gate,
  };
}

export function rankOpportunities(contexts: LiveStockContext[]): OpportunityRanking {
  const excluded: Array<{ securityId: string; reason: string }> = [];
  const eligible: LiveStockContext[] = [];
  for (const c of contexts) {
    // MINIMUM safety: never rank a stock we can't trust or that the gate has
    // already ruled out. This is a hard filter — rank cannot resurrect it.
    if (c.dataQuality === "UNAVAILABLE") { excluded.push({ securityId: c.securityId, reason: "data unavailable" }); continue; }
    if (c.gate === "INSUFFICIENT_EVIDENCE") { excluded.push({ securityId: c.securityId, reason: "insufficient evidence" }); continue; }
    if (c.gate === "AVOID_NEW_ENTRY") { excluded.push({ securityId: c.securityId, reason: "gate: avoid new entry" }); continue; }
    eligible.push(c);
  }
  const sorted = eligible.slice().sort(compare);
  const opportunity = sorted.map((c, i) => toRow(c, i + 1));
  // Actionable = ONLY those clearing the deterministic gate. Same order.
  const actionable = sorted.filter((c) => c.gate === "BUY_CANDIDATE").map((c, i) => toRow(c, i + 1));
  return { opportunity, actionable, excluded };
}
