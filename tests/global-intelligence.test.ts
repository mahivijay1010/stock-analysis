/**
 * Global Market Intelligence: timezone/session handling, freshness, the India
 * leakage rule, regime classification, relationship studies, transmission,
 * sector sensitivity, risk adjustment, Money Desk integration, snapshot
 * immutability (migration contract). No network, no database.
 */
import { closedBeforeCutoff, GLOBAL_UNIVERSE, instrumentByKey, localToUtc, marketStatusAt, observationFreshness, partsIn, usableSessionFor } from "../src/services/global/globalUniverse";
import { classifyGlobalRegime, ObsLite, REGIME_RULES } from "../src/services/global/globalRegime";
import { compositeSeries, DailySeries, driverChange, MIN_SHOCK_N, sectorSensitivity, shockStudy, transmissionFromActiveShocks, usableIndex } from "../src/services/global/globalRelationships";
import { macroRiskAdjustment, GLOBAL_RISK_POLICY, resolveRiskProfile } from "../src/services/capital/riskProfiles";
import { buildCapitalPlan } from "../src/services/capital/capitalAllocation";
import { CapitalCandidateInput, GlobalContextInput, MarketContextInput } from "../src/services/capital/types";
import { CreateGlobalMarketIntelligence1791100000000 } from "../src/migrations/1791100000000-CreateGlobalMarketIntelligence";
import { GlobalMarketDataService } from "../src/services/global/GlobalMarketDataService";

const SPX = instrumentByKey("SPX")!, NKY = instrumentByKey("NKY")!, NIFTY = instrumentByKey("NIFTY")!, BRENT = instrumentByKey("BRENT")!;

describe("timezones and sessions", () => {
  test("local close → UTC is DST-correct (NYSE 16:00 ET = 20:00Z in October, 21:00Z in January)", () => {
    expect(localToUtc("America/New_York", "2026-10-07", "16:00").toISOString()).toBe("2026-10-07T20:00:00.000Z");
    expect(localToUtc("America/New_York", "2026-01-07", "16:00").toISOString()).toBe("2026-01-07T21:00:00.000Z");
    expect(localToUtc("Asia/Kolkata", "2026-10-07", "15:30").toISOString()).toBe("2026-10-07T10:00:00.000Z");
    expect(localToUtc("Asia/Tokyo", "2026-10-07", "15:30").toISOString()).toBe("2026-10-07T06:30:00.000Z");
  });
  test("market status from the local clock", () => {
    const t = new Date("2026-10-07T14:00:00Z"); // 10:00 ET Wed, 19:30 IST, 23:00 JST
    expect(marketStatusAt(SPX, t)).toBe("OPEN");
    expect(marketStatusAt(NIFTY, t)).toBe("CLOSED");
    expect(marketStatusAt(NKY, t)).toBe("CLOSED");
    expect(marketStatusAt(SPX, new Date("2026-10-10T14:00:00Z"))).toBe("WEEKEND");
    expect(marketStatusAt(BRENT, new Date("2026-10-07T03:00:00Z"))).toBe("OPEN");
    expect(partsIn("Asia/Kolkata", t).hhmm).toBe("19:30");
  });
  test("freshness: a session is FRESH within a day, DELAYED within four, STALE after", () => {
    expect(observationFreshness(SPX, "2026-10-07", new Date("2026-10-08T03:00:00Z"))).toBe("FRESH");
    expect(observationFreshness(SPX, "2026-10-05", new Date("2026-10-08T03:00:00Z"))).toBe("DELAYED");
    expect(observationFreshness(SPX, "2026-09-25", new Date("2026-10-08T03:00:00Z"))).toBe("STALE");
  });
  test("INDIA LEAKAGE RULE: a US session on T is NOT usable for India's close on T; Asia's session on T is", () => {
    const sessions = ["2026-10-05", "2026-10-06", "2026-10-07"];
    expect(usableSessionFor(SPX, "2026-10-07", sessions)).toBe("2026-10-06");
    expect(usableSessionFor(NKY, "2026-10-07", sessions)).toBe("2026-10-07");
    expect(usableSessionFor(BRENT, "2026-10-07", sessions)).toBe("2026-10-06");
    const indiaClose = localToUtc("Asia/Kolkata", "2026-10-07", "15:30");
    expect(closedBeforeCutoff(SPX, "2026-10-07", indiaClose)).toBe(false); // closes 20:00Z, after 10:00Z
    expect(closedBeforeCutoff(SPX, "2026-10-06", indiaClose)).toBe(true);
    expect(closedBeforeCutoff(NKY, "2026-10-07", indiaClose)).toBe(true); // 06:30Z
  });
  test("every configured instrument has a timezone and close; unsourced ones are tracked, not invented", () => {
    for (const i of GLOBAL_UNIVERSE) {
      expect(i.tz).toMatch(/\//);
      expect(i.localClose).toMatch(/^\d{2}:\d{2}$/);
    }
    expect(GLOBAL_UNIVERSE.filter((i) => i.yahoo == null).map((i) => i.key)).toEqual(expect.arrayContaining(["TOPIX", "CSI300", "USDCNH", "DE10Y", "FR10Y", "HY_OAS"]));
  });
  test("observations drop the partial bar while a market is OPEN", () => {
    const svc = new GlobalMarketDataService();
    const bars = Array.from({ length: 30 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, "0")}`, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1000 }));
    const duringOpen = new Date("2026-09-30T15:00:00Z"); // 11:00 ET on the 30th → the 30th bar is partial
    const o = svc.observationFromBars(SPX, bars, duringOpen)!;
    expect(o.sessionDate).toBe("2026-09-29");
    expect(o.marketStatus).toBe("OPEN");
    const afterClose = new Date("2026-09-30T22:00:00Z");
    expect(svc.observationFromBars(SPX, bars, afterClose)!.sessionDate).toBe("2026-09-30");
  });
});

const obs = (over: Partial<ObsLite> & { key: string }): ObsLite => ({ assetClass: "EQUITY", region: "US", sessionDate: "2026-10-07", price: 100, ret1d: 0, ret5d: 0, ret20d: 0, vol20: 15, freshness: "FRESH", ...over });
const calmSet = (): ObsLite[] => [
  ...["SPX", "NDX", "DJI", "RUT", "STOXX600", "DAX", "FTSE", "CAC", "SX5E", "NKY", "HSI", "SHCOMP", "KOSPI", "TWSE", "ASX"].map((k) => obs({ key: k, ret20d: 4 })),
  obs({ key: "VIX", assetClass: "VOLATILITY", price: 13, ret5d: -2 }),
  obs({ key: "US10Y", assetClass: "RATES", price: 4.1, isYield: true, chg5bps: 2, chg20bps: 5 }),
  obs({ key: "US3M", assetClass: "RATES", price: 3.9, isYield: true, chg5bps: 0 }),
  obs({ key: "DXY", assetClass: "FX", price: 100, ret5d: -0.3 }),
  obs({ key: "BRENT", assetClass: "COMMODITY", region: "GLOBAL", price: 70, ret5d: -1 }),
  obs({ key: "COPPER", assetClass: "COMMODITY", region: "GLOBAL", price: 4, ret20d: 2 }),
];

describe("global regime classification", () => {
  test("calm, rising markets → RISK_ON with every component explained", () => {
    const r = classifyGlobalRegime(calmSet());
    expect(r.regime).toBe("RISK_ON");
    expect(r.components.map((c) => c.name)).toEqual(["EquityTrend", "EquityBreadth", "Volatility", "Rates", "Dollar", "Commodities", "Credit", "CrossAssetStress"]);
    expect(r.components.find((c) => c.name === "Credit")!.covered).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/not covered: .*HY_OAS/);
    expect(r.rules).toBe(REGIME_RULES);
  });
  test("VIX ≥ 35 alone forces STRESSED; four hostile components force STRESSED", () => {
    const s = calmSet().map((o) => (o.key === "VIX" ? { ...o, price: 36 } : o));
    expect(classifyGlobalRegime(s).regime).toBe("STRESSED");
    const hostile = calmSet().map((o) => (["SPX", "NDX", "DJI", "RUT", "STOXX600", "DAX", "FTSE", "CAC", "SX5E", "NKY", "HSI", "SHCOMP", "KOSPI", "TWSE", "ASX"].includes(o.key) ? { ...o, ret20d: -9 } : o.key === "US10Y" ? { ...o, chg5bps: 30 } : o.key === "DXY" ? { ...o, ret5d: 2 } : o));
    expect(classifyGlobalRegime(hostile).regime).toBe("STRESSED");
  });
  test("mildly negative tape → CAUTIOUS; broadly negative → RISK_OFF; stale inputs are excluded from coverage", () => {
    const cautious = calmSet().map((o) => (["SPX", "NDX", "DJI", "RUT"].includes(o.key) ? { ...o, ret20d: -1 } : o.key === "VIX" ? { ...o, price: 24, ret5d: 35 } : o.key === "DXY" ? { ...o, ret5d: 1 } : o.key === "BRENT" ? { ...o, ret5d: 4 } : o));
    const c = classifyGlobalRegime(cautious);
    expect(["CAUTIOUS", "NEUTRAL"]).toContain(c.regime);
    const off = calmSet().map((o) => (o.assetClass === "EQUITY" ? { ...o, ret20d: -5 } : o.key === "VIX" ? { ...o, price: 30 } : o.key === "DXY" ? { ...o, ret5d: 2 } : o.key === "BRENT" ? { ...o, ret5d: 9 } : o));
    expect(["RISK_OFF", "STRESSED"]).toContain(classifyGlobalRegime(off).regime);
    const stale = calmSet().map((o) => (o.key === "VIX" ? { ...o, freshness: "STALE" as const } : o));
    const r = classifyGlobalRegime(stale);
    expect(r.components.find((c) => c.name === "Volatility")!.covered).toBe(false);
    expect(r.dataCoverage.stale).toBe(1);
  });
  test("missing global data → components uncovered, regime still computable from what exists", () => {
    const r = classifyGlobalRegime([obs({ key: "SPX", ret20d: 2 }), obs({ key: "NDX", ret20d: 2 })]);
    expect(r.components.find((c) => c.name === "EquityTrend")!.covered).toBe(false);
    expect(r.regime).toBeDefined();
  });
});

function series(key: string, n: number, sameDayUsable: boolean, fn: (i: number) => number, isYield = false): DailySeries {
  return { key, sameDayUsable, isYield, points: Array.from({ length: n }, (_, i) => ({ date: new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10), value: fn(i) })) };
}

describe("relationship studies", () => {
  test("driver change is % for prices and bps for yields; usable index respects the leakage rule", () => {
    const px = series("DXY", 10, false, (i) => 100 + i);
    expect(driverChange(px, 9, 5)).toBeCloseTo(((109 - 104) / 104) * 100, 6);
    const y = series("US10Y", 10, false, (i) => 4 + i * 0.01, true);
    expect(driverChange(y, 9, 5)).toBeCloseTo(5, 6);
    expect(usableIndex(px, px.points[5].date)).toBe(4); // US: strictly before
    expect(usableIndex(series("NKY", 10, true, (i) => i), px.points[5].date)).toBe(5); // Asia: same day
  });
  test("FUTURE LEAKAGE: forward returns never use target points before/at the trigger; a shock on the last day has no forward observation", () => {
    const driver = series("SPX", 60, false, (i) => (i === 58 ? 90 : 100));
    const target = series("NIFTY", 60, true, (i) => 1000 + i);
    const res = shockStudy({ driver: "SPX", label: "SPX down", window: 5, threshold: 3, direction: "DOWN" }, driver, target, [1, 5]);
    // The drop happens at driver index 58, usable for India index 59 (strictly after); 1-session forward from 59 does not exist → n=0.
    expect(res.find((r) => r.horizon === 1)!.n).toBe(0);
  });
  test("shock study de-overlaps triggers, computes stats and benchmark, withholds below MIN_SHOCK_N", () => {
    // Every 10 sessions the driver drops 5% then recovers; target drifts up.
    const driver = series("SPX", 400, false, (i) => (i % 10 === 7 ? 95 : 100));
    const target = series("NIFTY", 400, true, (i) => 1000 * Math.pow(1.0005, i));
    const res = shockStudy({ driver: "SPX", label: "SPX falls ≥ 3%", window: 5, threshold: 3, direction: "DOWN" }, driver, target);
    const h5 = res.find((r) => r.horizon === 5)!;
    expect(h5.n).toBeGreaterThanOrEqual(MIN_SHOCK_N);
    expect(h5.displayable).toBe(true);
    expect(h5.meanPct).toBeGreaterThan(0);
    expect(h5.winRatePct).toBe(100);
    expect(h5.wilsonLb95Pct).toBeLessThan(100);
    expect(h5.benchmarkN).toBeGreaterThan(0);
    expect(h5.dates.length).toBe(h5.n);
    const few = shockStudy({ driver: "SPX", label: "x", window: 5, threshold: 3, direction: "DOWN" }, series("SPX", 30, false, (i) => (i === 10 ? 95 : 100)), series("NIFTY", 30, true, (i) => 1000 + i));
    expect(few.find((r) => r.horizon === 5)!.displayable).toBe(false);
  });
  test("composite series equal-weights member returns", () => {
    const a = series("NKY", 5, true, (i) => 100 * (1 + 0.01 * i));
    const b = series("HSI", 5, true, (i) => 100);
    const c = compositeSeries("ASIA", [a, b], true);
    expect(c.points).toHaveLength(4);
    expect(c.points[0].value).toBeCloseTo(100 * (1 + 0.005), 6);
  });
  test("sector sensitivity: a target that responds to the driver's prior-week move with a lag shows positive beta/corr; short series withheld", () => {
    let x = 11;
    const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5) * 0.04;
    const dr: number[] = Array.from({ length: 600 }, () => rnd());
    const driver = series("NDX", 600, false, () => 0);
    let lvl = 100;
    driver.points.forEach((p, i) => { lvl *= 1 + dr[i]; p.value = lvl; });
    // target's return on day t equals the driver's return on day t−6: it responds to last week's driver move, after India could know it.
    const target = series("SEC_IT", 600, true, () => 0);
    let tl = 100;
    target.points.forEach((p, i) => { tl *= 1 + (i >= 6 ? dr[i - 6] : 0); p.value = tl; });
    const s = sectorSensitivity(driver, target, 5);
    expect(s.n).toBeGreaterThan(20);
    expect(s.displayable).toBe(true);
    expect(s.correlation).toBeGreaterThan(0.6);
    expect(s.beta).toBeGreaterThan(0.6);
    expect(sectorSensitivity(series("NDX", 30, false, (i) => 100 + i), series("SEC_IT", 30, true, (i) => 100 + i), 5).displayable).toBe(false);
  });
  test("transmission: no active shocks → NEUTRAL; active but undisplayable → NEUTRAL with the floor stated; negative evidence → HEADWIND", () => {
    const shock = { driver: "SPX", label: "SPX falls ≥ 3%", window: 5, threshold: 3, direction: "DOWN" as const };
    expect(transmissionFromActiveShocks([]).label).toBe("NEUTRAL");
    const thin = transmissionFromActiveShocks([{ shock, study: { driver: "SPX", shock: shock.label, target: "NIFTY", horizon: 5, n: 5, meanPct: -2, medianPct: -2, winRatePct: 20, wilsonLb95Pct: 5, volPct: 2, maxDrawdownPct: -3, benchmarkMeanPct: 0.3, benchmarkN: 100, displayable: false, dates: [], dataFrom: null, dataTo: null } }]);
    expect(thin.label).toBe("NEUTRAL");
    expect(thin.reasons[0]).toMatch(/≥ 20 historical observations/);
    const neg = transmissionFromActiveShocks([{ shock, study: { driver: "SPX", shock: shock.label, target: "NIFTY", horizon: 5, n: 40, meanPct: -1.5, medianPct: -1.1, winRatePct: 38, wilsonLb95Pct: 25, volPct: 2, maxDrawdownPct: -3, benchmarkMeanPct: 0.3, benchmarkN: 300, displayable: true, dates: [], dataFrom: null, dataTo: null } }]);
    expect(neg.label).toBe("HEADWIND");
    expect(neg.reasons[0]).toMatch(/n=40/);
  });
});

describe("global risk adjustment and Money Desk integration", () => {
  const g = (over: Partial<GlobalContextInput> = {}): GlobalContextInput => ({ regime: "RISK_OFF", regimeReasons: [], transmission: "HEADWIND", transmissionReasons: [], evidence: { n: 60, niftyMedian5dPct: -1.1, niftyWinRate5dPct: 41, unconditionalMedian5dPct: 0.4 }, sectorLabels: { "Information Technology": "HEADWIND" }, globalDataAsOf: "2026-10-07T20:00:00Z", indiaDataAsOf: "2026-10-07T10:00:00Z", ...over });
  test("no snapshot → multiplier 1; RISK_ON → 1; RISK_OFF with evidence → 0.5 × HEADWIND 0.85 and one fewer position", () => {
    expect(macroRiskAdjustment(null).multiplier).toBe(1);
    expect(macroRiskAdjustment(g({ regime: "RISK_ON", transmission: "NEUTRAL" })).multiplier).toBe(1);
    const d = macroRiskAdjustment(g());
    expect(d.multiplier).toBeCloseTo(GLOBAL_RISK_POLICY.multipliers.RISK_OFF * GLOBAL_RISK_POLICY.transmissionMultipliers.HEADWIND, 6);
    expect(d.maxPositionsDelta).toBe(-1);
    expect(d.evidenceBacked).toBe(true);
  });
  test("a hostile regime WITHOUT demonstrated evidence is context only (multiplier stays 1, reason stated)", () => {
    const d = macroRiskAdjustment(g({ evidence: { n: 8, niftyMedian5dPct: null, niftyWinRate5dPct: null, unconditionalMedian5dPct: 0.4 } }));
    expect(d.multiplier).toBe(1);
    expect(d.reasons[0]).toMatch(/context only/);
    expect(macroRiskAdjustment(g({ evidence: { n: 60, niftyMedian5dPct: 0.9, niftyWinRate5dPct: 60, unconditionalMedian5dPct: 0.4 } })).multiplier).toBe(1);
  });
  const qualified: CapitalCandidateInput = { ticker: "INFY.NS", name: "Infosys", sector: "Information Technology", currentPrice: 100, action: "ENTRY_CONFIRMED", tier: "A", qualified: true, modelHealth: "HEALTHY", freshnessV2: "EOD_FINAL", setupType: "PULLBACK_IN_UPTREND", rank: 1, rankingScore: 80, gateFailures: [], ceilingReasons: [], whyNotEntry: [], plan: { entryType: "PULLBACK_ZONE", entryZoneLow: 98, entryZoneHigh: 100, entryTriggerPrice: null, initialStop: 95, target1: 110, target2: null, target3: null, rewardRiskToTarget1: 2, expectedHoldingDays: 7, invalidationPrice: 94, invalidationReason: null, atr14: 2, advInr: 5e9, transactionCostPct: 0.3, estimatedSlippagePct: 0.2 }, ev: { ev80LowerPct: 0.4, meanEvAfterCostsPct: 1, expectedR: 0.3 }, setupEvidence: null, probability: { status: "UNCALIBRATED", targetBeforeStop: null }, relVolume: 1, tradeability: null, aiCapAction: null, evidenceScore: 70, decisionSnapshotId: null };
  const market = (global: GlobalContextInput | null): MarketContextInput => ({ regime: "TREND_UP", regimeReasons: [], breakerCanEnter: true, breakerReason: null, freshness: { quoteTimestamp: null, quoteType: "EOD_FINAL", marketState: "CLOSED", latestCompletedBarDate: "2026-10-07", providerDelay: "", featureCutoffAt: null }, global });
  test("a hostile global regime does NOT veto a qualified setup: it is allocated smaller and labelled 'elevated macro risk'", () => {
    const normal = buildCapitalPlan({ asOf: "2026-10-08T00:00:00Z", capitalAvailableInr: 100000, holdings: [], candidates: [qualified], market: market(null), profile: resolveRiskProfile("BALANCED"), horizon: "5-10d" });
    const hostile = buildCapitalPlan({ asOf: "2026-10-08T00:00:00Z", capitalAvailableInr: 100000, holdings: [], candidates: [qualified], market: market(g()), profile: resolveRiskProfile("BALANCED"), horizon: "5-10d" });
    expect(normal.allocations).toHaveLength(1);
    expect(hostile.allocations).toHaveLength(1);
    expect(hostile.allocations[0].recommendedAmountInr).toBeLessThan(normal.allocations[0].recommendedAmountInr);
    expect(hostile.allocations[0].environment).toMatchObject({ global: "HEADWIND", india: "TAILWIND", sector: "HEADWIND", setup: "PASS", label: "Qualified setup with elevated macro risk" });
    expect(hostile.global.macroRiskMultiplier).toBeLessThan(1);
    expect(hostile.maxPositions).toBe(normal.maxPositions - 1);
    expect(hostile.global.globalDataAsOf).toBe("2026-10-07T20:00:00Z");
  });
  test("STRESSED with evidence reduces to ×0.25 but still obeys the existing gates (a non-qualified setup stays rejected)", () => {
    const r = buildCapitalPlan({ asOf: "2026-10-08T00:00:00Z", capitalAvailableInr: 100000, holdings: [], candidates: [{ ...qualified, qualified: false, action: "WAIT_FOR_CONFIRMATION", tier: "B" }], market: market(g({ regime: "STRESSED", transmission: "STRESS" })), profile: resolveRiskProfile("AGGRESSIVE"), horizon: "5-10d" });
    expect(r.allocations).toHaveLength(0);
    expect(r.global.macroRiskMultiplier).toBeCloseTo(0.25 * 0.7, 6);
  });
});

describe("migration 1791100000000 — snapshot immutability", () => {
  test("snapshots and studies carry the append-only trigger; observations are keyed by instrument × session", async () => {
    const sql: string[] = [];
    await new CreateGlobalMarketIntelligence1791100000000().up({ query: async (s: string) => { sql.push(s); return []; } } as never);
    const j = sql.join("\n");
    expect(j).toMatch(/CREATE TRIGGER trg_global_market_snapshots_immutable BEFORE UPDATE OR DELETE ON global_market_snapshots/);
    expect(j).toMatch(/CREATE TRIGGER trg_global_relationship_studies_immutable/);
    expect(j).toMatch(/uq_global_obs ON global_market_observations \(instrument, session_date\)/);
    expect(j).toMatch(/exchange_tz varchar/);
    expect(j).toMatch(/utc_close_at timestamptz/);
    expect(j).toMatch(/feature_cutoff_utc timestamptz NOT NULL/);
  });
});
