/** Money Desk withdrawal engine: applies the plan's OWN levels; never invents exits. */
import { decideWithdrawals } from "../src/services/capital/capitalWithdrawal";
import { resolveRiskProfile } from "../src/services/capital/riskProfiles";
import { CapitalCandidateInput, CapitalHoldingInput, MarketContextInput } from "../src/services/capital/types";

const market = (over: Partial<MarketContextInput> = {}): MarketContextInput => ({
  regime: "TREND_UP", regimeReasons: [], breakerCanEnter: true, breakerReason: null,
  freshness: { quoteTimestamp: null, quoteType: "EOD_FINAL", marketState: "CLOSED", latestCompletedBarDate: "2026-10-07", providerDelay: "", featureCutoffAt: null },
  ...over,
});
const evidence = (over: Partial<CapitalCandidateInput> = {}): CapitalCandidateInput => ({
  ticker: "TM", name: "Tata Motors", sector: "Autos", currentPrice: 100, action: "ACTIVE_POSITION", tier: "A", qualified: true, modelHealth: "HEALTHY", freshnessV2: "EOD_FINAL",
  setupType: "PULLBACK_IN_UPTREND", rank: null, rankingScore: null, gateFailures: [], ceilingReasons: [], whyNotEntry: [],
  plan: { entryType: "PULLBACK_ZONE", entryZoneLow: 98, entryZoneHigh: 100, entryTriggerPrice: null, initialStop: 95, target1: 110, target2: 118, target3: null, rewardRiskToTarget1: 2, expectedHoldingDays: 7, invalidationPrice: 94, invalidationReason: "swing low", atr14: 2, advInr: 1e9, transactionCostPct: 0.3, estimatedSlippagePct: 0.2 },
  ev: { ev80LowerPct: 0.5, meanEvAfterCostsPct: 1, expectedR: 0.3 }, setupEvidence: null, probability: { status: "UNCALIBRATED", targetBeforeStop: null }, relVolume: 1, tradeability: null, aiCapAction: null, evidenceScore: null, decisionSnapshotId: null,
  ...over,
});
const holding = (price: number | null, ev: CapitalCandidateInput | null = evidence(), over: Partial<CapitalHoldingInput> = {}): CapitalHoldingInput => ({
  ticker: "TM", name: "Tata Motors", qty: 70, sector: "Autos", investedInr: 7000, price, priceAsOf: null, markedValueInr: price != null ? 70 * price : null, evidence: ev, evidenceAsOf: "2026-10-08T03:00:00Z", ...over,
});
const run = (h: CapitalHoldingInput, m = market(), profile = resolveRiskProfile("BALANCED"), equity = 100000) => decideWithdrawals({ holdings: [h], market: m, profile, totalEquityInr: equity })[0];

describe("withdrawal engine", () => {
  test("price unavailable → HOLD with PRICE_UNAVAILABLE, no amounts invented", () => {
    const d = run(holding(null));
    expect(d.action).toBe("HOLD");
    expect(d.reasonCodes).toEqual(["PRICE_UNAVAILABLE"]);
    expect(d.amountToWithdrawInr).toBeNull();
  });
  test("no evaluation on file → HOLD and says so", () => {
    const d = run(holding(100, null));
    expect(d.action).toBe("HOLD");
    expect(d.reasonCodes).toContain("NO_EVALUATION_ON_FILE");
  });
  test("price at/below initial stop → EXIT everything", () => {
    const d = run(holding(95));
    expect(d.action).toBe("EXIT");
    expect(d.reasonCodes).toContain("STOP_HIT");
    expect(d.qtyToSell).toBe(70);
    expect(d.recommendedRemainingInr).toBe(0);
    expect(d.amountToWithdrawInr).toBe(70 * 95);
  });
  test("price below invalidation → EXIT (invalidation before stop)", () => {
    const d = run(holding(93.5, evidence({ plan: { ...evidence().plan, initialStop: 90 } })));
    expect(d.action).toBe("EXIT");
    expect(d.reasonCodes).toContain("INVALIDATION_HIT");
  });
  test("engine action EXIT/INVALIDATED → EXIT regardless of price", () => {
    expect(run(holding(105, evidence({ action: "INVALIDATED" }))).action).toBe("EXIT");
  });
  test("target 1 reached → REDUCE half with a trailing stop (close − 1.5×ATR)", () => {
    const d = run(holding(110));
    expect(d.action).toBe("REDUCE");
    expect(d.reasonCodes).toContain("TARGET1_REACHED");
    expect(d.qtyToSell).toBe(35);
    expect(d.trailStopPrice).toBe(107);
    expect(d.amountToWithdrawInr! + d.recommendedRemainingInr!).toBeCloseTo(d.currentValueInr!, 2);
  });
  test("target 2 reached → REDUCE to a quarter", () => {
    const d = run(holding(118));
    expect(d.action).toBe("REDUCE");
    expect(d.reasonCodes).toContain("TARGET2_REACHED");
    expect(d.qtyToSell).toBe(70 - 17);
  });
  test("reward/risk compressed with EV still positive → TRAIL (no withdrawal)", () => {
    // price 108: remaining (110−108)/(108−95)=0.15 < 0.8
    const d = run(holding(108));
    expect(d.action).toBe("TRAIL");
    expect(d.amountToWithdrawInr).toBe(0);
    expect(d.trailStopPrice).toBe(105);
  });
  test("reward/risk compressed AND setup deteriorated (EV80 ≤ 0) → REDUCE half", () => {
    const d = run(holding(108, evidence({ ev: { ev80LowerPct: -0.1, meanEvAfterCostsPct: 0, expectedR: 0 } })));
    expect(d.action).toBe("REDUCE");
    expect(d.reasonCodes).toEqual(expect.arrayContaining(["REWARD_RISK_COMPRESSED", "SETUP_DETERIORATED"]));
    expect(d.reasons[0]).toMatch(/Reward|reward/);
  });
  test("CRISIS regime → REDUCE to the profile's risk-off hold %", () => {
    const d = run(holding(100), market({ regime: "CRISIS" }));
    expect(d.action).toBe("REDUCE");
    expect(d.reasonCodes).toContain("REGIME_RISK_OFF");
    expect(d.recommendedRemainingInr).toBe(3500); // BALANCED keeps 50%
  });
  test("concentration above the profile cap → REDUCE to the cap", () => {
    const d = run(holding(100), market(), resolveRiskProfile("CONSERVATIVE"), 20000); // 7000 = 35% > 15% cap
    expect(d.action).toBe("REDUCE");
    expect(d.reasonCodes).toContain("CONCENTRATION_ABOVE_CAP");
    expect(d.recommendedRemainingInr).toBeLessThanOrEqual(3000);
    expect(d.amountToWithdrawInr).toBeGreaterThanOrEqual(4000);
  });
  test("healthy plan → HOLD with invalidation stated", () => {
    const d = run(holding(100));
    expect(d.action).toBe("HOLD");
    expect(d.reasonCodes).toEqual(["PLAN_HEALTHY"]);
    expect(d.invalidation.join(" ")).toMatch(/94/);
    expect(d.pnlInr).toBe(0);
  });
  test("zero-qty holdings are skipped", () => {
    expect(decideWithdrawals({ holdings: [holding(100, evidence(), { qty: 0 })], market: market(), profile: resolveRiskProfile("BALANCED"), totalEquityInr: 1 })).toHaveLength(0);
  });
});
