/**
 * Short-Term Trade Radar tests (S14) — sizing math, gate honesty (fewer than
 * five is normal), cost schedule, exit engine, freshness honesty, and the
 * GENERALIZED BHEL regression: late-trend/weak-participation patterns must
 * not produce entry-ready states just because price > SMA200.
 */

import { computePositionSize, assessPortfolioRisk, RISK_LIMITS } from "../src/services/shortterm/sizing";
import { roundTripCostPct, estimateSlippagePct } from "../src/services/shortterm/costs";
import { classifySetup } from "../src/services/shortterm/setups";
import { assessExit } from "../src/services/shortterm/entryExit";
import { evaluateGates, GATE_THRESHOLDS } from "../src/services/shortterm/ranking";
import { ShortTermFeatures } from "../src/services/shortterm/features";
import { YahooLiveProvider } from "../src/services/shortterm/LiveMarketDataProvider";

function feats(over: Partial<ShortTermFeatures>): ShortTermFeatures {
  return {
    asOfDate: "2026-09-08",
    price: 422,
    r1: 0.001,
    r3: 0.002,
    r5: -0.005,
    r10: 0.01,
    r20: 0.05,
    relNifty5: 0,
    relNifty20: 0.02,
    relSector20: 0.01,
    rsi14: 52,
    macdHist: 0.5,
    atr14: 10,
    atrPct: 2.4,
    adx14: 22,
    sma20: 420,
    sma50: 405,
    sma200: 340,
    ema20: 419,
    distSma20Pct: 0.5,
    distSma50Pct: 4.2,
    distSma200Pct: 24,
    week52Pct: 85,
    gapPct: 0,
    relVolume: 1.0,
    volumeAccel: 1.0,
    volPriceConfirm: 0.6,
    realizedVol20AnnPct: 30,
    drawdownFrom20dHighPct: -4,
    breakoutDistPct: -4,
    supportDistPct: 3,
    resistanceDistPct: 4,
    trendPersist10: 0.5,
    contraction: 0.9,
    advInr20: 500_000_000,
    zeroVolumeBars20: 0,
    ...over,
  };
}

describe("risk-based position sizing (spec example)", () => {
  test("₹50,000 budget, 0.5% risk, entry 420, stop 410: cost-inclusive size never breaches the risk budget (P0 #7)", () => {
    const s = computePositionSize({ budgetInr: 50_000, riskPerTradePct: 0.5, entryPrice: 420, stopPrice: 410, atrPct: 2.4, relVolume: 1, advInr: 1e9 });
    expect(s.riskAmount).toBe(250);
    expect(s.riskPerShare).toBe(10);
    // price-only qty (25) is reported for transparency, but the SIZED qty is
    // smaller because costs + slippage + a gap buffer are solved in first.
    expect(s.rawRiskBasedQty).toBe(25);
    expect(s.positionSizeShares).toBeLessThan(25);
    expect(s.positionSizeShares).toBeGreaterThan(0);
    // THE INVARIANT: realized loss at the stop (incl. costs) ≤ the risk budget.
    expect(s.lossAtStop!).toBeLessThanOrEqual(s.riskAmount);
    expect(s.capitalRequired).toBe(s.positionSizeShares * 420);
  });

  test("never budget/price: capital used stays within the single-stock cap and the loss budget", () => {
    const s = computePositionSize({ budgetInr: 50_000, riskPerTradePct: 0.5, entryPrice: 100, stopPrice: 99, atrPct: 2, relVolume: 1, advInr: 1e9 });
    expect(s.capitalRequired).toBeLessThanOrEqual(50_000 * 0.35); // ≤35% single-stock allocation
    expect(s.lossAtStop!).toBeLessThanOrEqual(s.riskAmount); // cost-inclusive loss never breaches the budget
    expect(s.capitalRequired).toBeLessThan(50_000); // never the whole budget
  });

  test("explicit single-stock cap triggers when the cost-inclusive size still exceeds 35%", () => {
    // Tiny stop distance + high risk% ⇒ cost-inclusive qty*price would exceed 35%.
    const s = computePositionSize({ budgetInr: 50_000, riskPerTradePct: 5, entryPrice: 100, stopPrice: 99.9, atrPct: 1, relVolume: 1, advInr: 1e9 });
    expect(s.capitalRequired).toBeLessThanOrEqual(50_000 * 0.35);
    expect(s.constraintsApplied.join(" ")).toMatch(/single-stock allocation/);
  });

  test("liquidity cap: order ≤ 2% of ADV", () => {
    const s = computePositionSize({ budgetInr: 500_000, riskPerTradePct: 1, entryPrice: 100, stopPrice: 98, atrPct: 2, relVolume: 1, advInr: 1_000_000 });
    expect(s.capitalRequired).toBeLessThanOrEqual(20_000 + 100);
    expect(s.constraintsApplied.join(" ")).toMatch(/liquidity/);
  });

  test("invalid geometry (stop above entry) ⇒ zero size, stated", () => {
    const s = computePositionSize({ budgetInr: 50_000, riskPerTradePct: 0.5, entryPrice: 400, stopPrice: 410, atrPct: 2, relVolume: 1, advInr: 1e9 });
    expect(s.positionSizeShares).toBe(0);
  });
});

describe("portfolio risk manager", () => {
  test("daily loss limit blocks new entries", () => {
    const v = assessPortfolioRisk({ budgetInr: 100_000, openPositions: [], realizedTodayInr: -(100_000 * (RISK_LIMITS.maxDailyLossPctOfBudget / 100) + 1), realizedWeekInr: 0, equityDrawdownPct: null });
    expect(v.newEntriesAllowed).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/daily loss limit/);
  });

  test("max open positions blocks new entries", () => {
    const v = assessPortfolioRisk({
      budgetInr: 100_000,
      openPositions: Array.from({ length: RISK_LIMITS.maxOpenPositions }, () => ({ lossAtStop: 100, sector: "X" })),
      realizedTodayInr: 0,
      realizedWeekInr: 0,
      equityDrawdownPct: null,
    });
    expect(v.newEntriesAllowed).toBe(false);
  });
});

describe("transaction costs + slippage", () => {
  test("round trip includes STT both legs and DP charge (versioned schedule)", () => {
    const pct = roundTripCostPct(100_000);
    expect(pct).toBeGreaterThan(0.2); // 0.1+0.1 STT alone
    expect(pct).toBeLessThan(0.5);
  });

  test("illiquid + volatile ⇒ higher slippage; floor at 0.1%", () => {
    const thin = estimateSlippagePct({ atrPct: 5, relVolume: 0.4, orderValueInr: 100_000, advInr: 5_000_000 });
    const thick = estimateSlippagePct({ atrPct: 1.5, relVolume: 2, orderValueInr: 100_000, advInr: 1e9 });
    expect(thin).toBeGreaterThan(thick);
    expect(thick).toBeGreaterThanOrEqual(0.1);
  });
});

describe("BHEL generalized regression (S13) — late trend / weak participation", () => {
  test("extended + weak volume + fading momentum ⇒ LATE_TREND, never an entry-ready setup", () => {
    const f = feats({
      distSma20Pct: 1.0,
      distSma200Pct: 26,
      week52Pct: 92,
      r20: 0.18,
      r5: -0.01,
      relVolume: 0.5,
      rsi14: 55,
    });
    const setup = classifySetup(f, { marketRegime: "bear_low_vol", stockRegime: "healthy_uptrend", upcomingEventRisk: false });
    expect(setup.setupType).toBe("LATE_TREND");
    expect(setup.setupScore).toBeLessThan(45);
  });

  test("price > SMA200 alone is NOT a setup", () => {
    const f = feats({ distSma200Pct: 15, r20: 0.01, r5: 0.001, drawdownFrom20dHighPct: -1, rsi14: 62, adx14: 12, relNifty20: 0 });
    const setup = classifySetup(f, { marketRegime: null, stockRegime: null, upcomingEventRisk: false });
    expect(setup.setupType).toBe("NO_SETUP");
  });

  test("imminent event blocks everything", () => {
    const f = feats({});
    const setup = classifySetup(f, { marketRegime: null, stockRegime: null, upcomingEventRisk: true });
    expect(setup.setupType).toBe("HIGH_EVENT_RISK");
    expect(setup.setupScore).toBe(0);
  });
});

describe("gates — fewer than five is the honest default", () => {
  const passingSetup = { setupType: "PULLBACK_IN_UPTREND" as const, setupScore: 60, reasons: [] };
  const plan = {
    entryType: "PULLBACK_ZONE" as const,
    entryZoneLow: 415,
    entryZoneHigh: 425,
    entryTrigger: "zone",
    entryTriggerPrice: null,
    entryTriggerRelVolume: null,
    invalidationPrice: 405,
    invalidationReason: "stop",
    initialStop: 405,
    stopBasis: "1.5 ATR",
    target1: 440,
    target2: 450,
    target3: null,
    targetBasis: "ATR",
    expectedHoldingDays: 7,
    rewardRiskToTarget1: 1.6, // ≥ GATE_THRESHOLDS.minRewardRisk1 (1.5, Varsity 18.6) so this fixture isolates OTHER gates
    rewardRiskToTarget2: 2,
    atr14: 10,
    annualVolPct: 30,
    advInr: 500_000_000,
    estimatedSlippagePct: 0.2,
    transactionCostPct: 0.26,
    expectedValueAfterCostsPct: 0.6,
    expectedShortfallPct: -4,
  };
  const forecast = {
    expectedExcessReturnPct: 0.5,
    p10Pct: -5,
    p50Pct: 1,
    p90Pct: 7,
    probabilityTargetBeforeStop: null,
    probabilityStatement: "Target-vs-stop probability unavailable — insufficient calibrated evidence.",
    expectedHoldingDays: 7,
    modelConfidence: "LOW" as const,
    modelConfidenceReasons: [],
    setupSampleSize: null,
    modelVersion: "short-term-v1",
  };

  test("a SUSPENDED model fails the gate regardless of setup quality", () => {
    const g = evaluateGates({ features: feats({}), setup: passingSetup, plan, forecast, barAgeDays: 1, dataQuality: 90, modelHealthState: "SUSPENDED", minAdvInr: null, riskAllowed: true });
    expect(g.passed).toBe(false);
    expect(g.failures.map((f) => f.gate)).toContain("model health");
  });

  test("negative EV after costs fails; stale bars fail; illiquid fails", () => {
    const gEv = evaluateGates({ features: feats({}), setup: passingSetup, plan: { ...plan, expectedValueAfterCostsPct: -0.1 }, forecast, barAgeDays: 1, dataQuality: 90, modelHealthState: "HEALTHY", minAdvInr: null, riskAllowed: true });
    expect(gEv.passed).toBe(false);
    const gStale = evaluateGates({ features: feats({}), setup: passingSetup, plan, forecast, barAgeDays: GATE_THRESHOLDS.maxBarAgeDays + 1, dataQuality: 90, modelHealthState: "HEALTHY", minAdvInr: null, riskAllowed: true });
    expect(gStale.passed).toBe(false);
    const gThin = evaluateGates({ features: feats({ advInr20: 1_000_000 }), setup: passingSetup, plan, forecast, barAgeDays: 1, dataQuality: 90, modelHealthState: "HEALTHY", minAdvInr: null, riskAllowed: true });
    expect(gThin.passed).toBe(false);
  });

  test("risk-manager lockout blocks entries (kill switch)", () => {
    const g = evaluateGates({ features: feats({}), setup: passingSetup, plan, forecast, barAgeDays: 1, dataQuality: 90, modelHealthState: "HEALTHY", minAdvInr: null, riskAllowed: false });
    expect(g.passed).toBe(false);
    expect(g.failures.map((f) => f.gate)).toContain("portfolio risk");
  });
});

describe("exit engine", () => {
  const base = {
    entryPrice: 420,
    initialStop: 410,
    currentStop: 410,
    target1: 435,
    target2: 445,
    daysHeld: 3,
    maxHoldingDays: 10,
    lastClose: 425,
    atr14: 10,
    target1Reached: false,
    features: feats({}),
    marketRegime: "bull_low_vol",
    newAdverseEvent: false,
    modelHealthState: "HEALTHY",
    forecastDriftState: "NORMAL",
  };

  test("stop breach ⇒ EXIT_FULL, no renegotiation", () => {
    expect(assessExit({ ...base, lastClose: 409 }).state).toBe("EXIT_FULL");
  });

  test("T1 reached ⇒ partial + stop to breakeven; then trailing raises the stop only upward", () => {
    const t1 = assessExit({ ...base, lastClose: 436 });
    expect(t1.state).toBe("TAKE_PARTIAL_PROFIT");
    expect(t1.currentStop).toBe(420);
    const trail = assessExit({ ...base, target1Reached: true, currentStop: 420, lastClose: 444 });
    expect(trail.state).toBe("TRAIL_STOP");
    expect(trail.currentStop).toBeGreaterThan(420);
    const noLower = assessExit({ ...base, target1Reached: true, currentStop: 435, lastClose: 437 });
    expect(noLower.currentStop).toBe(435); // trail never lowers
  });

  test("time stop and adverse event exits", () => {
    expect(assessExit({ ...base, daysHeld: 10 }).state).toBe("TIME_EXIT");
    expect(assessExit({ ...base, newAdverseEvent: true }).state).toBe("EVENT_RISK_EXIT");
  });

  test("hostile market regime invalidates the thesis", () => {
    expect(assessExit({ ...base, marketRegime: "bear_high_vol" }).state).toBe("THESIS_INVALIDATED");
  });
});

describe("data freshness honesty (S2)", () => {
  test("provider never claims LIVE outside an open session", async () => {
    const p = new YahooLiveProvider();
    const status = await p.getMarketStatus();
    const f = await p.getDataFreshness(new Date().toISOString());
    if (status.session !== "OPEN") expect(f.state).not.toBe("LIVE");
    expect(f.providerNote).toMatch(/delayed/i);
  });

  test("null timestamp ⇒ STALE", async () => {
    const p = new YahooLiveProvider();
    const f = await p.getDataFreshness(null);
    expect(f.state).toBe("STALE");
  });
});
