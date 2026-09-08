/**
 * Autonomous-cycle hardening tests: governance transitions, DSR/PBO,
 * disagreement, portfolio context, and the new baselines' honest shapes.
 */

import { deflatedSharpeRatio, probabilityOfBacktestOverfitting, forecastDisagreement, expectedMaxSharpe } from "../src/services/research/overfitting";
import { assessPortfolioContext } from "../src/services/shortterm/portfolioContext";
import { EwmaModel, HarRvModel, ArxModel } from "../src/services/research/models";
import { mulberry32 } from "../src/services/quant/montecarlo";

describe("deflated Sharpe (Part T)", () => {
  test("expected max Sharpe grows with trial count", () => {
    expect(expectedMaxSharpe(100)).toBeGreaterThan(expectedMaxSharpe(10));
    expect(expectedMaxSharpe(10)).toBeGreaterThan(0);
  });

  test("a mediocre Sharpe selected from many trials FAILS deflation", () => {
    // Sharpe 0.35/period over 14 periods, best of ~50 tested configs — luck-sized.
    const r = deflatedSharpeRatio(0.35, 14, 50);
    expect(r.passes).toBe(false);
    expect(r.expectedMaxSharpeUnderNull).toBeGreaterThan(0.35 * 0.5);
  });

  test("a genuinely large Sharpe on long history passes", () => {
    const r = deflatedSharpeRatio(2.5, 500, 10);
    expect(r.passes).toBe(true);
  });
});

describe("PBO (CSCV-lite)", () => {
  const rand = mulberry32(11);
  test("pure-noise strategies ⇒ HIGH PBO (in-sample winner is luck; small samples skew ≥0.5)", () => {
    const perf = Array.from({ length: 10 }, () => Array.from({ length: 64 }, () => rand() - 0.5));
    const r = probabilityOfBacktestOverfitting(perf, 8)!;
    expect(r.pbo).toBeGreaterThan(0.4); // selection from noise must look overfit
  });

  test("one genuinely dominant strategy ⇒ low PBO", () => {
    const perf = Array.from({ length: 10 }, (_, s) => Array.from({ length: 64 }, () => (s === 0 ? 0.5 + (rand() - 0.5) * 0.2 : rand() - 0.5)));
    const r = probabilityOfBacktestOverfitting(perf, 8)!;
    expect(r.pbo).toBeLessThan(0.2);
  });

  test("too-short series ⇒ null (never a fake number)", () => {
    expect(probabilityOfBacktestOverfitting([[1, 2, 3]], 8)).toBeNull();
  });
});

describe("forecast disagreement (Part Q)", () => {
  test("agreeing models ⇒ low dispersion; sign conflicts measured", () => {
    const agree = forecastDisagreement([
      { expectedReturn: 0.02, rawDirectionProbability: 0.6 },
      { expectedReturn: 0.021, rawDirectionProbability: 0.58 },
    ]);
    expect(agree.signDisagreementPct).toBe(0);
    const conflict = forecastDisagreement([
      { expectedReturn: 0.02, rawDirectionProbability: 0.6 },
      { expectedReturn: -0.02, rawDirectionProbability: 0.4 },
    ]);
    expect(conflict.signDisagreementPct).toBe(100);
    expect(conflict.returnDispersion!).toBeGreaterThan(agree.returnDispersion!);
  });
});

describe("portfolio context (Part O)", () => {
  const rand = mulberry32(7);
  const series = (corrWith?: number[]): number[] =>
    Array.from({ length: 80 }, (_, i) => (corrWith ? corrWith[i] * 0.9 + (rand() - 0.5) * 0.004 : (rand() - 0.5) * 0.03));
  test("a highly correlated candidate gets penalized and named", () => {
    const held = series();
    const r = assessPortfolioContext({
      candidateTicker: "A.NS",
      candidateSector: "Banking",
      candidateReturns: series(held),
      candidateBeta60: 1.1,
      openPositions: [{ ticker: "B.NS", sector: "Banking", capitalInr: 50_000, returns: held }],
      candidateCapitalInr: 50_000,
    });
    expect(r.maxPairwiseCorrelation!).toBeGreaterThan(0.75);
    expect(r.mostCorrelatedTicker).toBe("B.NS");
    expect(r.sectorConcentrationPct).toBe(100);
    expect(r.rankingPenalty).toBeGreaterThanOrEqual(8);
  });

  test("an uncorrelated diversifier passes clean", () => {
    const r = assessPortfolioContext({
      candidateTicker: "A.NS",
      candidateSector: "Pharma",
      candidateReturns: series(),
      candidateBeta60: 0.8,
      openPositions: [{ ticker: "B.NS", sector: "Banking", capitalInr: 50_000, returns: series() }],
      candidateCapitalInr: 25_000,
    });
    expect(r.rankingPenalty).toBeLessThanOrEqual(4);
    expect(r.notes.join(" ")).toMatch(/no adverse|correlated/);
  });
});

describe("new mandatory baselines (Part F)", () => {
  const mkRows = (n: number, drift: number) => {
    const rand = mulberry32(3);
    return Array.from({ length: n }, (_, i) => ({
      ticker: "T.NS",
      date: `2025-01-${String((i % 28) + 1).padStart(2, "0")}`,
      targetReturn: drift + (rand() - 0.5) * 0.04,
      features: {
        ret_1d: drift + (rand() - 0.5) * 0.01,
        ret_2d: drift * 2,
        ret_3d: drift * 3,
        ret_5d: drift * 5,
        ret_10d: drift * 10,
        ret_20d: drift * 20,
        rv_1d_ann_pct: 20,
        rv_5d_ann_pct: 22,
        rv_22d_ann_pct: 25,
      },
    }));
  };

  test("HAR-RV never claims direction (prob 0.5, μ 0) and emits symmetric bands", () => {
    const m = new HarRvModel();
    m.fit(mkRows(300, 0.001) as never);
    const out = m.predict(mkRows(1, 0.001)[0] as never, 7);
    expect(out.rawDirectionProbability).toBe(0.5);
    expect(out.expectedReturn).toBe(0);
    expect(out.quantiles!.p90).toBeCloseTo(-out.quantiles!.p10, 6);
  });

  test("EWMA and ARX produce finite drift + bands", () => {
    for (const m of [new EwmaModel(), new ArxModel()]) {
      m.fit(mkRows(300, 0.0005) as never);
      const out = m.predict(mkRows(1, 0.0005)[0] as never, 7);
      expect(Number.isFinite(out.expectedReturn!)).toBe(true);
      expect(out.quantiles!.p90).toBeGreaterThan(out.quantiles!.p10);
    }
  });
});
