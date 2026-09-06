/**
 * Horizon-suitability policy v1 tests (spec §9) — risk-character classification
 * from measured inputs only; LONG is gated on fundamentals evidence.
 */

import {
  annualizedVolPct,
  assessHorizonSuitability,
  HORIZON_POLICY_VERSION,
  maxDrawdownPct,
} from "../src/services/decision/horizonPolicy";

const base = {
  ticker: "TEST.NS",
  barCount: 250,
  annualizedVolPct: 20,
  maxDrawdownPct: 18,
  qualityScore: 70,
};

describe("assessHorizonSuitability", () => {
  test("insufficient history → null label, INSUFFICIENT", () => {
    const h = assessHorizonSuitability({ ...base, barCount: 120 });
    expect(h.label).toBeNull();
    expect(h.evidenceStatus).toBe("INSUFFICIENT");
    expect(h.version).toBe(HORIZON_POLICY_VERSION);
  });

  test("missing vol or drawdown → INSUFFICIENT", () => {
    expect(assessHorizonSuitability({ ...base, annualizedVolPct: null }).label).toBeNull();
    expect(assessHorizonSuitability({ ...base, maxDrawdownPct: null }).label).toBeNull();
  });

  test("calm risk + fundamentals evidence → long", () => {
    const h = assessHorizonSuitability(base);
    expect(h.label).toBe("long");
    expect(h.reasons.join(" ")).toMatch(/quality 70\/100/);
    expect(h.reasons.join(" ")).toMatch(/not a return promise/i);
  });

  test("calm risk WITHOUT fundamentals evidence → moderate (spec §9 gate)", () => {
    const noQ = assessHorizonSuitability({ ...base, qualityScore: null });
    expect(noQ.label).toBe("moderate");
    expect(noQ.reasons.join(" ")).toMatch(/no stored fundamentals evidence/i);
    const lowQ = assessHorizonSuitability({ ...base, qualityScore: 30 });
    expect(lowQ.label).toBe("moderate");
    expect(lowQ.reasons.join(" ")).toMatch(/only 30\/100/);
  });

  test("middling risk → moderate; high risk → short", () => {
    expect(assessHorizonSuitability({ ...base, annualizedVolPct: 38, maxDrawdownPct: 35 }).label).toBe("moderate");
    expect(assessHorizonSuitability({ ...base, annualizedVolPct: 55, maxDrawdownPct: 50 }).label).toBe("short");
    expect(assessHorizonSuitability({ ...base, annualizedVolPct: 20, maxDrawdownPct: 60 }).label).toBe("short");
  });

  test("basis echoes the measured inputs for the audit trail", () => {
    const h = assessHorizonSuitability(base);
    expect(h.basis).toEqual({
      barCount: 250,
      annualizedVolPct: 20,
      maxDrawdownPct: 18,
      qualityScore: 70,
    });
  });
});

describe("risk math helpers", () => {
  test("maxDrawdownPct: exact on a known series", () => {
    // 100 → 120 (peak) → 90 → 110: worst = (120−90)/120 = 25%
    expect(maxDrawdownPct([100, 120, 90, 110])).toBe(25);
    expect(maxDrawdownPct([100])).toBeNull();
    expect(maxDrawdownPct([100, 101, 102])).toBe(0);
  });

  test("annualizedVolPct: zero for constant returns, null below 30 samples", () => {
    expect(annualizedVolPct(Array(50).fill(0.001))).toBe(0);
    expect(annualizedVolPct(Array(10).fill(0.01))).toBeNull();
    const alternating = Array.from({ length: 100 }, (_, i) => (i % 2 ? 0.01 : -0.01));
    const v = annualizedVolPct(alternating);
    expect(v).toBeGreaterThan(10); // ~1% daily σ ⇒ ~16% annualized
    expect(v).toBeLessThan(20);
  });
});
