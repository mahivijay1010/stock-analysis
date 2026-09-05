/**
 * V7 Module A4 — pure stress-module tests (deterministic fixtures only).
 */

import { Bar } from "../src/services/quant/types";
import {
  alignDailyReturns,
  beta1yVsIndex,
  blockBootstrapDrawdown,
  worstIndexWindows,
} from "../src/services/quant/stress";

function mkBars(n: number, closeFn: (i: number) => number): Bar[] {
  const bars: Bar[] = [];
  const start = Date.UTC(2024, 0, 1);
  for (let i = 0; i < n; i++) {
    const close = closeFn(i);
    const prev = i > 0 ? closeFn(i - 1) : close;
    bars.push({
      date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
      open: prev,
      high: Math.max(prev, close) * 1.005,
      low: Math.min(prev, close) * 0.995,
      close,
      volume: 1_000_000,
    });
  }
  return bars;
}

describe("worstIndexWindows", () => {
  // Gentle drift with ONE engineered 21-day crash at i ∈ [100, 121].
  const crashFn = (i: number): number => {
    let level = 100 + 0.05 * i;
    if (i >= 100 && i <= 121) level *= 1 - 0.015 * (i - 99); // ~-30% into the hole
    else if (i > 121) level *= 0.7;
    return level;
  };
  const bars = mkBars(300, crashFn);

  test("worst window covers the engineered crash and is most negative first", () => {
    const windows = worstIndexWindows(bars, { windowLen: 21, count: 5 });
    expect(windows.length).toBeGreaterThan(0);
    expect(windows.length).toBeLessThanOrEqual(5);
    // Ordered ascending (worst first).
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].indexReturnPct).toBeGreaterThanOrEqual(windows[i - 1].indexReturnPct);
    }
    // The worst window overlaps the crash dates.
    const worst = windows[0];
    expect(worst.indexReturnPct).toBeLessThan(-10);
    expect(worst.startDate >= bars[80].date && worst.startDate <= bars[121].date).toBe(true);
  });

  test("windows never overlap (distinct events, not echoes of one crash)", () => {
    const windows = worstIndexWindows(bars, { windowLen: 21, count: 5 });
    const starts = windows
      .map((w) => bars.findIndex((b) => b.date === w.startDate))
      .sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(21);
    }
  });

  test("too little history → empty, never fabricated", () => {
    expect(worstIndexWindows(mkBars(10, () => 100), { windowLen: 21, count: 5 })).toEqual([]);
  });
});

describe("blockBootstrapDrawdown", () => {
  // Two stocks with alternating up/down days → real drawdowns exist.
  const wobbleA = (i: number) => 100 * Math.pow(1 + (i % 2 === 0 ? 0.02 : -0.019), i);
  const wobbleB = (i: number) => 200 * Math.pow(1 + (i % 3 === 0 ? -0.025 : 0.014), i);
  const { matrix } = alignDailyReturns([mkBars(260, wobbleA), mkBars(260, wobbleB)]);

  test("p1 ≤ p5 ≤ 0 and deterministic under the same seed", () => {
    const a = blockBootstrapDrawdown(matrix, [0.5, 0.5], { blocks: 2000, blockLen: 21, seed: 7 });
    const b = blockBootstrapDrawdown(matrix, [0.5, 0.5], { blocks: 2000, blockLen: 21, seed: 7 });
    expect(b).toEqual(a);
    expect(a.p1DrawdownPct).toBeLessThanOrEqual(a.p5DrawdownPct);
    expect(a.p5DrawdownPct).toBeLessThanOrEqual(0);
    expect(a.blocks).toBe(2000);
    expect(a.blockLen).toBe(21);
  });

  test("all-up returns → zero drawdown (never a fabricated negative)", () => {
    const { matrix: upMatrix } = alignDailyReturns([
      mkBars(120, (i) => 100 * Math.pow(1.01, i)),
    ]);
    const r = blockBootstrapDrawdown(upMatrix, [1], { blocks: 500, blockLen: 21, seed: 1 });
    expect(r.p5DrawdownPct).toBe(0);
    expect(r.p1DrawdownPct).toBe(0);
  });

  test("throws on too few aligned days instead of fabricating", () => {
    expect(() => blockBootstrapDrawdown([[0.01], [0.02]], [1], { blockLen: 21 })).toThrow();
  });
});

describe("alignDailyReturns / beta1yVsIndex", () => {
  test("alignment keeps only common dates and computes row-wise returns", () => {
    const a = mkBars(50, (i) => 100 + i);
    const b = mkBars(50, (i) => 200 + 2 * i).slice(5); // missing first 5 days
    const { dates, matrix } = alignDailyReturns([a, b]);
    expect(dates.length).toBe(44); // 45 common dates → 44 return rows
    expect(matrix.every((row) => row.length === 2)).toBe(true);
  });

  test("beta of the index against itself ≈ 1; null when overlap is too thin", () => {
    const idx = mkBars(300, (i) => 100 + 0.2 * i + 3 * Math.sin(i / 5));
    expect(beta1yVsIndex(idx, idx)).toBeCloseTo(1, 3);
    expect(beta1yVsIndex(idx.slice(0, 50), idx)).toBeNull(); // < 100 overlapping returns
  });
});
