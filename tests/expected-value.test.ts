/**
 * Expected-value tests (risk-spec Rule 8) — EV after costs from the stored
 * issuance distribution; scenario frequencies stay labeled as such.
 */

import { computeExpectedValue } from "../src/services/decision/expectedValue";

const base = {
  anchorPrice: 100,
  p05: 88,
  p10: 91,
  p50: 100.5,
  p90: 110,
  p95: 114,
  meanPrice: 100.8,
  pop: 0.52,
  horizonDays: 30,
};

describe("computeExpectedValue", () => {
  test("uses the genuine stored sample mean when present", () => {
    const ev = computeExpectedValue(base);
    expect(ev.expectedReturnPct).toBeCloseTo(0.8, 2);
    expect(ev.notes.join(" ")).not.toMatch(/approximated/i);
  });

  test("falls back to a DOCUMENTED quantile blend when no mean is stored", () => {
    const ev = computeExpectedValue({ ...base, meanPrice: null });
    // Pearson–Tukey: .185·(−12) + .63·(0.5) + .185·(14) = 0.685
    expect(ev.expectedReturnPct).toBeCloseTo(0.69, 1);
    expect(ev.notes.join(" ")).toMatch(/Pearson–Tukey/);
  });

  test("EV after costs subtracts fees + slippage — a >50% pop with a thin mean goes NEGATIVE", () => {
    const ev = computeExpectedValue({ ...base, meanPrice: 100.3, pop: 0.53 });
    expect(ev.scenarioFrequencyUp).toBe(0.53);
    expect(ev.transactionCostPct).toBeGreaterThan(0.3);
    expect(ev.evAfterCostsPct).toBeLessThan(0.3 - ev.transactionCostPct + 0.31); // ≈ 0.3 − costs
    expect(ev.evAfterCostsPct).toBeLessThan(0);
  });

  test("expected shortfall ≈ mean of the worst decile from stored quantiles", () => {
    const ev = computeExpectedValue(base);
    expect(ev.expectedShortfallPct).toBeCloseTo((-12 + -9) / 2, 2);
  });

  test("reward/risk from the same distribution; null (with a note) when p10 ≥ anchor", () => {
    expect(computeExpectedValue(base).rewardRiskRatio).toBeCloseTo(10 / 9, 2);
    const skewed = computeExpectedValue({ ...base, p10: 101 });
    expect(skewed.rewardRiskRatio).toBeNull();
    expect(skewed.notes.join(" ")).toMatch(/undefined/i);
  });

  test("outputs label scenario frequencies as NOT calibrated probabilities (Rule 10)", () => {
    const ev = computeExpectedValue(base);
    expect(ev.notes.join(" ")).toMatch(/NOT calibrated probabilities/);
    expect(ev.scenarioFrequencyDown).toBeCloseTo(0.48, 5);
  });

  test("throws on a non-positive anchor — never silently divides by zero", () => {
    expect(() => computeExpectedValue({ ...base, anchorPrice: 0 })).toThrow(/anchorPrice/);
  });
});
