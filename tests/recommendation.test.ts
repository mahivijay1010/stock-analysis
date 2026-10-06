/**
 * Recommendation ranking, pinned. The failure this guards against: a
 * high-quality, liquid, well-reported company with NO tradeable setup being
 * presented above a stock the pipeline actually cleared — i.e. the ranking
 * quietly becoming a buy list.
 */
import { knowledgeAdjustment, rankRecommendations, recommendationScore, RecommendationInput } from "../src/services/shortterm/recommendation";

const base: RecommendationInput = {
  rankingScoreV2: null,
  tier: null,
  action: "NO_SETUP",
  liquidityPct: 0.5,
  stabilityPct: 0.5,
  corporateActionSuspect: false,
  facts: [],
};

describe("recommendationScore", () => {
  it("gives no setup credit when there is no setup, however liquid and stable", () => {
    const r = recommendationScore({ ...base, liquidityPct: 1, stabilityPct: 1 });
    expect(r.components.setup).toBe(0);
    expect(r.cautions).toContain("no qualifying setup — nothing to enter today");
  });

  it("rewards a validated, confirmed setup above an unproven one", () => {
    const a = recommendationScore({ ...base, rankingScoreV2: 60, tier: "A", action: "ENTRY_CONFIRMED" });
    const c = recommendationScore({ ...base, rankingScoreV2: 10, tier: "C", action: "RESEARCH_WATCH" });
    expect(a.components.setup).toBeGreaterThan(c.components.setup);
    expect(a.reasons.some((x) => /entry confirmed/.test(x))).toBe(true);
  });

  it("tier D is treated as no setup", () => {
    expect(recommendationScore({ ...base, rankingScoreV2: 50, tier: "D" }).components.setup).toBe(0);
  });

  it("penalises negative news more than it credits positive news", () => {
    const neg = knowledgeAdjustment([{ kind: "RESULTS", sentiment: "NEGATIVE", materiality: "HIGH" }], false);
    const pos = knowledgeAdjustment([{ kind: "RESULTS", sentiment: "POSITIVE", materiality: "HIGH" }], false);
    expect(neg.points).toBeLessThan(0);
    expect(pos.points).toBeGreaterThan(0);
    expect(Math.abs(neg.points)).toBeGreaterThan(Math.abs(pos.points));
  });

  it("flags regulatory/legal exposure and distorted price history as cautions", () => {
    const k = knowledgeAdjustment([{ kind: "REGULATORY", sentiment: "NEUTRAL", materiality: "HIGH" }], true);
    expect(k.points).toBeLessThan(0);
    expect(k.cautions.join(" ")).toMatch(/regulatory/);
    expect(k.cautions.join(" ")).toMatch(/one-day print/);
  });

  it("notes when a stock has no researched facts rather than scoring it as clean", () => {
    expect(knowledgeAdjustment([], false).cautions).toContain("no researched facts yet — numbers only");
  });
});

describe("rankRecommendations", () => {
  it("never lets a no-setup stock outrank a tradeable one, however high it scores", () => {
    const items = [
      { id: "perfect-but-no-setup", decision: "NO TRADE", input: { ...base, liquidityPct: 1, stabilityPct: 1, facts: [{ kind: "RESULTS", sentiment: "POSITIVE", materiality: "HIGH" }] } },
      { id: "modest-but-tradeable", decision: "WAIT", input: { ...base, rankingScoreV2: 5, tier: "C" as const, liquidityPct: 0.2, stabilityPct: 0.2 } },
    ];
    const { tradeable, watch } = rankRecommendations(items, (i) => ({ ...i.input, decision: i.decision }));
    expect(tradeable.map((t) => t.item.id)).toEqual(["modest-but-tradeable"]);
    expect(watch.map((w) => w.item.id)).toEqual(["perfect-but-no-setup"]);
    // The watch item genuinely scores higher — the split is what protects the user.
    expect(watch[0].recommendation.score).toBeGreaterThan(tradeable[0].recommendation.score);
  });

  it("ranks within a bucket by score, best first", () => {
    const mk = (id: string, s: number) => ({ id, decision: "WAIT", input: { ...base, rankingScoreV2: s, tier: "B" as const } });
    const { tradeable } = rankRecommendations([mk("lo", 0), mk("hi", 70), mk("mid", 30)], (i) => ({ ...i.input, decision: i.decision }));
    expect(tradeable.map((t) => t.item.id)).toEqual(["hi", "mid", "lo"]);
    expect(tradeable.map((t) => t.rank)).toEqual([1, 2, 3]);
  });
});

describe("unscored knowledge", () => {
  it("says risk was not assessed when facts carry no sentiment, rather than implying none was found", () => {
    const k = knowledgeAdjustment([{ kind: "RESULTS" }, { kind: "OWNERSHIP" }], false);
    expect(k.points).toBe(0);
    expect(k.cautions.join(" ")).toMatch(/none machine-scored — risk not assessed/);
  });

  it("reports partial coverage when only some facts are scored", () => {
    const k = knowledgeAdjustment([{ kind: "RESULTS", sentiment: "POSITIVE", materiality: "LOW" }, { kind: "OWNERSHIP" }], false);
    expect(k.cautions.join(" ")).toMatch(/1 of 2 facts are not machine-scored/);
  });
});

describe("negative pipeline economics", () => {
  it("lists a negative-scoring setup as a caution, not a reason", () => {
    const r = recommendationScore({ ...base, rankingScoreV2: -33, tier: "C", action: "RESEARCH_WATCH" });
    expect(r.reasons.join(" ")).not.toMatch(/setup with a priced plan/);
    expect(r.cautions.join(" ")).toMatch(/scores its economics negative/);
  });
});
