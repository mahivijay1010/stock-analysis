/**
 * Money Desk allocation engine (capital-policy-v1). Pins: risk-based sizing
 * (never capital ÷ price), cash reserve, position / risk / sector caps,
 * max positions, profiles that change thresholds (not multipliers), honest
 * NO-NEW-ALLOCATION days, and every "why not" gate.
 */
import { buildCapitalPlan, BuildPlanInput } from "../src/services/capital/capitalAllocation";
import { ABSOLUTE_LIMITS, resolveRiskProfile, RISK_PROFILES } from "../src/services/capital/riskProfiles";
import { CapitalCandidateInput, CapitalHoldingInput, MarketContextInput } from "../src/services/capital/types";

const market = (over: Partial<MarketContextInput> = {}): MarketContextInput => ({
  regime: "TREND_UP",
  regimeReasons: ["test"],
  breakerCanEnter: true,
  breakerReason: null,
  freshness: { quoteTimestamp: "2026-10-07T10:00:00Z", quoteType: "EOD_FINAL", marketState: "CLOSED", latestCompletedBarDate: "2026-10-07", providerDelay: "test", featureCutoffAt: "2026-10-08T03:00:00Z" },
  ...over,
});

const qualified = (ticker = "ABC.NS", over: Partial<CapitalCandidateInput> = {}): CapitalCandidateInput => ({
  ticker,
  name: ticker,
  sector: "Testing",
  currentPrice: 100,
  action: "ENTRY_CONFIRMED",
  tier: "A",
  qualified: true,
  modelHealth: "HEALTHY",
  freshnessV2: "EOD_FINAL",
  setupType: "PULLBACK_IN_UPTREND",
  rank: 1,
  rankingScore: 80,
  gateFailures: [],
  ceilingReasons: [],
  whyNotEntry: [],
  plan: { entryType: "PULLBACK_ZONE", entryZoneLow: 98, entryZoneHigh: 100, entryTriggerPrice: null, initialStop: 95, target1: 110, target2: 115, target3: null, rewardRiskToTarget1: 2.0, expectedHoldingDays: 7, invalidationPrice: 94, invalidationReason: "close below swing low", atr14: 2, advInr: 5e8, transactionCostPct: 0.3, estimatedSlippagePct: 0.2 },
  ev: { ev80LowerPct: 0.4, meanEvAfterCostsPct: 1.2, expectedR: 0.3 },
  setupEvidence: { evidenceStrength: "A", usableForEntry: true },
  probability: { status: "UNCALIBRATED", targetBeforeStop: null },
  relVolume: 1.2,
  tradeability: { tradeable: true, hardBlocks: [] },
  aiCapAction: "AFFIRM",
  evidenceScore: 70,
  decisionSnapshotId: null,
  ...over,
});

const base = (over: Partial<BuildPlanInput> = {}): BuildPlanInput => ({
  asOf: "2026-10-08T03:30:00Z",
  capitalAvailableInr: 20000,
  holdings: [],
  candidates: [qualified()],
  market: market(),
  profile: resolveRiskProfile("BALANCED"),
  horizon: "5-10d",
  ...over,
});

describe("buildCapitalPlan — sizing is risk-based and capped", () => {
  test("a qualified setup is ALLOCATED with qty from risk, not capital ÷ price", () => {
    const r = buildCapitalPlan(base());
    expect(r.allocations).toHaveLength(1);
    const a = r.allocations[0];
    expect(a.recommendedQuantity).toBeGreaterThan(0);
    // naive capital ÷ price would be 200 shares; risk-based must be far smaller
    expect(a.recommendedQuantity).toBeLessThan(200);
    // qty × (entry − stop) ≤ risk per trade (0.5% of 20k = ₹100) — loss per share includes costs so qty ≤ 100/5
    expect(a.recommendedQuantity * (a.entryPrice - a.stopPrice)).toBeLessThanOrEqual(100);
    expect(a.riskAmountInr).toBeLessThanOrEqual(r.cash.riskBudgetInr);
    expect(a.recommendedAmountInr).toBe(a.recommendedQuantity * a.entryPrice);
    expect(r.noNewAllocation).toBe(false);
    expect(r.summary).not.toMatch(/guarantee|will rise|safe profit|best stock/i);
  });

  test("cash reserve is respected: deployment never eats the reserve", () => {
    const r = buildCapitalPlan(base({ candidates: [qualified("A.NS"), qualified("B.NS", { rank: 2 }), qualified("C.NS", { rank: 3 })] }));
    expect(r.cash.cashReserveInr).toBe(5000);
    expect(r.cash.recommendedDeploymentInr).toBeLessThanOrEqual(20000 - 5000);
    expect(r.cash.recommendedCashInr).toBeGreaterThanOrEqual(5000);
  });

  test("position cap binds (max 25% of equity for BALANCED) when risk allows more", () => {
    // tight stop → risk sizing would buy a lot; the position cap must bind first
    const c = qualified("TIGHT.NS", { plan: { ...qualified().plan, initialStop: 99.5, rewardRiskToTarget1: 20 } });
    const r = buildCapitalPlan(base({ candidates: [c], capitalAvailableInr: 100000 }));
    expect(r.allocations[0].recommendedAmountInr).toBeLessThanOrEqual(25000);
    expect(r.allocations[0].reasonCodes).toContain("POSITION_CAP_BINDING");
  });

  test("max positions is a hard limit; extra qualified names are rejected with MAX_POSITIONS_REACHED", () => {
    const cands = ["A", "B", "C", "D", "E"].map((t, i) => qualified(`${t}.NS`, { rank: i + 1 }));
    const r = buildCapitalPlan(base({ candidates: cands, capitalAvailableInr: 500000, profile: resolveRiskProfile("BALANCED") }));
    expect(r.allocations.length).toBeLessThanOrEqual(3);
    expect(r.rejected.some((x) => x.reasonCodes.includes("MAX_POSITIONS_REACHED"))).toBe(true);
  });

  test("portfolio risk budget is exhausted in rank order; later names get RISK_BUDGET_EXHAUSTED or a reduced size", () => {
    const cands = ["A", "B", "C"].map((t, i) => qualified(`${t}.NS`, { rank: i + 1 }));
    const r = buildCapitalPlan(base({ candidates: cands, capitalAvailableInr: 20000, profile: resolveRiskProfile("BALANCED", { maxPortfolioRiskPct: 0.5 }) }));
    const totalRisk = r.allocations.reduce((s, a) => s + a.riskAmountInr, 0);
    expect(totalRisk).toBeLessThanOrEqual(r.cash.riskBudgetInr + 0.01);
  });

  test("sector cap: three same-sector names cannot exceed 50% of equity combined", () => {
    const cands = ["A", "B", "C"].map((t, i) => qualified(`${t}.NS`, { rank: i + 1, sector: "Banks", plan: { ...qualified().plan, initialStop: 99 } }));
    const r = buildCapitalPlan(base({ candidates: cands, capitalAvailableInr: 100000, profile: resolveRiskProfile("AGGRESSIVE") }));
    const banks = r.allocations.reduce((s, a) => s + a.recommendedAmountInr, 0);
    expect(banks).toBeLessThanOrEqual(50000 + 100);
  });

  test("duplicate candidate rows produce one allocation", () => {
    const r = buildCapitalPlan(base({ candidates: [qualified("DUP.NS"), qualified("DUP.NS", { rank: 2 })] }));
    expect(r.allocations.filter((a) => a.ticker === "DUP.NS")).toHaveLength(1);
    expect(r.candidatesEvaluated).toBe(1);
  });

  test("already-held tickers never receive new capital", () => {
    const h: CapitalHoldingInput = { ticker: "ABC.NS", name: "ABC", qty: 10, sector: "Testing", investedInr: 1000, price: 100, priceAsOf: null, markedValueInr: 1000, evidence: qualified(), evidenceAsOf: null };
    const r = buildCapitalPlan(base({ holdings: [h] }));
    expect(r.allocations).toHaveLength(0);
    expect(r.rejected[0].reasonCodes).toContain("ALREADY_HELD");
  });
});

describe("buildCapitalPlan — honest no-trade days and why-not gates", () => {
  test("no candidates → NO NEW CAPITAL ALLOCATION with a stated reason, all cash", () => {
    const r = buildCapitalPlan(base({ candidates: [] }));
    expect(r.noNewAllocation).toBe(true);
    expect(r.summary).toMatch(/NO NEW CAPITAL ALLOCATION TODAY/);
    expect(r.cash.recommendedCashInr).toBe(20000);
    expect(r.cash.whyCash.length).toBeGreaterThan(0);
  });

  const gate = (name: string, over: Partial<CapitalCandidateInput>, code: string) =>
    test(`${name} → rejected with ${code}`, () => {
      const r = buildCapitalPlan(base({ candidates: [qualified("X.NS", over)] }));
      expect(r.allocations).toHaveLength(0);
      expect(r.rejected[0].reasonCodes).toContain(code);
      expect(r.rejected[0].whyNot.length).toBeGreaterThan(0);
    });
  gate("entry not confirmed", { qualified: false, action: "NO_TRADE" }, "ENTRY_NOT_CONFIRMED");
  gate("negative EV lower bound", { ev: { ev80LowerPct: -0.2, meanEvAfterCostsPct: 0.1, expectedR: 0.1 } }, "EV_LOWER_BOUND_NEGATIVE");
  gate("missing EV", { ev: null }, "EV_UNAVAILABLE");
  gate("reward/risk below profile minimum", { plan: { ...qualified().plan, rewardRiskToTarget1: 1.1 } }, "REWARD_RISK_BELOW_MIN");
  gate("evidence tier B", { tier: "B" }, "EVIDENCE_TIER_INSUFFICIENT");
  gate("model suspended", { modelHealth: "SUSPENDED" }, "MODEL_HEALTH_INSUFFICIENT");
  gate("not tradeable", { tradeability: { tradeable: false, hardBlocks: ["GSM"] } }, "NOT_TRADEABLE");
  gate("stale data", { freshnessV2: "STALE" }, "STALE_DATA");
  gate("invalid stop (stop above entry)", { plan: { ...qualified().plan, initialStop: 101 } }, "INVALID_GEOMETRY");
  gate("missing stop", { plan: { ...qualified().plan, initialStop: null } }, "INVALID_GEOMETRY");
  gate("horizon mismatch (25-session plan for 3–5d)", { plan: { ...qualified().plan, expectedHoldingDays: 25 } }, "HORIZON_MISMATCH");
  gate("AI cap to NO TRADE", { aiCapAction: "CAP_TO_NO_TRADE" }, "AI_CAP_NO_TRADE");
  gate("zero liquidity (ADV ₹1)", { plan: { ...qualified().plan, advInr: 1 } }, "LIQUIDITY_INSUFFICIENT");

  test("CRISIS regime → no new entries, stated in whyCash", () => {
    const r = buildCapitalPlan(base({ market: market({ regime: "CRISIS" }) }));
    expect(r.allocations).toHaveLength(0);
    expect(r.rejected[0].reasonCodes).toContain("REGIME_ENTRIES_OFF");
    expect(r.cash.whyCash.join(" ")).toMatch(/CRISIS/);
  });
  test("regime conflict: breakout in CHOPPY (mean-reversion only) is rejected", () => {
    const r = buildCapitalPlan(base({ market: market({ regime: "CHOPPY" }), candidates: [qualified("BO.NS", { setupType: "BREAKOUT_CONFIRMATION" })] }));
    expect(r.rejected[0].reasonCodes).toContain("REGIME_CONFLICT");
  });
  test("TREND_DOWN halves the size multiplier and records it in constraints", () => {
    const r = buildCapitalPlan(base({ market: market({ regime: "TREND_DOWN" }), candidates: [qualified("MR.NS", { setupType: "MEAN_REVERSION" })] }));
    expect(r.regime.sizeMultiplier).toBe(0.5);
    expect(r.allocations[0].sizingConstraints.join(" ")).toMatch(/size ×0.5/);
  });
  test("circuit breaker tripped → nothing allocated", () => {
    const r = buildCapitalPlan(base({ market: market({ breakerCanEnter: false, breakerReason: "6R drawdown" }) }));
    expect(r.allocations).toHaveLength(0);
    expect(r.rejected[0].reasonCodes).toContain("CIRCUIT_BREAKER");
  });
  test("delayed intraday data is allowed but labelled DELAYED, never LIVE", () => {
    const r = buildCapitalPlan(base({ market: market({ freshness: { ...market().freshness, quoteType: "DELAYED_INTRADAY", marketState: "OPEN" } }) }));
    expect(r.freshness.quoteType).toBe("DELAYED_INTRADAY");
    expect(r.freshness.quoteType).not.toBe("LIVE");
  });
  test("ZONE_REACHED without hard failures becomes a CONDITIONAL (WATCH) line with a max amount, not an allocation", () => {
    const r = buildCapitalPlan(base({ candidates: [qualified("Z.NS", { qualified: false, action: "ZONE_REACHED", whyNotEntry: ["volume confirmation pending"] })] }));
    expect(r.allocations).toHaveLength(0);
    expect(r.conditional).toHaveLength(1);
    expect(r.conditional[0].action).toBe("WATCH");
    expect(r.conditional[0].maxAmountInr).toBeGreaterThan(0);
    expect(r.conditional[0].changesIf.join(" ")).toMatch(/volume confirmation pending/);
  });
  test("probability is passed through only when AVAILABLE", () => {
    const r1 = buildCapitalPlan(base({ candidates: [qualified("P.NS", { probability: { status: "NO_SKILL", targetBeforeStop: 0.7 } })] }));
    expect(r1.allocations[0].probability.targetBeforeStop).toBeNull();
    const r2 = buildCapitalPlan(base({ candidates: [qualified("P.NS", { probability: { status: "AVAILABLE", targetBeforeStop: 0.61 } })] }));
    expect(r2.allocations[0].probability.targetBeforeStop).toBe(0.61);
  });
  test("tiny capital → risk size rounds to zero shares and says so", () => {
    const r = buildCapitalPlan(base({ capitalAvailableInr: 500 }));
    expect(r.allocations).toHaveLength(0);
    expect(r.rejected[0].reasonCodes).toContain("CAPITAL_TOO_SMALL_FOR_ONE_SHARE");
  });
});

describe("risk profiles change thresholds, not just a multiplier", () => {
  test("CONSERVATIVE keeps more cash, allows fewer positions and demands higher R:R than AGGRESSIVE", () => {
    const cands = ["A", "B", "C", "D"].map((t, i) => qualified(`${t}.NS`, { rank: i + 1, plan: { ...qualified().plan, rewardRiskToTarget1: 1.7 } }));
    const cons = buildCapitalPlan(base({ candidates: cands, capitalAvailableInr: 100000, profile: resolveRiskProfile("CONSERVATIVE") }));
    const aggr = buildCapitalPlan(base({ candidates: cands, capitalAvailableInr: 100000, profile: resolveRiskProfile("AGGRESSIVE") }));
    // R:R 1.7 fails CONSERVATIVE (min 2.0) and BALANCED (1.8) but passes AGGRESSIVE (1.5)
    expect(cons.allocations).toHaveLength(0);
    expect(cons.rejected[0].reasonCodes).toContain("REWARD_RISK_BELOW_MIN");
    expect(aggr.allocations.length).toBeGreaterThan(0);
    expect(cons.cash.cashReserveInr).toBeGreaterThan(aggr.cash.cashReserveInr);
    expect(cons.maxPositions).toBeLessThan(aggr.maxPositions);
  });
  test("overrides are clamped to ABSOLUTE_LIMITS (fail-closed)", () => {
    const p = resolveRiskProfile("AGGRESSIVE", { maxPositions: 50, maxPositionPctOfCapital: 90, maxPortfolioRiskPct: 25, riskPerTradePct: 5, cashReservePct: 0, minRewardRisk: 0.2 });
    expect(p.maxPositions).toBe(ABSOLUTE_LIMITS.maxPositions);
    expect(p.maxPositionPctOfCapital).toBe(ABSOLUTE_LIMITS.maxPositionPctOfCapital);
    expect(p.maxPortfolioRiskPct).toBe(ABSOLUTE_LIMITS.maxPortfolioRiskPct);
    expect(p.riskPerTradePct).toBe(ABSOLUTE_LIMITS.maxRiskPerTradePct);
    expect(p.cashReservePct).toBe(ABSOLUTE_LIMITS.minCashReservePct);
    expect(p.minRewardRisk).toBe(ABSOLUTE_LIMITS.minRewardRiskFloor);
  });
  test("user maxPositions override can lower but never raise the profile's limit", () => {
    const r = buildCapitalPlan(base({ maxPositions: 9 }));
    expect(r.maxPositions).toBe(RISK_PROFILES.BALANCED.maxPositions);
    const r2 = buildCapitalPlan(base({ maxPositions: 1 }));
    expect(r2.maxPositions).toBe(1);
  });
});

describe("scenario summary is labelled and consistent", () => {
  test("max loss = Σ loss-at-stop; upside at T1 is a scenario label", () => {
    const r = buildCapitalPlan(base({ candidates: [qualified("A.NS"), qualified("B.NS", { rank: 2 })] }));
    const sum = r.allocations.reduce((s, a) => s + a.riskAmountInr, 0);
    expect(r.scenario.maxPortfolioLossInr).toBeCloseTo(sum, 1);
    expect(r.scenario.label).toMatch(/SCENARIO/);
    expect(r.scenario.maxUpsideAtTarget1Inr).toBeGreaterThan(0);
  });
});
