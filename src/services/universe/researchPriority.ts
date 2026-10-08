/**
 * Pure research-priority scoring. Deep research is selective: the queue is
 * ordered by observable triggers (unusual volume, momentum, breakout, pullback,
 * major news, results, corporate action, gap, watchlist, regime relevance,
 * similarity to setups that have evidence). A priority is a work-ordering
 * number, never a prediction.
 */

export interface PriorityInput {
  symbol: string;
  signals: string[];
  technicalScore: number | null;
  liquidityTier: string;
  stageReached: string;
  newsFacts30d: number;
  majorNews: boolean;
  resultsDue: boolean;
  corporateAction: boolean;
  onWatchlist: boolean;
  regime: string | null;
  setupType: string | null;
  setupHasEvidence: boolean; // the setup type has tier ≥ B evidence in the study
  lastResearchedDaysAgo: number | null;
}

export interface PriorityResult {
  symbol: string;
  priority: number;
  reasons: string[];
}

export const PRIORITY_WEIGHTS = {
  UNUSUAL_VOLUME: 18,
  BREAKOUT: 15,
  PULLBACK: 12,
  MOMENTUM: 10,
  GAP: 8,
  MEAN_REVERSION: 6,
  NEAR_52W_HIGH: 4,
  HIGH_DELIVERY: 3,
  majorNews: 15,
  newsPerFact: 2,
  resultsDue: 12,
  corporateAction: 8,
  watchlist: 20,
  stageSetupEngine: 10,
  stageDecisionGates: 15,
  setupEvidence: 8,
  tierA: 5,
  regimeFit: 6,
  staleResearchPerWeek: 2,
} as const;

export function researchPriority(i: PriorityInput): PriorityResult {
  const reasons: string[] = [];
  let p = 0;
  for (const s of i.signals) {
    const w = (PRIORITY_WEIGHTS as Record<string, number>)[s];
    if (w) {
      p += w;
      reasons.push(s.toLowerCase().replace(/_/g, " "));
    }
  }
  if (i.technicalScore != null) p += Math.min(10, i.technicalScore / 10);
  if (i.majorNews) {
    p += PRIORITY_WEIGHTS.majorNews;
    reasons.push("major news");
  }
  if (i.newsFacts30d > 0) p += Math.min(10, i.newsFacts30d * PRIORITY_WEIGHTS.newsPerFact);
  if (i.resultsDue) {
    p += PRIORITY_WEIGHTS.resultsDue;
    reasons.push("results / earnings event");
  }
  if (i.corporateAction) {
    p += PRIORITY_WEIGHTS.corporateAction;
    reasons.push("corporate action");
  }
  if (i.onWatchlist) {
    p += PRIORITY_WEIGHTS.watchlist;
    reasons.push("on watchlist");
  }
  if (i.stageReached === "SETUP_ENGINE" || i.stageReached === "DECISION_GATES") p += PRIORITY_WEIGHTS.stageSetupEngine;
  if (["RISK", "MODEL_HEALTH", "MONEY_DESK"].includes(i.stageReached)) {
    p += PRIORITY_WEIGHTS.stageDecisionGates;
    reasons.push("passed decision gates");
  }
  if (i.setupHasEvidence) {
    p += PRIORITY_WEIGHTS.setupEvidence;
    reasons.push("setup type has study evidence");
  }
  if (i.liquidityTier === "A") p += PRIORITY_WEIGHTS.tierA;
  const regimeFit =
    (i.regime === "TREND_UP" && (i.setupType === "PULLBACK_IN_UPTREND" || i.setupType === "BREAKOUT_CONFIRMATION" || i.setupType === "MOMENTUM_CONTINUATION")) ||
    ((i.regime === "CHOPPY" || i.regime === "TREND_DOWN") && i.setupType === "MEAN_REVERSION");
  if (regimeFit) {
    p += PRIORITY_WEIGHTS.regimeFit;
    reasons.push("setup fits the regime");
  }
  if (i.lastResearchedDaysAgo != null) p += Math.min(8, (i.lastResearchedDaysAgo / 7) * PRIORITY_WEIGHTS.staleResearchPerWeek);
  else p += 4;
  return { symbol: i.symbol, priority: Math.round(p * 100) / 100, reasons: reasons.slice(0, 6) };
}
