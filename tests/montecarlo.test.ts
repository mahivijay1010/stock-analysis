/**
 * Module N2 tests — seeded bootstrap Monte Carlo.
 * All fixtures are deterministic; the simulator itself is seeded (mulberry32),
 * so every expectation here is exact and reproducible.
 */

import { mulberry32, simulateBootstrap } from "../src/services/quant/montecarlo";

const mkReturns = (n: number, fn: (i: number) => number): number[] =>
  Array.from({ length: n }, (_, i) => fn(i));

// Mixed but deterministic daily returns: mostly small ups, periodic downs.
const mixed = mkReturns(250, (i) => 0.01 * Math.sin(i / 3) + (i % 5 === 0 ? -0.008 : 0.004));

// Uptrend fixture: strictly positive daily returns (0.1%..0.7%).
const uptrend = mkReturns(250, (i) => 0.004 + 0.003 * Math.sin(i / 7));

describe("montecarlo.mulberry32", () => {
  test("same seed → identical stream; different seed → different stream", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    const seqC = Array.from({ length: 5 }, () => c());
    expect(seqB).toEqual(seqA);
    expect(seqC).not.toEqual(seqA);
    for (const x of seqA) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe("montecarlo.simulateBootstrap", () => {
  test("throws below 60 returns — never fabricates a forecast", () => {
    expect(() => simulateBootstrap(mkReturns(59, () => 0.001))).toThrow(/60/);
    expect(() => simulateBootstrap([])).toThrow(/60/);
  });

  test("seeded determinism: same input → identical output object", () => {
    const a = simulateBootstrap(mixed);
    const b = simulateBootstrap(mixed);
    expect(b).toEqual(a); // deep equality across every probability/percentile
    // And an explicit seed change produces a different forecast.
    const c = simulateBootstrap(mixed, { seed: 7 });
    expect(c).not.toEqual(a);
  });

  test("uptrend fixture → pop30 > 0.5 (and > pop at pop-hostile thresholds)", () => {
    const f = simulateBootstrap(uptrend);
    const h30 = f.horizons.find((h) => h.horizonDays === 30)!;
    expect(h30.pop).toBeGreaterThan(0.5);
    // Strictly positive daily returns → no path can be negative at any horizon.
    for (const h of f.horizons) {
      expect(h.pop).toBe(1);
      expect(h.pDown10).toBe(0);
      expect(h.pDown20).toBe(0);
    }
  });

  test("percentiles are ordered p5 < p25 < p50 < p75 < p95", () => {
    const f = simulateBootstrap(mixed);
    expect(f.horizons.map((h) => h.horizonDays)).toEqual([1, 3, 7, 15, 30]);
    for (const h of f.horizons) {
      const p = h.percentiles;
      expect(p.p5).toBeLessThan(p.p25);
      expect(p.p25).toBeLessThan(p.p50);
      expect(p.p50).toBeLessThan(p.p75);
      expect(p.p75).toBeLessThan(p.p95);
    }
  });

  test("pDown20 ≤ pDown10 and all probabilities are valid frequencies", () => {
    // Volatile fixture so the downside tail is actually populated.
    const volatile = mkReturns(250, (i) => 0.06 * Math.sin(i / 2) - 0.002);
    const f = simulateBootstrap(volatile);
    expect(f.paths).toBe(10_000);
    for (const h of f.horizons) {
      expect(h.pDown20).toBeLessThanOrEqual(h.pDown10);
      for (const v of [h.pop, h.pDown10, h.pDown20, h.pUp10]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
    const h30 = f.horizons.find((h) => h.horizonDays === 30)!;
    expect(h30.pDown10).toBeGreaterThan(0); // tail genuinely exercised
  });

  test("uses at most the last 250 returns and reports the pool size in method/note", () => {
    const long = mkReturns(400, (i) => (i < 150 ? -0.05 : 0.004 + 0.003 * Math.sin(i / 7)));
    const f = simulateBootstrap(long); // early crash days must be outside the pool
    const h30 = f.horizons.find((h) => h.horizonDays === 30)!;
    expect(h30.pop).toBe(1); // only the last 250 (all positive) were resampled
    expect(f.method).toContain("250");
    expect(f.note).toContain("250");
  });
});
