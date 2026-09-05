/**
 * V8 R1 — RankEngine pure math tests: cross-sectional z-scores (σ floor,
 * ±3 clamp, null→0), composite weights, monotonic percentiles, momentum60d,
 * Spearman IC.
 */

import {
  computeRankIC,
  crossSectionZ,
  momentum60d,
  RankInputRow,
  rankUniverse,
  RANK_WEIGHTS,
  spearman,
} from "../src/services/quant/rank";

describe("crossSectionZ", () => {
  it("standardizes cross-sectionally and clamps to ±3", () => {
    // 20 ordinary values + 1 wild outlier: the outlier's raw z is ~4.36
    // (max possible z for n=21 is √20 ≈ 4.47), so the ±3 clamp must engage.
    const values: Array<number | null> = new Array(20).fill(0).map((_, i) => i);
    values.push(1_000);
    const z = crossSectionZ(values);
    expect(z[20]).toBe(3); // clamped
    expect(z[0]).toBeLessThan(0);
    for (const v of z) {
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThanOrEqual(3);
    }
  });

  it("null and non-finite inputs get a neutral z = 0", () => {
    const z = crossSectionZ([5, null, 15, Number.NaN]);
    expect(z[1]).toBe(0);
    expect(z[3]).toBe(0);
    expect(z[0]).toBeCloseTo(-1, 6); // (5-10)/5
    expect(z[2]).toBeCloseTo(1, 6);
  });

  it("identical values (σ floored) → all z = 0, never NaN/Infinity", () => {
    const z = crossSectionZ([7, 7, 7, 7]);
    for (const v of z) expect(v).toBe(0);
  });

  it("fewer than 2 real values → all zeros", () => {
    expect(crossSectionZ([5, null, null])).toEqual([0, 0, 0]);
    expect(crossSectionZ([])).toEqual([]);
  });
});

describe("momentum60d", () => {
  it("computes the 60-trading-day simple return", () => {
    const closes = new Array(61).fill(0).map((_, i) => 100 + i); // 100 → 160
    expect(momentum60d(closes)).toBeCloseTo(0.6, 12);
  });

  it("returns null with insufficient history", () => {
    expect(momentum60d(new Array(60).fill(100))).toBeNull();
    expect(momentum60d([])).toBeNull();
  });
});

describe("rankUniverse", () => {
  const rows: RankInputRow[] = [
    { ticker: "A", momentum60d: 0.30, quality: 25, qualitySource: "roe", sentimentDecay: 40 },
    { ticker: "B", momentum60d: 0.10, quality: 15, qualitySource: "roe", sentimentDecay: null },
    { ticker: "C", momentum60d: -0.05, quality: null, qualitySource: null, sentimentDecay: null },
    { ticker: "D", momentum60d: -0.20, quality: 5, qualitySource: "operating-margin", sentimentDecay: -30 },
  ];
  const ranked = rankUniverse(rows);

  it("composite = 0.5·zMom + 0.3·zQual + 0.2·zSent (weights honored)", () => {
    for (const r of ranked) {
      const expected =
        r.components.momentum * RANK_WEIGHTS.momentum +
        r.components.quality * RANK_WEIGHTS.quality +
        r.components.sentiment * RANK_WEIGHTS.sentiment;
      expect(r.composite).toBeCloseTo(expected, 3);
      expect(Number.isFinite(r.composite)).toBe(true);
    }
  });

  it("missing components are flagged no-data and contribute z = 0", () => {
    const c = ranked.find((r) => r.ticker === "C")!;
    expect(c.componentStatus.quality).toBe("no-data");
    expect(c.componentStatus.sentiment).toBe("no-data");
    expect(c.components.quality).toBe(0);
    expect(c.components.sentiment).toBe(0);
    const b = ranked.find((r) => r.ticker === "B")!;
    expect(b.componentStatus.momentum).toBe("ok");
    expect(b.componentStatus.sentiment).toBe("no-data");
  });

  it("percentile ∈ [0,100] and is monotonic with composite", () => {
    const sorted = [...ranked].sort((a, b) => a.composite - b.composite);
    for (let i = 0; i < sorted.length; i++) {
      expect(sorted[i].percentile).toBeGreaterThanOrEqual(0);
      expect(sorted[i].percentile).toBeLessThanOrEqual(100);
      if (i > 0) {
        expect(sorted[i].percentile).toBeGreaterThanOrEqual(sorted[i - 1].percentile);
      }
    }
    expect(sorted[0].percentile).toBe(0);
    expect(sorted[sorted.length - 1].percentile).toBe(100);
  });

  it("the strongest inputs rank first", () => {
    const byComposite = [...ranked].sort((a, b) => b.composite - a.composite);
    expect(byComposite[0].ticker).toBe("A");
    expect(byComposite[byComposite.length - 1].ticker).toBe("D");
  });

  it("equal composites share the same percentile (ties stay monotonic)", () => {
    const tied = rankUniverse([
      { ticker: "X", momentum60d: null, quality: null, qualitySource: null, sentimentDecay: null },
      { ticker: "Y", momentum60d: null, quality: null, qualitySource: null, sentimentDecay: null },
      { ticker: "Z", momentum60d: null, quality: null, qualitySource: null, sentimentDecay: null },
    ]);
    expect(new Set(tied.map((r) => r.percentile)).size).toBe(1);
  });
});

describe("spearman / computeRankIC", () => {
  it("perfect monotonic relation → 1, inverse → −1", () => {
    expect(spearman([1, 2, 3, 4, 5], [10, 20, 30, 40, 50])).toBeCloseTo(1, 9);
    expect(spearman([1, 2, 3, 4, 5], [5, 4, 3, 2, 1])).toBeCloseTo(-1, 9);
  });

  it("is rank-based: outliers don't change it", () => {
    expect(spearman([1, 2, 3, 4, 5], [1, 2, 3, 4, 1_000_000])).toBeCloseTo(1, 9);
  });

  it("returns null on degenerate inputs", () => {
    expect(spearman([1, 2], [1, 2])).toBeNull(); // too short
    expect(spearman([1, 1, 1, 1], [1, 2, 3, 4])).toBeNull(); // zero variance
  });

  it("computeRankIC averages daily Spearman ICs and skips thin days", () => {
    const comps = new Array(12).fill(0).map((_, i) => i + 1);
    const ic = computeRankIC([
      { date: "2026-01-01", composites: comps, forwardReturns: comps.map((c) => c * 0.01) },
      { date: "2026-01-02", composites: comps, forwardReturns: comps.map((c) => -c * 0.01) },
      { date: "2026-01-03", composites: [1, 2, 3], forwardReturns: [0.1, 0.2, 0.3] }, // <10 tickers → skipped
    ]);
    expect(ic).not.toBeNull();
    expect(ic!.samples).toBe(2);
    expect(ic!.value).toBeCloseTo(0, 9); // +1 and −1 average out
  });

  it("computeRankIC returns null when no day qualifies", () => {
    expect(computeRankIC([])).toBeNull();
    expect(
      computeRankIC([{ date: "2026-01-01", composites: [1, 2], forwardReturns: [0.1, 0.2] }])
    ).toBeNull();
  });
});
