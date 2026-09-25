/**
 * composeFullTradePlan (full-plan-v1) — the one-payload trade plan. Tests pin
 * the honesty invariants: NO_TRADE unless qualified AND affordable (with the
 * gate's own reasons), exact-₹ scenarios detached from any probability, the
 * governed probability passed through untouched, and shadow expectancy
 * withheld below the LIVE_AUTHORITY minimum.
 */

import { composeFullTradePlan, FULL_PLAN_DEFAULTS, ShadowSetupStats } from "../src/services/shortterm/fullPlan";
import { LIVE_AUTHORITY } from "../src/services/shortterm/shortTermHealth";
import { ShortTermCandidateView } from "../src/services/shortterm/types";

function fixtureView(over: Partial<ShortTermCandidateView> = {}): ShortTermCandidateView {
  return {
    rank: 1,
    ticker: "TATAPOWER.NS",
    name: "Tata Power",
    sector: "Utilities",
    currentPrice: 402,
    freshness: { state: "LIVE", lastUpdate: "2026-09-25T09:45:00.000Z", ageSeconds: 60, providerNote: "yahoo delayed EOD" },
    freshnessV2: "LIVE",
    action: "ENTER_AT_ZONE",
    state: "ACTIONABLE",
    setupType: "PULLBACK_TO_SUPPORT",
    setupScore: 71,
    entryQuality: 68,
    modelHealth: "SHADOW",
    dataQuality: 92,
    riskLevel: "MEDIUM",
    whyCandidate: ["pullback to rising 21EMA on half volume"],
    whatCanGoWrong: ["support break below ₹392 invalidates the setup"],
    changedSincePrevious: null,
    plan: {
      entryType: "PULLBACK_ZONE",
      entryZoneLow: 396,
      entryZoneHigh: 400,
      entryTrigger: null,
      entryTriggerPrice: null,
      entryTriggerRelVolume: null,
      invalidationPrice: 392,
      invalidationReason: "daily close below the swing low",
      initialStop: 392,
      stopBasis: "1.2×ATR below zone low",
      target1: 412,
      target2: 420,
      target3: 432,
      targetBasis: "prior swing highs",
      expectedHoldingDays: 7,
      rewardRiskToTarget1: 1.5,
      rewardRiskToTarget2: 2.5,
      atr14: 8.4,
      annualVolPct: 34,
      advInr: 900_000_000,
      estimatedSlippagePct: 0.1,
      transactionCostPct: 0.25,
      expectedValueAfterCostsPct: null,
      expectedShortfallPct: null,
    },
    sizing: null,
    forecast: {
      expectedExcessReturnPct: null,
      p10Pct: -3.1,
      p50Pct: 1.2,
      p90Pct: 5.4,
      probabilityTargetBeforeStop: null,
      probabilityStatus: "UNCALIBRATED",
      probabilityStatement: "No calibrated meta-label model is promoted — no probability is stated.",
      expectedHoldingDays: 7,
      modelConfidence: "LOW",
      modelConfidenceReasons: ["shadow-only evidence"],
      setupSampleSize: 14,
      modelVersion: "st-v2",
    },
    gates: { passed: true, failures: [] },
    rankingScore: 62.1,
    aiSummary: null,
    tier: "A",
    qualified: true,
    geometryAction: "ZONE_REACHED",
    ceilingReasons: [],
    whyNotEntry: [],
    confirmation: { satisfied: true, met: ["volume contraction"], unmet: [] },
    contradictions: [],
    ev: null,
    setupEvidence: null,
    plausibility: null,
    ...over,
  };
}

const bigShadow: ShadowSetupStats = { resolved: 35, distinctDates: 28, expectancyR: 0.18, realizedExpectancyR: 0.31, ambiguousTrades: 4 };

describe("composeFullTradePlan — direction discipline", () => {
  test("qualified + complete geometry + affordable ⇒ LONG with full ₹ scenarios", () => {
    const p = composeFullTradePlan(fixtureView(), bigShadow, {}, "2026-09-25T04:00:00.000Z");
    expect(p.direction).toBe("LONG");
    expect(p.noTradeReasons).toHaveLength(0);
    expect(p.entry.orderType).toBe("LIMIT_IN_ZONE");
    expect(p.targets.map((t) => t.level)).toEqual([1, 2, 3]);
    const e = p.economics!;
    expect(e.quantity).toBeGreaterThan(0);
    expect(e.lotSize).toBe(1);
    // Risk-based sizing: loss at stop (net) must not exceed the risk budget.
    expect(Math.abs(e.atStop!.netAfterTaxInr)).toBeLessThanOrEqual(e.riskAmountInr + 1);
    // Deeper targets net strictly more, same quantity throughout.
    expect(e.atT2!.netAfterTaxInr).toBeGreaterThan(e.atT1!.netAfterTaxInr);
    expect(e.atT3!.netAfterTaxInr).toBeGreaterThan(e.atT2!.netAfterTaxInr);
    // Short-term delivery gain scenarios are taxed as STCG; the stop is a loss ⇒ no tax.
    expect(e.atT1!.taxBasis).toContain("STCG");
    expect(e.atStop!.taxInr).toBe(0);
  });

  test("unqualified ⇒ NO_TRADE carrying the gate's own words", () => {
    const p = composeFullTradePlan(
      fixtureView({
        qualified: false,
        tier: "C",
        ceilingReasons: ["evidence tier C — shadow expectancy unproven"],
        whyNotEntry: ["zone not reached"],
        gates: { passed: false, failures: [{ gate: "relVolume", current: "0.8", required: "≥1.2" }] },
      }),
      bigShadow
    );
    expect(p.direction).toBe("NO_TRADE");
    expect(p.noTradeReasons.join(" ")).toContain("evidence tier C");
    expect(p.noTradeReasons.join(" ")).toContain("relVolume");
    expect(p.honesty.join(" ")).toContain("NO_TRADE is a decision");
  });

  test("qualified but unaffordable ⇒ NO_TRADE, never a fabricated position", () => {
    const p = composeFullTradePlan(fixtureView(), bigShadow, { budgetInr: 3000, riskPerTradePct: 0.05 });
    expect(p.direction).toBe("NO_TRADE");
    expect(p.noTradeReasons.join(" ")).toMatch(/unaffordable/);
    expect(p.economics!.quantity).toBe(0);
  });

  test("incomplete geometry ⇒ NO_TRADE with no economics at all", () => {
    const view = fixtureView();
    view.plan = { ...view.plan, target1: null, target2: null, target3: null };
    const p = composeFullTradePlan(view, bigShadow);
    expect(p.direction).toBe("NO_TRADE");
    expect(p.economics).toBeNull();
    expect(p.noTradeReasons.join(" ")).toContain("geometry incomplete");
  });
});

describe("composeFullTradePlan — probability and evidence governance", () => {
  test("the governed probability block passes through UNTOUCHED", () => {
    const p = composeFullTradePlan(fixtureView(), bigShadow);
    expect(p.probability.status).toBe("UNCALIBRATED");
    expect(p.probability.targetBeforeStop).toBeNull(); // composer never invents one
    expect(p.probability.statement).toContain("no probability is stated");
    // The ₹ scenarios carry no probability field anywhere.
    expect(JSON.stringify(p.economics)).not.toMatch(/probabilit/i);
  });

  test(`shadow expectancy is WITHHELD below ${LIVE_AUTHORITY.minEffectiveShadowTrades} independent trades`, () => {
    const small: ShadowSetupStats = { resolved: 8, distinctDates: 6, expectancyR: 0.9, realizedExpectancyR: 1.2, ambiguousTrades: 0 };
    const p = composeFullTradePlan(fixtureView(), small);
    expect(p.evidence.shadow.status).toBe("WITHHELD");
    const w = p.evidence.shadow as { status: "WITHHELD"; reason: string };
    expect(w.reason).toContain("6 independent resolved shadow trades"); // min(resolved, dates)
    // The tempting 0.9R number is nowhere in the payload.
    expect(JSON.stringify(p.evidence.shadow)).not.toContain("0.9");
  });

  test("shadow expectancy above min-n is SHOWN with both frames + ambiguity count", () => {
    const p = composeFullTradePlan(fixtureView(), bigShadow);
    expect(p.evidence.shadow.status).toBe("SHOWN");
    const s = p.evidence.shadow as { conservativeExpectancyR: number; realizedExpectancyR: number; ambiguousTrades: number };
    expect(s.conservativeExpectancyR).toBe(0.18);
    expect(s.realizedExpectancyR).toBe(0.31);
    expect(s.ambiguousTrades).toBe(4);
  });

  test("stale data adds an explicit verification warning", () => {
    const p = composeFullTradePlan(fixtureView({ freshness: { state: "STALE", lastUpdate: null, ageSeconds: null, providerNote: "EOD only" }, freshnessV2: "STALE" }), bigShadow);
    expect(p.honesty.join(" ")).toContain("verify price before placing any order");
  });

  test("defaults are the documented ones and are echoed in the payload", () => {
    const p = composeFullTradePlan(fixtureView(), bigShadow);
    expect(p.economics!.params.budgetInr).toBe(FULL_PLAN_DEFAULTS.budgetInr);
    expect(p.economics!.params.riskPerTradePct).toBe(FULL_PLAN_DEFAULTS.riskPerTradePct);
    expect(p.economics!.params.productType).toBe("DELIVERY_EQUITY");
  });
});
