/**
 * Recommendation ranking for the wide screen — PURE.
 *
 * The screen answers "can I trade this?". This answers "of the ones I CAN
 * trade, which deserve attention first?" — and it must do so without
 * pretending to a skill the system has not demonstrated (every pre-registered
 * directional signal has failed; see docs/*-preregistration.md).
 *
 * So the ranking is explicitly a QUALITY-OF-OPPORTUNITY ranking, not an
 * expected-return ranking. Its inputs are things that ARE measured:
 *
 *   1. Setup evidence (tier + the pipeline's own rankingScoreV2, which
 *      already encodes EV-after-costs lower bound, expected R, CVaR,
 *      confirmation and slippage). A stock with no setup scores 0 here —
 *      it cannot be "recommended" as a trade, only as a watch item.
 *   2. Tradeability (liquidity + stability percentiles from the screen).
 *   3. Known-risk penalties from the knowledge base: negative material news,
 *      regulatory/legal exposure, governance gaps, dilution, corporate
 *      actions that distort the price history.
 *
 * Nothing here upgrades an action: a stock the pipeline called NO TRADE stays
 * NO TRADE. The ranking only orders what is already labelled, and every
 * component is returned so the number can be argued with.
 */

export const RECOMMENDATION_VERSION = "recommendation-v1";

export interface KnowledgeSignal {
  kind: string;
  sentiment?: string | null;
  materiality?: string | null;
}

export interface RecommendationInput {
  /** From the pipeline; null when no setup was detected. */
  rankingScoreV2: number | null;
  tier: "A" | "B" | "C" | "D" | null;
  action: string | null;
  /** Screen percentiles, 0..1. */
  liquidityPct: number | null;
  stabilityPct: number | null;
  corporateActionSuspect: boolean;
  facts: KnowledgeSignal[];
}

export interface RecommendationScore {
  /** 0..100-ish; comparable only within one run. */
  score: number;
  components: { setup: number; tradeability: number; knowledge: number };
  /** Human-readable reasons, strongest first. */
  reasons: string[];
  /** Risks that reduced the score. */
  cautions: string[];
}

const RISKY_KINDS = new Set(["REGULATORY", "LEGAL"]);

/** Knowledge-base penalty/credit, in score points. PURE. */
export function knowledgeAdjustment(facts: KnowledgeSignal[], corporateActionSuspect: boolean): { points: number; reasons: string[]; cautions: string[] } {
  const reasons: string[] = [];
  const cautions: string[] = [];
  let points = 0;

  const weight = (m?: string | null) => (m === "HIGH" ? 3 : m === "MEDIUM" ? 2 : 1);
  let negWeighted = 0;
  let posWeighted = 0;
  for (const f of facts) {
    const w = weight(f.materiality);
    if (f.sentiment === "NEGATIVE") negWeighted += w;
    if (f.sentiment === "POSITIVE") posWeighted += w;
    if (RISKY_KINDS.has(f.kind) && (f.materiality === "HIGH" || f.materiality === "MEDIUM")) {
      points -= 4;
      cautions.push(`${f.kind.toLowerCase()} exposure in the knowledge base`);
    }
  }
  if (negWeighted > 0) {
    points -= Math.min(10, negWeighted * 2);
    cautions.push(`${negWeighted} weighted units of negative news`);
  }
  if (posWeighted > negWeighted && posWeighted > 0) {
    // Positive news earns far less than negative news costs: an unproven
    // signal may flag risk, but must not manufacture conviction.
    points += Math.min(3, posWeighted);
    reasons.push("recent positive company news");
  }
  if (corporateActionSuspect) {
    points -= 5;
    cautions.push("a >25% one-day print in the window — bonus/split or shock distorts the history");
  }
  // Facts predating the automated pipeline carry no sentiment/materiality, so
  // they cannot be scored. Say so rather than letting "0 adjustment" read as
  // "nothing concerning found".
  const unscored = facts.filter((f) => !f.sentiment || !f.materiality).length;
  if (facts.length === 0) cautions.push("no researched facts yet — numbers only");
  else if (unscored === facts.length) cautions.push(`${unscored} researched fact${unscored === 1 ? "" : "s"} on file, none machine-scored — risk not assessed here, read them`);
  else if (unscored > 0) cautions.push(`${unscored} of ${facts.length} facts are not machine-scored`);
  return { points, reasons, cautions };
}

/** Combine pipeline evidence, tradeability and knowledge into one ordering. PURE. */
export function recommendationScore(i: RecommendationInput): RecommendationScore {
  const reasons: string[] = [];
  const cautions: string[] = [];

  // 1. Setup evidence. rankingScoreV2 is roughly -40..+80 in practice; clamp
  //    and rescale to 0..55 so no single component can dominate the board.
  const raw = i.rankingScoreV2;
  const hasSetup = raw != null && i.tier != null && i.tier !== "D";
  const setup = hasSetup ? Math.max(0, Math.min(55, ((raw! + 40) / 120) * 55)) : 0;
  if (hasSetup) {
    // A negative pipeline score means the plan exists but its economics are
    // poor; say that rather than listing the setup as a point in its favour.
    if ((raw ?? 0) < 0) cautions.push(`tier ${i.tier} setup exists but the pipeline scores its economics negative (${raw})`);
    else reasons.push(`tier ${i.tier} setup with a priced plan (pipeline score ${raw})`);
    if (i.action === "ENTRY_CONFIRMED") reasons.push("entry confirmed by the pipeline's own rules");
  } else {
    cautions.push("no qualifying setup — nothing to enter today");
  }

  // 2. Tradeability, 0..30.
  const liq = i.liquidityPct ?? 0;
  const stab = i.stabilityPct ?? 0;
  const tradeability = (liq * 0.5 + stab * 0.5) * 30;
  if (liq >= 0.8) reasons.push("among the most liquid stocks on the list");
  if (stab >= 0.8) reasons.push("shallower drawdowns and lower volatility than most of the list");
  if (liq < 0.3) cautions.push("thin relative to the rest of the list — costs bite harder");

  // 3. Knowledge, a penalty-dominant adjustment.
  const k = knowledgeAdjustment(i.facts, i.corporateActionSuspect);
  reasons.push(...k.reasons);
  cautions.push(...k.cautions);

  const score = Math.round((setup + tradeability + k.points) * 100) / 100;
  return { score, components: { setup: Math.round(setup * 100) / 100, tradeability: Math.round(tradeability * 100) / 100, knowledge: k.points }, reasons, cautions };
}

export interface RankedPick<T> {
  item: T;
  rank: number;
  recommendation: RecommendationScore;
}

/**
 * Order candidates and split them honestly. `tradeable` holds only stocks the
 * pipeline itself cleared for entry (BUY/WAIT); everything else is `watch`,
 * however high it scores — a good-quality company with no setup is not a trade.
 */
export function rankRecommendations<T>(
  items: T[],
  get: (t: T) => RecommendationInput & { decision: string }
): { tradeable: Array<RankedPick<T>>; watch: Array<RankedPick<T>> } {
  const scored = items.map((item) => {
    const input = get(item);
    return { item, decision: input.decision, recommendation: recommendationScore(input) };
  });
  scored.sort((a, b) => b.recommendation.score - a.recommendation.score);
  const tradeable: Array<RankedPick<T>> = [];
  const watch: Array<RankedPick<T>> = [];
  for (const s of scored) {
    const bucket = s.decision === "BUY" || s.decision === "WAIT" ? tradeable : watch;
    bucket.push({ item: s.item, rank: bucket.length + 1, recommendation: s.recommendation });
  }
  return { tradeable, watch };
}
