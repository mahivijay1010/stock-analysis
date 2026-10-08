/** Money Desk track record: withheld below 10, Wilson bounds, precision@k per plan-day, segments. */
import { buildCapitalTrackRecord, computeMetrics, precisionAtK, CapitalOutcomeRow, MIN_GRADED_FOR_CAPITAL_RATE, liquidityBucketOf } from "../src/services/capital/capitalTrackRecord";

const row = (i: number, over: Partial<CapitalOutcomeRow> = {}): CapitalOutcomeRow => ({
  allocationId: `a${i}`, planId: `p${i}`, planDate: `2026-09-${String((i % 28) + 1).padStart(2, "0")}`, ticker: `T${i}`, action: "ALLOCATE",
  setupType: i % 2 ? "PULLBACK_IN_UPTREND" : "MEAN_REVERSION", horizon: "5-10d", regime: i % 3 ? "TREND_UP" : "CHOPPY", riskProfile: "BALANCED", sector: "X",
  liquidityBucket: ">10cr", modelVersion: "short-term-v1", evidenceScore: 50 + i, rewardRisk: 2,
  outcome: i % 4 === 0 ? "STOP" : "TARGET", realizedReturnPct: i % 4 === 0 ? -3 : 6, realizedNetR: i % 4 === 0 ? -1 : 1.5,
  benchmarkReturnPct: 1, excessReturnPct: i % 4 === 0 ? -4 : 5, mfeR: 1.8, maeR: -0.5, exitAt: `2026-09-${String((i % 28) + 1).padStart(2, "0")}`,
  ...over,
});

describe("computeMetrics", () => {
  test("withheld below the floor with the reason stated", () => {
    const m = computeMetrics(Array.from({ length: MIN_GRADED_FOR_CAPITAL_RATE - 1 }, (_, i) => row(i)));
    expect(m.withheld).toBe(true);
    expect(m.winRate.pct).toBeNull();
    expect(m.withheldReason).toMatch(/< 10 minimum/);
  });
  test("not-filled and ambiguous rows are counted but never scored", () => {
    const rows = [...Array.from({ length: 12 }, (_, i) => row(i)), row(50, { outcome: "NOT_FILLED", realizedReturnPct: null }), row(51, { outcome: "AMBIGUOUS", realizedReturnPct: null })];
    const m = computeMetrics(rows);
    expect(m.observed).toBe(12);
    expect(m.notFilled).toBe(1);
    expect(m.ambiguous).toBe(1);
  });
  test("12 observed outcomes → win rate with Wilson LB, profit factor, expectancy, drawdown, MFE/MAE, excess CI", () => {
    const m = computeMetrics(Array.from({ length: 12 }, (_, i) => row(i)));
    expect(m.withheld).toBe(false);
    expect(m.winRate.pct).toBe(75);
    expect(m.winRate.wilsonLb95Pct).toBeLessThan(75);
    expect(m.profitFactor).toBeCloseTo((9 * 6) / (3 * 3), 2);
    expect(m.expectancyR).toBeCloseTo((9 * 1.5 - 3) / 12, 1);
    expect(m.maxDrawdownPct).toBeLessThanOrEqual(0);
    expect(m.mfeR).toBe(1.8);
    expect(m.maeR).toBe(-0.5);
    expect(m.benchmarkExcessPct.mean).toBeCloseTo((9 * 5 - 3 * 4) / 12, 2);
    expect(m.benchmarkExcessPct.ci95).not.toBeNull();
  });
});

describe("precisionAtK", () => {
  test("withheld below 10 plan-days", () => {
    const p = precisionAtK(Array.from({ length: 5 }, (_, i) => row(i)));
    expect(p[0].precision).toBeNull();
    expect(p[0].withheldReason).toMatch(/plan-days/);
  });
  test("per plan-day top-k by evidence score; k larger than the plan's allocations is skipped", () => {
    // 10 plans, each with 3 allocations; highest-score one positive, lowest negative
    const rows: CapitalOutcomeRow[] = [];
    for (let p = 0; p < 10; p++) {
      rows.push(row(p * 3, { planId: `P${p}`, evidenceScore: 90, excessReturnPct: 2 }));
      rows.push(row(p * 3 + 1, { planId: `P${p}`, evidenceScore: 70, excessReturnPct: 1 }));
      rows.push(row(p * 3 + 2, { planId: `P${p}`, evidenceScore: 50, excessReturnPct: -1 }));
    }
    const p = precisionAtK(rows);
    expect(p.find((x) => x.k === 1)?.precision).toBe(1);
    expect(p.find((x) => x.k === 3)?.precision).toBeCloseTo(2 / 3, 2);
    expect(p.find((x) => x.k === 5)?.precision).toBeNull();
  });
});

describe("buildCapitalTrackRecord", () => {
  test("headline is the least flattering true statement", () => {
    const r = buildCapitalTrackRecord(Array.from({ length: 4 }, (_, i) => row(i)), "2026-10-08T00:00:00Z");
    expect(r.headline).toMatch(/not yet earned a track record/);
    expect(r.overall.withheld).toBe(true);
  });
  test("segments are produced by setup, horizon, regime, profile, sector, liquidity and model version", () => {
    const r = buildCapitalTrackRecord(Array.from({ length: 24 }, (_, i) => row(i)), "2026-10-08T00:00:00Z");
    expect(r.bySetupType.map((s) => s.key).sort()).toEqual(["MEAN_REVERSION", "PULLBACK_IN_UPTREND"]);
    expect(r.byRegime.length).toBe(2);
    expect(r.bySector[0].key).toBe("X");
    expect(r.byLiquidityBucket[0].key).toBe(">10cr");
    expect(r.byModelVersion[0].key).toBe("short-term-v1");
    expect(r.caveat).toMatch(/does not promise/);
  });
  test("liquidity buckets", () => {
    expect(liquidityBucketOf(null)).toBe("unknown");
    expect(liquidityBucketOf(1e7)).toBe("<2cr");
    expect(liquidityBucketOf(5e7)).toBe("2-10cr");
    expect(liquidityBucketOf(5e8)).toBe(">10cr");
  });
});
