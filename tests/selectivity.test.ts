/**
 * Selective-prediction analysis — the honest "make it more accurate" machinery.
 * Accuracy rises only by ABSTAINING, and every rate must survive a minimum
 * sample and its Wilson lower bound before it may be presented as evidence.
 */

import { buildSelectivityReport, selectivityCurve, wilsonLb95, GradedCall, MIN_CALLS_FOR_RATE, TARGET_HIT_RATE_PCT } from "../src/services/evidence/selectivity";

const call = (probability: number, correct: boolean): GradedCall => ({ probability, correct, horizonDays: 1 });

/** n copies of a call. */
const times = (n: number, c: GradedCall): GradedCall[] => Array.from({ length: n }, () => ({ ...c }));

describe("wilsonLb95", () => {
  test("lower bound is below the raw rate and rises with n", () => {
    const small = wilsonLb95(8, 10)!; // 80% on 10
    const large = wilsonLb95(800, 1000)!; // 80% on 1000
    expect(small).toBeLessThan(0.8);
    expect(large).toBeLessThan(0.8);
    expect(large).toBeGreaterThan(small); // more evidence ⇒ tighter bound
  });
  test("n=0 is null, not a number", () => {
    expect(wilsonLb95(0, 0)).toBeNull();
  });
});

describe("selectivityCurve", () => {
  test("confidence is symmetric: P(up)=0.35 is a 65%-confidence DOWN call", () => {
    const rows = [...times(40, call(0.35, true)), ...times(40, call(0.65, true))];
    const [p60] = selectivityCurve(rows, [0.6]);
    expect(p60.calls).toBe(80); // both sides clear 60% confidence
    expect(p60.hitRatePct).toBe(100);
  });
  test("coverage falls as the threshold rises; totals never lie", () => {
    const rows = [...times(60, call(0.52, true)), ...times(40, call(0.62, false))];
    const [p50, p60, p70] = selectivityCurve(rows, [0.5, 0.6, 0.7]);
    expect(p50.calls).toBe(100);
    expect(p50.coveragePct).toBe(100);
    expect(p60.calls).toBe(40);
    expect(p60.coveragePct).toBe(40);
    expect(p70.calls).toBe(0);
  });
  test("a rate over fewer than MIN_CALLS_FOR_RATE calls is WITHHELD", () => {
    const rows = [...times(MIN_CALLS_FOR_RATE - 1, call(0.7, true)), ...times(100, call(0.51, true))];
    const [p65] = selectivityCurve(rows, [0.65]);
    expect(p65.calls).toBe(MIN_CALLS_FOR_RATE - 1);
    expect(p65.hitRatePct).toBeNull(); // 100% on 29 calls is noise, not evidence
    expect(p65.hitRateLb95Pct).toBeNull();
  });
  test("out-of-range probabilities are excluded, never coerced", () => {
    const rows = [call(NaN as unknown as number, true), call(1.4, true), ...times(50, call(0.55, true))];
    const [p50] = selectivityCurve(rows, [0.5]);
    expect(p50.calls).toBe(50);
  });
});

describe("buildSelectivityReport", () => {
  test("targetMet requires the LOWER BOUND to clear the target, not the raw rate", () => {
    // Coin-flip base layer so the unselective threshold never clears the target.
    const base = [...times(100, call(0.51, true)), ...times(100, call(0.51, false))];

    // ~87% raw on exactly 30 confident calls: LB95 ≈ 70% < 80 ⇒ NOT met.
    const lucky = [...times(26, call(0.72, true)), ...times(4, call(0.72, false)), ...base];
    const r1 = buildSelectivityReport(lucky, [0.5, 0.7]);
    expect(r1.curve[1].hitRatePct).toBeCloseTo(86.7, 0);
    expect(r1.targetMet).toBeNull();
    expect(r1.headline).toContain(`${TARGET_HIT_RATE_PCT}%`);

    // 90% on 400 confident calls: LB95 ≈ 86.6% ≥ 80 ⇒ met, coverage stated.
    const earned = [...times(360, call(0.75, true)), ...times(40, call(0.75, false)), ...base];
    const r2 = buildSelectivityReport(earned, [0.5, 0.7]);
    expect(r2.targetMet).not.toBeNull();
    expect(r2.targetMet!.minConfidence).toBe(0.7);
    expect(r2.headline).toContain("Selectivity");
  });

  test("when the model never emits high confidence, the report says exactly that", () => {
    const rows = times(500, call(0.55, true)).concat(times(500, call(0.45, false)));
    const r = buildSelectivityReport(rows);
    expect(r.maxObservedConfidence).toBe(0.55);
    expect(r.targetMet).toBeNull();
    expect(r.headline).toContain("never emitted confidence above");
  });

  test("too few graded rows ⇒ an explicit refusal, not a rate", () => {
    const r = buildSelectivityReport(times(5, call(0.9, true)));
    expect(r.headline).toContain("too few");
    expect(r.targetMet).toBeNull();
  });
});
