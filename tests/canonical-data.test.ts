/**
 * Phase 1 regression tests (completion directive) — the canonical
 * point-in-time market dataset: split/dividend adjustment, missing-value
 * honesty, duplicates, weekends/holidays, partial sessions, stale providers.
 */

import {
  adjustedDailyReturns,
  analysisCloses,
  toCanonical,
} from "../src/services/market/canonical";
import { Bar } from "../src/services/market/types";

const bar = (date: string, close: number, over?: Partial<Bar>): Bar => ({
  date,
  open: close,
  high: close * 1.01,
  low: close * 0.99,
  close,
  volume: 1000,
  ...over,
});

describe("split adjustment (the TMPV/demerger failure class)", () => {
  // A 1:5 split on 2026-01-03: raw close drops 500 → 100 (−80% fake jump);
  // Yahoo's adjusted series is continuous (pre-split rows scaled ÷5).
  const splitSeries: Bar[] = [
    bar("2026-01-01", 500, { adjustedClose: 100 }),
    bar("2026-01-02", 505, { adjustedClose: 101 }),
    bar("2026-01-03", 100, { adjustedClose: 100 }), // ex-date
    bar("2026-01-04", 102, { adjustedClose: 102 }),
  ];

  test("raw returns fabricate a −80% jump; adjusted returns do not", () => {
    const rawRets: number[] = [];
    for (let i = 1; i < splitSeries.length; i++) {
      rawRets.push(splitSeries[i].close / splitSeries[i - 1].close - 1);
    }
    expect(Math.min(...rawRets)).toBeLessThan(-0.75); // the fake crash

    const adjRets = adjustedDailyReturns(splitSeries);
    expect(Math.min(...adjRets)).toBeGreaterThan(-0.05); // continuous
    expect(adjRets[1]).toBeCloseTo(100 / 101 - 1, 6);
  });

  test("canonical bars record the split factor on the ex-date only", () => {
    const c = toCanonical("TEST.NS", splitSeries, {
      source: "yahoo",
      events: { splits: { "2026-01-03": 5 }, dividends: {} },
    });
    expect(c.bars[2].splitFactor).toBe(5);
    expect(c.bars[0].splitFactor).toBeNull();
    expect(c.suspectedUnadjustedBreak).toBe(false); // adjusted series is clean
  });

  test("an UNADJUSTED split (no adjclose) is flagged, never silently accepted", () => {
    const unadjusted = splitSeries.map((b) => ({ ...b, adjustedClose: null }));
    const c = toCanonical("TEST.NS", unadjusted, { source: "yahoo" });
    expect(c.suspectedUnadjustedBreak).toBe(true);
  });
});

describe("dividend adjustment", () => {
  test("dividend recorded on its ex-date; adjusted < close before it", () => {
    const series: Bar[] = [
      bar("2026-02-01", 100, { adjustedClose: 98 }), // pre-ex: adjusted down by the dividend
      bar("2026-02-02", 99, { adjustedClose: 99 }), // ex-date (₹2 dividend)
    ];
    const c = toCanonical("TEST.NS", series, {
      source: "yahoo",
      events: { splits: {}, dividends: { "2026-02-02": 2 } },
    });
    expect(c.bars[1].dividend).toBe(2);
    expect(c.bars[0].dividend).toBeNull();
    expect(c.bars[0].adjustedClose).toBeLessThan(c.bars[0].close);
    // Total-return math: adjusted return ≈ (99+? ) — here simply continuous:
    const rets = adjustedDailyReturns(series);
    expect(rets[0]).toBeCloseTo(99 / 98 - 1, 6);
  });
});

describe("missing-value honesty (never fabricate)", () => {
  test("volume 0 becomes null in canonical form — a fabricated zero is not data", () => {
    const c = toCanonical("TEST.NS", [bar("2026-01-01", 100, { volume: 0 })], { source: "yahoo" });
    expect(c.bars[0].volume).toBeNull();
  });

  test("missing previous close: the first bar simply produces no return", () => {
    expect(adjustedDailyReturns([bar("2026-01-01", 100)])).toHaveLength(0);
  });

  test("analysisCloses falls back to close ONLY when adjusted is absent/invalid", () => {
    const closes = analysisCloses([
      bar("2026-01-01", 100, { adjustedClose: 95 }),
      bar("2026-01-02", 100, { adjustedClose: null }),
      bar("2026-01-03", 100, { adjustedClose: -5 }), // invalid ⇒ fallback
    ]);
    expect(closes).toEqual([95, 100, 100]);
  });
});

describe("duplicates, calendar gaps, staleness, completed sessions", () => {
  test("duplicate session dates are deduped (latest wins) and counted", () => {
    const c = toCanonical(
      "TEST.NS",
      [bar("2026-01-01", 100), bar("2026-01-01", 101), bar("2026-01-02", 102)],
      { source: "db-fresh" }
    );
    expect(c.bars).toHaveLength(2);
    expect(c.bars[0].close).toBe(101); // latest fetch won
    expect(c.duplicatesRemoved).toBe(1);
  });

  test("weekend/NSE-holiday gaps stay gaps — no fabricated bars", () => {
    // Fri 2026-01-02 → Mon 2026-01-05 (weekend) → Wed 2026-01-07 (holiday Tue)
    const c = toCanonical(
      "TEST.NS",
      [bar("2026-01-02", 100), bar("2026-01-05", 101), bar("2026-01-07", 102)],
      { source: "yahoo" }
    );
    expect(c.bars.map((b) => b.sessionDate)).toEqual(["2026-01-02", "2026-01-05", "2026-01-07"]);
  });

  test("stale provider response is labeled, not hidden", () => {
    const c = toCanonical("TEST.NS", [bar("2026-01-01", 100)], { source: "db-stale" });
    expect(c.isStale).toBe(true);
  });

  test("every canonical bar declares the completed-session contract", () => {
    const c = toCanonical("TEST.NS", [bar("2026-01-01", 100)], { source: "yahoo" });
    expect(c.bars[0].isCompleteSession).toBe(true);
    expect(c.bars[0].fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
