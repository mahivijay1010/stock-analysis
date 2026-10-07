/**
 * Conviction Board (conviction-board-v1). The board must never let "conviction"
 * drift into "profit promise": these tests pin that the BUY-grade bar is
 * fail-closed, that poor reward:risk and AI caps push a stock down, that an
 * empty HIGH tier yields an honest headline (not a force-filled bucket), and
 * that tiers are driven by evidence components, not hope.
 */

import { scoreConviction, buildConvictionBoard, ConvictionInput, TIER_BANDS } from "../src/services/shortterm/convictionBoard";

const base: ConvictionInput = {
  symbol: "ABC",
  ticker: "ABC.NS",
  companyName: "ABC Ltd",
  industry: "Testing",
  price: 50,
  setupType: "PULLBACK",
  action: "RESEARCH_WATCH",
  tier: "C",
  gatesPassed: false,
  decision: "WATCH",
  rewardRiskToT1: 1.2,
  evAfterCostsPct: -0.5,
  dataQuality: 60,
  entry: 50,
  stop: 47,
  target1: 54,
  aiCapAction: "AFFIRM",
  aiConfidence: "MEDIUM",
  aiRedFlags: 3,
};

describe("scoreConviction — components and the BUY-grade bar", () => {
  test("a fully-cleared setup is BUY-grade and lands HIGH", () => {
    const s = scoreConviction({
      ...base,
      action: "ENTRY_CONFIRMED",
      gatesPassed: true,
      rewardRiskToT1: 2.1,
      evAfterCostsPct: 1.2,
      aiCapAction: "AFFIRM",
      aiRedFlags: 1,
      dataQuality: 90,
    });
    expect(s.buyGrade).toBe(true);
    expect(s.tier).toBe("HIGH");
    expect(s.score).toBeGreaterThanOrEqual(TIER_BANDS.high);
    expect(s.reasons[0]).toMatch(/Clears every gate/);
  });

  test("negative EV alone BLOCKS BUY-grade even with a confirmed entry", () => {
    const s = scoreConviction({ ...base, action: "ENTRY_CONFIRMED", gatesPassed: true, rewardRiskToT1: 2.0, evAfterCostsPct: -0.1, aiCapAction: "AFFIRM" });
    expect(s.buyGrade).toBe(false); // fail-closed: EV must be > 0
    expect(s.reasons.join(" ")).toMatch(/not positive/);
  });

  test("an AI CAP_TO_NO_TRADE blocks BUY-grade and zeroes the AI component", () => {
    const s = scoreConviction({ ...base, action: "ENTRY_CONFIRMED", gatesPassed: true, rewardRiskToT1: 2.0, evAfterCostsPct: 1.0, aiCapAction: "CAP_TO_NO_TRADE" });
    expect(s.buyGrade).toBe(false);
    expect(s.components.aiRisk).toBe(0);
    expect(s.reasons.join(" ")).toMatch(/capped this to NO TRADE/);
  });

  test("poor reward:risk is scored low and called out plainly", () => {
    const s = scoreConviction({ ...base, rewardRiskToT1: 0.3 });
    expect(s.components.rewardRisk).toBeLessThanOrEqual(2);
    expect(s.reasons.join(" ")).toMatch(/Poor reward:risk/);
  });

  test("a no-setup stock scores near the floor (tradeability only)", () => {
    const s = scoreConviction({ ...base, action: "NO_SETUP", rewardRiskToT1: null, evAfterCostsPct: null, aiCapAction: null, aiRedFlags: 0, dataQuality: 60 });
    expect(s.components.actionability).toBe(0);
    expect(s.tier).toBe("LOW");
    expect(s.score).toBeLessThan(TIER_BANDS.medium);
  });

  test("red flags beyond 3 erode the AI component", () => {
    const clean = scoreConviction({ ...base, aiRedFlags: 2 });
    const flagged = scoreConviction({ ...base, aiRedFlags: 9 });
    expect(flagged.components.aiRisk).toBeLessThan(clean.components.aiRisk);
  });
});

describe("buildConvictionBoard — honest tiering", () => {
  const mk = (over: Partial<ConvictionInput>, i: number): ConvictionInput => ({ ...base, symbol: `S${i}`, ticker: `S${i}.NS`, ...over });

  test("when nothing clears the bar, the headline says so — no force-fill", () => {
    const inputs = Array.from({ length: 20 }, (_, i) => mk({ action: "NO_SETUP", rewardRiskToT1: null, evAfterCostsPct: null, aiCapAction: null }, i));
    const board = buildConvictionBoard(inputs, "2026-10-07T00:00:00Z");
    expect(board.buyGradeCount).toBe(0);
    expect(board.high).toHaveLength(0);
    expect(board.headline).toMatch(/no strong sub-₹100 setup|0 stocks clear/i);
    expect(board.caveat).toMatch(/NOT a probability of profit/i);
  });

  test("each tier is capped at the top 10 and sorted by score", () => {
    const inputs = [
      ...Array.from({ length: 15 }, (_, i) => mk({ action: "ENTRY_CONFIRMED", gatesPassed: true, rewardRiskToT1: 2.2, evAfterCostsPct: 1.5, dataQuality: 95 }, i)),
      ...Array.from({ length: 15 }, (_, i) => mk({ action: "NO_SETUP", rewardRiskToT1: null, evAfterCostsPct: null, aiCapAction: null }, 100 + i)),
    ];
    const board = buildConvictionBoard(inputs, null);
    expect(board.high.length).toBeLessThanOrEqual(10);
    expect(board.low.length).toBeLessThanOrEqual(10);
    for (let i = 1; i < board.high.length; i++) expect(board.high[i - 1].score).toBeGreaterThanOrEqual(board.high[i].score);
    expect(board.evaluated).toBe(30);
  });

  test("buyGradeCount counts only fully-cleared setups", () => {
    const inputs = [
      mk({ action: "ENTRY_CONFIRMED", gatesPassed: true, rewardRiskToT1: 2.0, evAfterCostsPct: 1.0, aiCapAction: "AFFIRM" }, 1), // buy-grade
      mk({ action: "ENTRY_CONFIRMED", gatesPassed: true, rewardRiskToT1: 2.0, evAfterCostsPct: -1, aiCapAction: "AFFIRM" }, 2), // EV blocks
      mk({ action: "RESEARCH_WATCH" }, 3), // not confirmed
    ];
    const board = buildConvictionBoard(inputs, null);
    expect(board.buyGradeCount).toBe(1);
  });
});
