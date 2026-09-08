/**
 * Short-Term V2 tests — the qualification-integrity guarantees. The headline
 * assertion (FINAL ACCEPTANCE TEST): the unvalidated-setup + LOW-confidence +
 * no-live-authority combination can NEVER reach ENTRY_CONFIRMED.
 */

import { actionRank, capAction, composeCeiling, tierCeiling } from "../src/services/shortterm/actionStates";
import { computeEvEvidence, evGatePasses } from "../src/services/shortterm/evUncertainty";
import { tierFromEvidence, SETUP_PROMOTION } from "../src/services/shortterm/setupEvidence";
import { computeTier } from "../src/services/shortterm/tiers";
import { shrinkToward, hierarchicalShrink, benjaminiHochberg } from "../src/services/shortterm/shrinkage";
import { assessGap } from "../src/services/shortterm/gapPolicy";
import { assessLevels } from "../src/services/shortterm/plausibility";
import { detectContradictions } from "../src/services/shortterm/contradictions";
import { assessConfirmation } from "../src/services/shortterm/confirmation";
import { classifySetup } from "../src/services/shortterm/setups";
import { localCritic } from "../src/services/shortterm/riskCritic";
import { assessShortTermHealth } from "../src/services/shortterm/shortTermHealth";
import { ShortTermFeatures } from "../src/services/shortterm/features";
import { mulberry32 } from "../src/services/quant/montecarlo";

function returns(mu: number, sd: number, n: number, seed = 3): number[] {
  const rand = mulberry32(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    // Box–Muller
    const u1 = Math.max(1e-9, rand());
    const u2 = rand();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    out.push(mu + sd * z);
  }
  return out;
}

const setupEvidence = (over: Partial<Parameters<typeof computeTier>[0]["setupEvidence"]> = {}) =>
  ({
    setupType: "MEAN_REVERSION",
    horizon: "5-10d",
    regime: null,
    rawTrades: 0,
    independentEntryDates: 0,
    targetFirstRate: 0,
    stopFirstRate: 0,
    timeoutRate: 0,
    averageR: 0,
    medianR: 0,
    averageWinR: 0,
    averageLossR: 0,
    expectancyR: 0,
    expectancyAfterCosts: 0,
    profitFactor: null,
    maxDrawdownR: 0,
    bootstrapExpectancyCI: [0, 0] as [number, number],
    probabilityExpectancyPositive: 0,
    bhSignificant: false,
    evidenceStrength: "D" as const,
    usableForEntry: false,
    note: "unvalidated",
    ...over,
  }) as Parameters<typeof computeTier>[0]["setupEvidence"];

describe("action ladder + ceilings", () => {
  test("ZONE_REACHED ranks strictly below ENTRY_CONFIRMED", () => {
    expect(actionRank("ZONE_REACHED")).toBeLessThan(actionRank("ENTRY_CONFIRMED"));
    expect(capAction("ENTRY_CONFIRMED", "WAIT_FOR_CONFIRMATION")).toBe("WAIT_FOR_CONFIRMATION");
  });

  test("tier ceilings: A→ENTRY_CONFIRMED, B→WAIT, C→RESEARCH_WATCH, D→NO_TRADE", () => {
    expect(tierCeiling("A")).toBe("ENTRY_CONFIRMED");
    expect(tierCeiling("B")).toBe("WAIT_FOR_CONFIRMATION");
    expect(tierCeiling("C")).toBe("RESEARCH_WATCH");
    expect(tierCeiling("D")).toBe("NO_TRADE");
  });

  test("FINAL ACCEPTANCE: unvalidated + LOW + SHADOW + no calibrated prob ⇒ never ENTRY_CONFIRMED", () => {
    const r = composeCeiling({
      tier: "C",
      modelHealthState: "SHADOW",
      modelConfidence: "LOW",
      freshness: "EOD_FINAL",
      confirmationSatisfied: true, // even if confirmed
      evLowerBoundPositive: false,
      affordable: true,
      contradictionCeilings: [],
    });
    expect(r.ceiling).not.toBe("ENTRY_CONFIRMED");
    expect(actionRank(r.ceiling)).toBeLessThanOrEqual(actionRank("RESEARCH_WATCH"));
  });

  test("INSUFFICIENT_HISTORY caps at WAIT_FOR_CONFIRMATION; SUSPENDED caps at NO_TRADE", () => {
    const insuff = composeCeiling({ tier: "A", modelHealthState: "INSUFFICIENT_HISTORY", modelConfidence: "HIGH", freshness: "EOD_FINAL", confirmationSatisfied: true, evLowerBoundPositive: true, affordable: true, contradictionCeilings: [] });
    expect(insuff.ceiling).toBe("WAIT_FOR_CONFIRMATION");
    const susp = composeCeiling({ tier: "A", modelHealthState: "SUSPENDED", modelConfidence: "HIGH", freshness: "EOD_FINAL", confirmationSatisfied: true, evLowerBoundPositive: true, affordable: true, contradictionCeilings: [] });
    expect(susp.ceiling).toBe("NO_TRADE");
  });

  test("DELAYED_INTRADAY cannot reach ENTRY_CONFIRMED; a fully-clean tier-A HEALTHY case can", () => {
    const delayed = composeCeiling({ tier: "A", modelHealthState: "HEALTHY", modelConfidence: "HIGH", freshness: "DELAYED_INTRADAY", confirmationSatisfied: true, evLowerBoundPositive: true, affordable: true, contradictionCeilings: [] });
    expect(delayed.ceiling).toBe("WAIT_FOR_CONFIRMATION");
    const clean = composeCeiling({ tier: "A", modelHealthState: "HEALTHY", modelConfidence: "HIGH", freshness: "EOD_FINAL", confirmationSatisfied: true, evLowerBoundPositive: true, affordable: true, contradictionCeilings: [] });
    expect(clean.ceiling).toBe("ENTRY_CONFIRMED");
  });

  test("position size 0 (unaffordable) caps at RESEARCH_WATCH", () => {
    const r = composeCeiling({ tier: "A", modelHealthState: "HEALTHY", modelConfidence: "HIGH", freshness: "EOD_FINAL", confirmationSatisfied: true, evLowerBoundPositive: true, affordable: false, contradictionCeilings: [] });
    expect(r.ceiling).toBe("RESEARCH_WATCH");
  });
});

describe("setup evidence tiers", () => {
  test("negative after-cost expectancy ⇒ tier C, not usable (the pre-V2 mean-reversion snapshot)", () => {
    const t = tierFromEvidence(setupEvidence({ rawTrades: 500, independentEntryDates: 200, expectancyAfterCosts: -0.05, bootstrapExpectancyCI: [-0.12, 0.02], probabilityExpectancyPositive: 0.3 }) as never);
    expect(t.tier).toBe("C");
    expect(t.usable).toBe(false);
  });

  test("strong validated expectancy ⇒ tier A usable", () => {
    const t = tierFromEvidence(setupEvidence({ rawTrades: 600, independentEntryDates: SETUP_PROMOTION.minIndependentDates + 10, expectancyAfterCosts: 0.15, bootstrapExpectancyCI: [0.04, 0.26], probabilityExpectancyPositive: 0.99, bhSignificant: true }) as never);
    expect(t.tier).toBe("A");
    expect(t.usable).toBe(true);
  });

  test("positive but not decisive ⇒ tier B, not usable", () => {
    const t = tierFromEvidence(setupEvidence({ rawTrades: 600, independentEntryDates: 100, expectancyAfterCosts: 0.05, bootstrapExpectancyCI: [-0.01, 0.11], probabilityExpectancyPositive: 0.8 }) as never);
    expect(t.tier).toBe("B");
    expect(t.usable).toBe(false);
  });
});

describe("EV uncertainty", () => {
  test("favorable series ⇒ positive EV lower bound (gate passes)", () => {
    const e = computeEvEvidence({ dailyReturns: returns(0.004, 0.012, 250), entry: 100, stop: 96, target1: 108, maxHoldDays: 10, costPct: 0.26, slippagePct: 0.2 });
    expect(e).not.toBeNull();
    expect(e!.expectedR).toBeGreaterThan(0);
  });

  test("adverse/noisy series ⇒ EV lower bound ≤ 0 (gate fails) — the 8-Sep case", () => {
    const e = computeEvEvidence({ dailyReturns: returns(-0.001, 0.02, 250, 9), entry: 100, stop: 98, target1: 104, maxHoldDays: 10, costPct: 0.26, slippagePct: 0.3 });
    expect(e).not.toBeNull();
    expect(evGatePasses(e).ok).toBe(false);
  });

  test("insufficient history ⇒ null ⇒ gate fails", () => {
    expect(computeEvEvidence({ dailyReturns: returns(0.001, 0.01, 30), entry: 100, stop: 96, target1: 108, maxHoldDays: 10, costPct: 0.26, slippagePct: 0.2 })).toBeNull();
    expect(evGatePasses(null).ok).toBe(false);
  });
});

describe("computeTier caps", () => {
  const plaus = assessLevels({ entry: 100, stop: 96, target1: 106, atr14: 3, ev: null, gapPctRecent: 0 });
  test("EV-gate failure caps a tier-A setup down to C", () => {
    const r = computeTier({ setupEvidence: setupEvidence({ evidenceStrength: "A", usableForEntry: true }), ev: null, plausibility: plaus, shortTermHealthState: "HEALTHY", dataQuality: 90 });
    expect(r.tier).toBe("C");
  });
  test("SUSPENDED short-term health ⇒ tier D", () => {
    const good = computeEvEvidence({ dailyReturns: returns(0.004, 0.012, 250), entry: 100, stop: 96, target1: 108, maxHoldDays: 10, costPct: 0.26, slippagePct: 0.2 });
    const r = computeTier({ setupEvidence: setupEvidence({ evidenceStrength: "A", usableForEntry: true }), ev: good, plausibility: plaus, shortTermHealthState: "SUSPENDED", dataQuality: 90 });
    expect(r.tier).toBe("D");
  });
});

describe("shrinkage + multiple testing", () => {
  test("tiny sample shrinks toward the prior; large sample keeps its own signal", () => {
    const tiny = shrinkToward(0.9, 5, 0.5, 25);
    const big = shrinkToward(0.9, 500, 0.5, 25);
    expect(Math.abs(tiny.shrunkEstimate - 0.5)).toBeLessThan(Math.abs(0.9 - 0.5));
    expect(tiny.shrunkEstimate).toBeLessThan(big.shrunkEstimate);
    expect(big.shrunkEstimate).toBeGreaterThan(0.8);
  });
  test("hierarchical shrink falls back to global when stock+sector are thin", () => {
    const r = hierarchicalShrink({ stock: { estimate: 0.9, n: 3 }, sector: { estimate: 0.8, n: 4 }, global: { estimate: 0.5, n: 5000 }, minCellN: 15 });
    expect(r.level).toBe("global");
    expect(r.shrunkEstimate).toBe(0.5);
  });
  test("Benjamini–Hochberg flags fewer than raw p<0.05 under many tests", () => {
    const ps = [0.001, 0.01, 0.03, 0.2, 0.4, 0.6, 0.8, 0.9];
    const bh = benjaminiHochberg(ps, 0.1);
    expect(bh[0].significant).toBe(true);
    expect(bh[4].significant).toBe(false);
    expect(bh.every((x) => x.adjusted >= x.pValue)).toBe(true);
  });
});

describe("gap policy", () => {
  const base = { entryZoneLow: 100, entryZoneHigh: 103, initialStop: 96, target1: 112, atr14: 4, entryType: "PULLBACK_ZONE" };
  test("gap through the stop ⇒ INVALIDATED", () => expect(assessGap({ ...base, referencePrice: 95 }).decision).toBe("INVALIDATED"));
  test("in-zone ⇒ PROCEED", () => expect(assessGap({ ...base, referencePrice: 101 }).decision).toBe("PROCEED"));
  test("gap far above the zone ⇒ DO_NOT_CHASE", () => expect(assessGap({ ...base, referencePrice: 106 }).decision).toBe("DO_NOT_CHASE"));
  test("gap far below the zone ⇒ RECOMPUTE", () => expect(assessGap({ ...base, referencePrice: 97.5 }).decision).toBe("RECOMPUTE"));
  test("open most of the way to T1 ⇒ INVALIDATED as a new entry", () => expect(assessGap({ ...base, referencePrice: 110 }).decision).toBe("INVALIDATED"));
});

describe("plausibility", () => {
  test("stop inside 1 ATR is flagged noise-prone (not structural)", () => {
    const r = assessLevels({ entry: 100, stop: 98, target1: 106, atr14: 4, ev: null, gapPctRecent: 0 });
    expect(r.stopStructural).toBe(false);
    expect(r.qualityPenalty).toBeGreaterThan(0);
  });
  test("rarely-reached target lowers quality", () => {
    const ev = { targetReachRate: 0.05, stopHitRate: 0.6 } as never;
    const r = assessLevels({ entry: 100, stop: 92, target1: 140, atr14: 4, ev, gapPctRecent: 0 });
    expect(r.targetPlausible).toBe(false);
    expect(r.qualityPenalty).toBeGreaterThan(0);
  });
});

describe("contradictions + confirmation + critic", () => {
  test("in-zone + LOW confidence + unvalidated setup ⇒ contradictions that cap below entry", () => {
    const cs = detectContradictions({
      geometryAction: "ZONE_REACHED",
      tier: "C",
      modelConfidence: "LOW",
      modelHealthState: "SHADOW",
      freshness: "EOD_FINAL",
      ev: { meanEvAfterCostsPct: 0.5, ev80LowerPct: -0.5 } as never,
      setupEvidence: setupEvidence({ rawTrades: 100, expectancyAfterCosts: -0.05 }),
      positionSizeShares: 10,
      rankingScore: 5,
    });
    expect(cs.length).toBeGreaterThan(0);
    expect(cs.some((c) => c.code === "ZONE_LOW_CONF")).toBe(true);
    expect(cs.some((c) => c.code === "EV_POS_MEAN_NEG_LOWER")).toBe(true);
  });

  test("mean-reversion confirmation is unmet when RSI is still deeply oversold (not recovering)", () => {
    const f = { rsi14: 22, sma20: 100, price: 96, relVolume: 0.5, relNifty5: -0.03 } as ShortTermFeatures;
    const r = assessConfirmation("MEAN_REVERSION", f, { marketRegimeOk: true, upcomingEventRisk: false, freshDataOk: true });
    expect(r.satisfied).toBe(false);
    expect(r.unmet.length).toBeGreaterThan(0);
  });

  test("local risk critic never proposes above the deterministic ceiling", () => {
    const r = localCritic({
      ticker: "X.NS",
      deterministicCeiling: "WAIT_FOR_CONFIRMATION",
      tier: "C",
      modelConfidence: "LOW",
      modelHealthState: "SHADOW",
      freshness: "EOD_FINAL",
      contradictions: [{ code: "ZONE_LOW_CONF", message: "low conf", cap: "WAIT_FOR_CONFIRMATION" }],
      ev: null,
      setupEvidence: { note: "unvalidated" },
      plan: {},
      sizing: null,
    });
    expect(actionRank(r.actionCap)).toBeLessThanOrEqual(actionRank("WAIT_FOR_CONFIRMATION"));
  });
});

describe("short-term live authority", () => {
  test("backtest-usable but zero resolved shadow trades ⇒ SHADOW (not HEALTHY)", () => {
    expect(assessShortTermHealth({ backtestUsableForEntry: true, resolvedShadowTrades: 0, distinctShadowDates: 0, liveExpectancyR: null }).state).toBe("SHADOW");
  });
  test("enough independent shadow trades with positive live expectancy ⇒ HEALTHY", () => {
    expect(assessShortTermHealth({ backtestUsableForEntry: true, resolvedShadowTrades: 40, distinctShadowDates: 25, liveExpectancyR: 0.12 }).state).toBe("HEALTHY");
  });
});

describe("ranking-cliff fix", () => {
  test("mean-reversion setup score VARIES with pattern strength (no fixed 45)", () => {
    const mk = (over: Partial<ShortTermFeatures>): ShortTermFeatures =>
      ({ price: 100, sma50: 110, sma200: 90, rsi14: 27, drawdownFrom20dHighPct: -10, supportDistPct: 2, relNifty5: 0, relVolume: 1, distSma20Pct: 0, week52Pct: 40, r20: 0, r5: 0, atrPct: 2, ...over } as ShortTermFeatures);
    const weak = classifySetup(mk({ rsi14: 29, supportDistPct: 3.5, relNifty5: -0.02, relVolume: 0.5 }), { marketRegime: null, stockRegime: null, upcomingEventRisk: false });
    const strong = classifySetup(mk({ rsi14: 22, supportDistPct: 1, relNifty5: 0.01, relVolume: 1.2 }), { marketRegime: null, stockRegime: null, upcomingEventRisk: false });
    expect(weak.setupType).toBe("MEAN_REVERSION");
    expect(strong.setupType).toBe("MEAN_REVERSION");
    expect(strong.setupScore).not.toBe(weak.setupScore);
    expect(strong.setupScore).toBeGreaterThan(weak.setupScore);
    expect(weak.setupScore).not.toBe(45); // the old cliff value
  });
});
