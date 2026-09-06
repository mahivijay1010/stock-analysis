/**
 * V8 R4 — KellySizer pure math tests (SPEC_V8 acceptance cases).
 */

import { computeKelly, KELLY_CAP } from "../src/services/quant/kelly";

describe("computeKelly", () => {
  it("p=0.52, b=1.5 → f* = 0.2 exactly (spec case)", () => {
    const k = computeKelly(0.52, 1.5);
    expect(k.rawKelly).toBeCloseTo(0.2, 12);
    expect(k.kellyFraction).toBeCloseTo(0.2, 12);
    expect(k.halfKelly).toBeCloseTo(0.1, 12);
    expect(k.noEdge).toBe(false);
    expect(k.capped).toBe(false);
  });

  it("p=0.5, b=1 → 0 (coin flip at even odds has no edge)", () => {
    const k = computeKelly(0.5, 1);
    expect(k.rawKelly).toBe(0);
    expect(k.kellyFraction).toBe(0);
    expect(k.halfKelly).toBe(0);
    expect(k.noEdge).toBe(true);
  });

  it("negative raw Kelly clamps to 0 and flags noEdge", () => {
    const k = computeKelly(0.4, 1); // 0.4 - 0.6 = -0.2
    expect(k.rawKelly).toBeCloseTo(-0.2, 12);
    expect(k.kellyFraction).toBe(0);
    expect(k.halfKelly).toBe(0);
    expect(k.noEdge).toBe(true);
    expect(k.capped).toBe(false);
  });

  it("clamps the upside to the 0.25 cap and flags capped", () => {
    const k = computeKelly(0.9, 5); // 0.9 - 0.1/5 = 0.88
    expect(k.rawKelly).toBeCloseTo(0.88, 12);
    expect(k.kellyFraction).toBe(KELLY_CAP);
    expect(k.halfKelly).toBeCloseTo(KELLY_CAP / 2, 12);
    expect(k.capped).toBe(true);
    expect(k.noEdge).toBe(false);
  });

  it("halfKelly is always exactly kellyFraction / 2", () => {
    for (const [p, b] of [
      [0.52, 1.5],
      [0.55, 2],
      [0.48, 3],
      [0.6, 0.5],
    ] as Array<[number, number]>) {
      const k = computeKelly(p, b);
      expect(k.halfKelly).toBe(k.kellyFraction / 2);
      expect(k.kellyFraction).toBeGreaterThanOrEqual(0);
      expect(k.kellyFraction).toBeLessThanOrEqual(KELLY_CAP);
    }
  });

  it("rejects invalid inputs instead of silently mis-sizing", () => {
    expect(() => computeKelly(-0.1, 1.5)).toThrow();
    expect(() => computeKelly(1.1, 1.5)).toThrow();
    expect(() => computeKelly(0.5, 0)).toThrow();
    expect(() => computeKelly(0.5, -2)).toThrow();
    expect(() => computeKelly(Number.NaN, 1)).toThrow();
  });
});
