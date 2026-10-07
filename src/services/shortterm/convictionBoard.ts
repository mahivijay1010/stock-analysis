/**
 * Conviction Board (conviction-board-v1) — PURE.
 *
 * Ranks the sub-₹100 candidates into HIGH / MEDIUM / LOW *conviction* tiers.
 * Read this precisely: conviction here measures the STRENGTH OF EVIDENCE and
 * the QUALITY OF THE REWARD:RISK GEOMETRY — it is NOT a probability of profit
 * and NOT a promise. The system has no demonstrated stock-picking skill
 * (Evidence tab), so "HIGH conviction" means "the most complete, least-bad
 * setup available today", never "this will go up".
 *
 * The score is a transparent sum of evidence components, each of which is a
 * FACT the deterministic pipeline already computed:
 *   actionability (how far through the gate the setup is),
 *   reward:risk to the first target (pure geometry),
 *   EV after costs (positive is a necessary, not sufficient, condition),
 *   AI risk (the scout's cap-only action + red-flag count),
 *   tradeability/data quality.
 *
 * A separate, fail-closed BUY-GRADE bar flags the tiny set (often zero) that
 * clears every gate. Tiers are absolute bands, so an empty HIGH tier is a
 * truthful "nothing qualifies today", not a bucket we force-fill.
 */

export const CONVICTION_BOARD_VERSION = "conviction-board-v1";

/** Absolute score bands. HIGH is intentionally hard to reach. */
export const TIER_BANDS = { high: 55, medium: 30 } as const;
export const TOP_N_PER_TIER = 10;

export type ConvictionTier = "HIGH" | "MEDIUM" | "LOW";

export interface ConvictionInput {
  symbol: string;
  ticker: string;
  companyName: string | null;
  industry: string | null;
  price: number | null;
  setupType: string;
  action: string; // ShortTermCandidateView.action (ENTRY_CONFIRMED … NO_SETUP)
  tier: string; // evidence tier A/B/C/D
  gatesPassed: boolean;
  decision: string; // new-buyer decision (BUY/WAIT/WATCH/NO TRADE)
  rewardRiskToT1: number | null;
  evAfterCostsPct: number | null;
  dataQuality: number | null; // 0..100
  entry: number | null;
  stop: number | null;
  target1: number | null;
  /** AI scout (null when not yet scouted). */
  aiCapAction: "AFFIRM" | "CAP_TO_WATCH" | "CAP_TO_NO_TRADE" | null;
  aiConfidence: "LOW" | "MEDIUM" | "HIGH" | null;
  aiRedFlags: number;
}

export interface ConvictionComponents {
  actionability: number; // 0..35
  rewardRisk: number; // 0..25
  expectedValue: number; // 0..15
  aiRisk: number; // 0..15
  tradeability: number; // 0..10
}

export interface ScoredConviction {
  symbol: string;
  ticker: string;
  companyName: string | null;
  industry: string | null;
  price: number | null;
  setupType: string;
  decision: string;
  tier: ConvictionTier;
  score: number; // 0..100
  components: ConvictionComponents;
  rewardRiskToT1: number | null;
  evAfterCostsPct: number | null;
  entry: number | null;
  stop: number | null;
  target1: number | null;
  aiCapAction: ConvictionInput["aiCapAction"];
  aiRedFlags: number;
  /** Clears EVERY gate (fail-closed). Almost always false — by design. */
  buyGrade: boolean;
  /** Plain-language, honest bullets explaining the score and its limits. */
  reasons: string[];
}

export interface ConvictionBoard {
  version: string;
  generatedAt: string | null;
  /** The price ceiling the underlying scan used (₹). Null if unknown/legacy. */
  maxPrice: number | null;
  evaluated: number;
  buyGradeCount: number;
  tierCounts: { high: number; medium: number; low: number };
  high: ScoredConviction[];
  medium: ScoredConviction[];
  low: ScoredConviction[];
  caveat: string;
  headline: string;
}

const ACTION_POINTS: Record<string, number> = {
  ENTRY_CONFIRMED: 35,
  TIMING_OK: 32,
  ZONE_REACHED: 22,
  WAIT_FOR_CONFIRMATION: 20,
  RESEARCH_WATCH: 12,
  SETUP_DETECTED: 12,
  NO_SETUP: 0,
  EXIT: 0,
  INVALIDATED: 0,
  TAKE_PARTIAL: 0,
  TRAIL: 0,
};

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
const round1 = (x: number): number => Math.round(x * 10) / 10;

export function scoreConviction(c: ConvictionInput): ScoredConviction {
  const reasons: string[] = [];

  // Actionability — how far through the gate the setup is (evidence of a real,
  // confirmed opportunity, NOT of future return).
  const actionability = ACTION_POINTS[c.action] ?? 0;
  if (actionability === 0) reasons.push("No qualifying setup — nothing to enter.");
  else if (actionability >= 32) reasons.push(`Entry is confirmed (${c.action}).`);
  else if (actionability >= 20) reasons.push(`Setup present, entry not yet confirmed (${c.action}).`);
  else reasons.push(`Early-stage setup only (${c.action}, tier ${c.tier}).`);

  // Reward:risk geometry to the first target — a FACT about the plan, not odds.
  let rewardRisk = 0;
  const rr = c.rewardRiskToT1;
  if (rr != null && rr > 0) {
    rewardRisk = rr >= 2 ? 25 : rr >= 1.5 ? 19 : rr >= 1 ? 12 : rr >= 0.5 ? 5 : 2;
    if (rr < 1) reasons.push(`Poor reward:risk ${rr.toFixed(2)} — you risk more than the first target pays.`);
    else reasons.push(`Reward:risk to T1 is ${rr.toFixed(2)}.`);
  } else {
    reasons.push("No priced target — reward:risk cannot be computed.");
  }

  // EV after costs — a necessary (not sufficient) condition for any BUY.
  let expectedValue = 0;
  const ev = c.evAfterCostsPct;
  if (ev != null) {
    expectedValue = ev > 0.5 ? 15 : ev > 0 ? 8 : 0;
    if (ev <= 0) reasons.push(`Expected value after costs is ${ev.toFixed(2)}% — not positive.`);
  }

  // AI scout — cap-only risk read. Never adds conviction above AFFIRM.
  let aiRisk = 5; // neutral when not yet scouted
  if (c.aiCapAction === "AFFIRM") aiRisk = 15;
  else if (c.aiCapAction === "CAP_TO_WATCH") aiRisk = 8;
  else if (c.aiCapAction === "CAP_TO_NO_TRADE") {
    aiRisk = 0;
    reasons.push("AI risk scout capped this to NO TRADE.");
  }
  if (c.aiRedFlags > 3) {
    aiRisk = clamp(aiRisk - (c.aiRedFlags - 3), 0, 15);
    reasons.push(`AI flagged ${c.aiRedFlags} risks.`);
  }

  // Tradeability / data quality — can you actually trade it at the modelled cost.
  const tradeability = clamp(((c.dataQuality ?? 0) / 100) * 10, 0, 10);

  const components: ConvictionComponents = { actionability, rewardRisk, expectedValue, aiRisk, tradeability };
  const score = round1(actionability + rewardRisk + expectedValue + aiRisk + tradeability);

  const tier: ConvictionTier = score >= TIER_BANDS.high ? "HIGH" : score >= TIER_BANDS.medium ? "MEDIUM" : "LOW";

  // BUY-GRADE: the fail-closed absolute bar. Everything must align.
  const buyGrade =
    c.gatesPassed &&
    (c.action === "ENTRY_CONFIRMED" || c.action === "TIMING_OK") &&
    rr != null &&
    rr >= 1.5 &&
    ev != null &&
    ev > 0 &&
    c.aiCapAction !== "CAP_TO_NO_TRADE";
  if (buyGrade) reasons.unshift("Clears every gate: confirmed entry, reward:risk ≥ 1.5, positive EV, AI not capping.");

  return {
    symbol: c.symbol,
    ticker: c.ticker,
    companyName: c.companyName,
    industry: c.industry,
    price: c.price,
    setupType: c.setupType,
    decision: c.decision,
    tier,
    score,
    components,
    rewardRiskToT1: rr,
    evAfterCostsPct: ev,
    entry: c.entry,
    stop: c.stop,
    target1: c.target1,
    aiCapAction: c.aiCapAction,
    aiRedFlags: c.aiRedFlags,
    buyGrade,
    reasons,
  };
}

/** Multi-key sort: score desc, then reward:risk desc, then −red-flags. */
function compareConviction(a: ScoredConviction, b: ScoredConviction): number {
  if (b.score !== a.score) return b.score - a.score;
  const arr = a.rewardRiskToT1 ?? -1;
  const brr = b.rewardRiskToT1 ?? -1;
  if (brr !== arr) return brr - arr;
  return a.aiRedFlags - b.aiRedFlags;
}

export function buildConvictionBoard(inputs: ConvictionInput[], generatedAt: string | null, maxPrice: number | null = null): ConvictionBoard {
  const scored = inputs.map(scoreConviction).sort(compareConviction);
  const high = scored.filter((s) => s.tier === "HIGH");
  const medium = scored.filter((s) => s.tier === "MEDIUM");
  const low = scored.filter((s) => s.tier === "LOW");
  const buyGradeCount = scored.filter((s) => s.buyGrade).length;

  const caveat =
    "Conviction = strength of evidence + reward:risk geometry, NOT a probability of profit. This system has no demonstrated " +
    "stock-picking skill (Evidence tab). A HIGH tier means the most complete setup available today; it is not a guarantee. " +
    "The ₹ figures on each setup are scenarios after costs, not forecasts. 'BUY-grade' is the fail-closed bar every gate must clear.";

  const headline =
    buyGradeCount > 0
      ? `${buyGradeCount} stock${buyGradeCount === 1 ? "" : "s"} clear the full BUY-grade bar today; ${high.length} in the HIGH-conviction band.`
      : high.length > 0
        ? `0 stocks clear the full BUY-grade bar today. ${high.length} reached the HIGH-conviction band on evidence, but none is a confirmed buy — treat as a shortlist to watch, not to buy.`
        : `0 stocks clear the BUY-grade bar and none reached HIGH conviction today. The honest read: there is no strong sub-₹100 setup right now — the best protection is not trading.`;

  return {
    version: CONVICTION_BOARD_VERSION,
    generatedAt,
    maxPrice,
    evaluated: scored.length,
    buyGradeCount,
    tierCounts: { high: high.length, medium: medium.length, low: low.length },
    high: high.slice(0, TOP_N_PER_TIER),
    medium: medium.slice(0, TOP_N_PER_TIER),
    low: low.slice(0, TOP_N_PER_TIER),
    caveat,
    headline,
  };
}
