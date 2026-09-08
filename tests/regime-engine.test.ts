/**
 * Phase 4 tests (completion directive) — deterministic regime boundaries and
 * the cap-only guarantee: regime NEVER makes anything more bullish.
 */

import { assessRegime, REGIME_VERSION } from "../src/services/decision/regimeEngine";
import { evaluateEntryPolicy, PolicyInputs } from "../src/services/decision/policy";
import { Bar } from "../src/services/market/types";

function trendBars(n: number, dailyRet: number, start = 100, volMult = 0): Bar[] {
  const bars: Bar[] = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    price *= 1 + dailyRet + volMult * 0.02 * Math.sin(i);
    const d = new Date(Date.UTC(2024, 0, 1 + Math.floor(i * 1.4)));
    bars.push({
      date: d.toISOString().slice(0, 10),
      open: price,
      high: price * 1.005,
      low: price * 0.995,
      close: price,
      volume: 1_000_000,
      adjustedClose: price,
    });
  }
  return bars;
}

describe("assessRegime — deterministic boundaries", () => {
  test("steady uptrend + low vol ⇒ bull_low_vol; with high VIX ⇒ bull_high_vol", () => {
    const nifty = trendBars(260, 0.0008);
    const low = assessRegime({ niftyBars: nifty, vixLevel: 12, vixPercentile1y: 30, stockBars: null });
    expect(low.marketRegime).toBe("bull_low_vol");
    const high = assessRegime({ niftyBars: nifty, vixLevel: 24, vixPercentile1y: 95, stockBars: null });
    expect(high.marketRegime).toBe("bull_high_vol");
  });

  test("downtrend below both DMAs ⇒ bear; realized vol splits low/high", () => {
    const calmBear = assessRegime({
      niftyBars: trendBars(260, -0.0012),
      vixLevel: 12,
      vixPercentile1y: 40,
      stockBars: null,
    });
    expect(["bear_low_vol", "bear_high_vol"]).toContain(calmBear.marketRegime);
    const volBear = assessRegime({
      niftyBars: trendBars(260, -0.0012, 100, 1.2),
      vixLevel: 26,
      vixPercentile1y: 98,
      stockBars: null,
    });
    expect(volBear.marketRegime).toBe("bear_high_vol");
  });

  test("no NIFTY history ⇒ unknown market regime, reduced confidence — never guessed", () => {
    const r = assessRegime({ niftyBars: null, vixLevel: null, vixPercentile1y: null, stockBars: null });
    expect(r.marketRegime).toBe("unknown");
    expect(r.stockRegime).toBe("unknown");
    expect(r.regimeConfidence).toBe(0);
    expect(r.version).toBe(REGIME_VERSION);
  });

  test("stock regimes: extended uptrend / downtrend / healthy classified from shape", () => {
    const extended = assessRegime({
      niftyBars: null,
      vixLevel: null,
      vixPercentile1y: null,
      stockBars: trendBars(300, 0.004), // relentless rally: 52w top, far above SMA50
    });
    expect(extended.stockRegime).toBe("extended_uptrend");

    const down = assessRegime({
      niftyBars: null,
      vixLevel: null,
      vixPercentile1y: null,
      stockBars: trendBars(300, -0.003),
    });
    expect(down.stockRegime).toBe("downtrend");
  });

  test("upcoming event risk dominates the stock regime", () => {
    const r = assessRegime({
      niftyBars: null,
      vixLevel: null,
      vixPercentile1y: null,
      stockBars: trendBars(300, 0.001),
      upcomingEventRisk: true,
    });
    expect(r.stockRegime).toBe("high_event_risk");
  });

  test("sector relative strength boundaries: >3pp leading, <−3pp lagging, else inline", () => {
    const mk = (pp: number) =>
      assessRegime({ niftyBars: null, vixLevel: null, vixPercentile1y: null, stockBars: null, sectorRelativeStrength20pp: pp });
    expect(mk(4).sectorRegime).toBe("leading");
    expect(mk(-4).sectorRegime).toBe("lagging");
    expect(mk(0).sectorRegime).toBe("inline");
  });

  test("CAP-ONLY: a bullish stock inside a bear market is demoted to late_trend, never boosted", () => {
    const r = assessRegime({
      niftyBars: trendBars(260, -0.0012),
      vixLevel: 25,
      vixPercentile1y: 96,
      stockBars: trendBars(300, 0.0015, 100, 0.3), // healthy uptrend shape
    });
    expect(["healthy_uptrend", "breakout"]).toContain(r.stockRegime);
    expect(r.entryRegime).toBe("late_trend");
  });
});

describe("policy v4 — regime caps in the TradeGate", () => {
  const buyReady = (): PolicyInputs => ({
    ticker: "TEST.NS",
    issuance: {
      anchorSessionDate: "2026-09-05",
      anchorAgeDays: 1,
      anchorIsLatestObservedSession: true,
      targetSessionCount: 22,
      annualizedVolPct: 18,
      medianReturnPct30: 0.5,
    },
    measured: { samples: 3000, directionHitRatePct: 65, withinBandPct: 82, brierScore: 0.22 },
    afterMarketClose: false,
    riskScore: 40,
    dataQualityScore: 85,
    forecastConfidenceScore: 70,
    entryQualityScore: 65,
    evAfterCostsPct: 1.4,
  });

  test("bear_high_vol market caps an otherwise-BUY at WATCH", () => {
    const d = evaluateEntryPolicy({ ...buyReady(), regime: { marketRegime: "bear_high_vol", entryRegime: "neutral" } });
    expect(d.decisionStatus).toBe("WAIT");
    expect(d.unmetGates.some((g) => g.gate === "market regime")).toBe(true);
  });

  test("extended/late/high-event-risk entry regimes cap at WATCH", () => {
    for (const entryRegime of ["extended_uptrend", "late_trend", "high_event_risk"]) {
      const d = evaluateEntryPolicy({ ...buyReady(), regime: { marketRegime: "bull_low_vol", entryRegime } });
      expect(d.decisionStatus).toBe("WAIT");
      expect(d.unmetGates.some((g) => g.gate === "entry regime")).toBe(true);
    }
  });

  test("a benign regime never boosts: BUY still requires every other gate", () => {
    const d = evaluateEntryPolicy({ ...buyReady(), regime: { marketRegime: "bull_low_vol", entryRegime: "healthy_uptrend" } });
    expect(d.decisionStatus).toBe("BUY_CANDIDATE"); // unchanged from the no-regime case
    const withoutEdge = evaluateEntryPolicy({
      ...buyReady(),
      measured: { samples: 39, directionHitRatePct: 79.5, withinBandPct: 100, brierScore: 0.2195 },
      regime: { marketRegime: "bull_low_vol", entryRegime: "healthy_uptrend" },
    });
    expect(withoutEdge.decisionStatus).toBe("WAIT"); // regime cannot rescue missing evidence
  });

  test("null regime (not assessed) changes nothing", () => {
    const withNull = evaluateEntryPolicy({ ...buyReady(), regime: null });
    const without = evaluateEntryPolicy(buyReady());
    expect(withNull.decisionStatus).toBe(without.decisionStatus);
  });
});
