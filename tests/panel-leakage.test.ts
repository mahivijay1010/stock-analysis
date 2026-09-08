/**
 * O4/O5 tests — excess-return decomposition correctness and the HARD panel
 * leakage guarantee: mutating bars AFTER an anchor must not change that
 * anchor's features (targets, being labels, must change).
 */

import { alignReturns, buildSectorIndex, forwardExcessTargets, rollingBeta } from "../src/services/research/excessReturns";
import { splitPanelByDate, PANEL_HORIZONS_TD } from "../src/services/research/panel";

function mkBars(n: number, drift: number, seedStep = 0.001): Array<{ date: string; close: number }> {
  const bars: Array<{ date: string; close: number }> = [];
  let c = 100;
  for (let i = 0; i < n; i++) {
    c *= 1 + drift + Math.sin(i) * seedStep;
    const d = new Date(Date.UTC(2025, 0, 2 + i));
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    bars.push({ date: d.toISOString().slice(0, 10), close: c });
  }
  return bars;
}

describe("alignReturns + forwardExcessTargets (Part 5)", () => {
  const stock = mkBars(300, 0.002);
  const market = mkBars(300, 0.001);

  test("excess vs market = stock forward return − market forward return", () => {
    const aligned = alignReturns(stock, market);
    const i = 100;
    const h = 5;
    const t = forwardExcessTargets(aligned, i, h);
    expect(t.rawStock).not.toBeNull();
    expect(t.rawMarket).not.toBeNull();
    expect(t.excessVsMarket!).toBeCloseTo((t.rawStock as number) - (t.rawMarket as number), 10);
  });

  test("targets at the tail (insufficient forward sessions) are null, never truncated", () => {
    const aligned = alignReturns(stock, market);
    const t = forwardExcessTargets(aligned, aligned.dates.length - 2, 5);
    expect(t.excessVsMarket).toBeNull();
  });

  test("rolling beta uses only data ≤ anchor (mutating future returns leaves it unchanged)", () => {
    const aligned = alignReturns(stock, market);
    const i = 150;
    const before = rollingBeta(aligned, i, 60);
    const mutated = { ...aligned, stock: [...aligned.stock], market: [...aligned.market] };
    for (let k = i + 1; k < mutated.stock.length; k++) mutated.stock[k] = 0.5; // absurd future
    expect(rollingBeta(mutated, i, 60)).toBeCloseTo(before as number, 12);
  });

  test("LEAKAGE GUARD: future-bar mutation changes targets but not the anchor's inputs", () => {
    const aligned = alignReturns(stock, market);
    const i = 120;
    const originalTarget = forwardExcessTargets(aligned, i, 10).excessVsMarket;
    const mutated = { ...aligned, stock: [...aligned.stock] };
    for (let k = i + 1; k < mutated.stock.length; k++) mutated.stock[k] += 0.02;
    const mutatedTarget = forwardExcessTargets(mutated, i, 10).excessVsMarket;
    expect(mutatedTarget).not.toBeCloseTo(originalTarget as number, 6); // labels see the future (they must)
    expect(rollingBeta(mutated, i, 60)).toBeCloseTo(rollingBeta(aligned, i, 60) as number, 12); // features don't
  });
});

describe("buildSectorIndex", () => {
  test("a date needs ≥3 traded members; thin dates are absent (never padded)", () => {
    const a = mkBars(50, 0.001);
    const b = mkBars(50, 0.002);
    const idx2 = buildSectorIndex([a, b]); // only 2 members ⇒ every date thin
    expect(idx2.size).toBe(0);
    const c = mkBars(50, -0.001);
    const idx3 = buildSectorIndex([a, b, c]);
    expect(idx3.size).toBeGreaterThan(30);
  });
});

describe("splitPanelByDate — purge + embargo gaps", () => {
  test("val starts after train end + purge + embargo; test after val likewise; no overlap", () => {
    const dates = Array.from({ length: 200 }, (_, i) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10));
    const { train, val, test } = splitPanelByDate(dates);
    const purge = Math.max(...PANEL_HORIZONS_TD) + 2 + 3; // purge + embargo
    const trainMaxIdx = Math.max(...[...train].map((d) => dates.indexOf(d)));
    const valMinIdx = Math.min(...[...val].map((d) => dates.indexOf(d)));
    const valMaxIdx = Math.max(...[...val].map((d) => dates.indexOf(d)));
    const testMinIdx = Math.min(...[...test].map((d) => dates.indexOf(d)));
    expect(valMinIdx - trainMaxIdx).toBeGreaterThanOrEqual(purge);
    expect(testMinIdx - valMaxIdx).toBeGreaterThanOrEqual(purge);
    for (const d of val) expect(train.has(d)).toBe(false);
    for (const d of test) expect(val.has(d) || train.has(d)).toBe(false);
  });
});
