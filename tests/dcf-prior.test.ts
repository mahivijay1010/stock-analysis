/**
 * V10 B3 — DCF-implied Kelly payoff prior (SPEC_V10 gate: "DCF prior clamp +
 * precedence matrix measured > dcf > structural").
 *
 * The prior is PRE-MEASUREMENT ONLY: it replaces the structural 1.5 fallback,
 * never a measured b. The applied-pair LABEL vocabulary is unchanged — the b
 * source detail lives in payoff.source/kind on the position-size response.
 */

import {
  dcfImpliedPayoff,
  DCF_PRIOR_MIN,
  DCF_PRIOR_MAX,
  DCF_PRIOR_SOURCE_LABEL,
} from "../src/services/quant/dcfPrior";
import {
  selectAppliedPair,
  STRUCTURAL_PAYOFF_B,
} from "../src/services/admin/executionStats";
import { computeKelly } from "../src/services/quant/kelly";

describe("dcfImpliedPayoff — ratio math + clamp", () => {
  it("b = (base upside)/(|bear downside|), in-band values pass through", () => {
    // bear 80, base 150 @ price 100 → (150−100)/|80−100| = 50/20 = 2.5
    const p = dcfImpliedPayoff({ bear: 80, base: 150, bull: 200 }, 100)!;
    expect(p.raw).toBeCloseTo(2.5, 6);
    expect(p.b).toBeCloseTo(2.5, 6);
    expect(p.clamped).toBe(false);
    expect(p.upsideScenario).toBe("base");
  });

  it("clamps a huge ratio to the 3.0 ceiling (tiny bear downside)", () => {
    // (150−100)/|99−100| = 50 → clamp 3.0
    const p = dcfImpliedPayoff({ bear: 99, base: 150, bull: 200 }, 100)!;
    expect(p.raw).toBeCloseTo(50, 6);
    expect(p.b).toBe(DCF_PRIOR_MAX);
    expect(p.clamped).toBe(true);
  });

  it("clamps a poor ratio to the 0.5 floor (deep bear, thin upside)", () => {
    // (105−100)/|50−100| = 0.1 → clamp 0.5
    const p = dcfImpliedPayoff({ bear: 50, base: 105, bull: 110 }, 100)!;
    expect(p.raw).toBeCloseTo(0.1, 6);
    expect(p.b).toBe(DCF_PRIOR_MIN);
    expect(p.clamped).toBe(true);
  });

  it("base below price but bull above → the bull scenario supplies the upside", () => {
    const p = dcfImpliedPayoff({ bear: 70, base: 95, bull: 140 }, 100)!;
    expect(p.upsideScenario).toBe("bull");
    expect(p.raw).toBeCloseTo(40 / 30, 3); // raw is reported rounded to 4dp
  });

  it("no scenario above price → base still used, floor-clamped (DCF says: poor)", () => {
    const p = dcfImpliedPayoff({ bear: 60, base: 90, bull: 95 }, 100)!;
    expect(p.upsideScenario).toBe("base");
    expect(p.raw).toBeLessThan(0);
    expect(p.b).toBe(DCF_PRIOR_MIN);
  });

  it("returns null when it cannot be computed honestly", () => {
    expect(dcfImpliedPayoff({ bear: null, base: 150, bull: 200 }, 100)).toBeNull(); // no bear
    expect(dcfImpliedPayoff({ bear: 100, base: 150, bull: 200 }, 100)).toBeNull(); // bear == price
    expect(dcfImpliedPayoff({ bear: 80, base: null, bull: null }, 100)).toBeNull(); // no upside scenario
    expect(dcfImpliedPayoff({ bear: 80, base: 150, bull: 200 }, null)).toBeNull(); // no price
    expect(dcfImpliedPayoff({ bear: 80, base: 150, bull: 200 }, 0)).toBeNull(); // degenerate price
  });

  it("the TATASTEEL hand-check (stored scenarios at the stored price)", () => {
    // Stored: bear 109.39 / base 221.78 / bull 397.59 @ 184.07
    const p = dcfImpliedPayoff({ bear: 109.39, base: 221.78, bull: 397.59 }, 184.07)!;
    expect(p.raw).toBeCloseTo((221.78 - 184.07) / (184.07 - 109.39), 4); // ≈ 0.5049
    expect(p.b).toBeCloseTo(0.5049, 3);
    expect(p.clamped).toBe(false);
  });

  it("the spec label is exact", () => {
    expect(DCF_PRIOR_SOURCE_LABEL).toBe(
      "DCF-implied (assumption-sensitive — bear/base/bull scenarios, not measured)"
    );
  });
});

describe("precedence matrix — measured > dcf-implied > structural", () => {
  const MODEL_P = 0.51;
  const DCF_B = 1.8;

  it("MEASURED WINS: usable window b ignores the DCF fallback entirely", () => {
    const sel = selectAppliedPair(
      { usableP: false, usableB: true, measuredP: null, measuredB: 2.2 },
      MODEL_P,
      DCF_B
    );
    expect(sel.b).toBe(2.2);
    expect(sel.applied).toBe("model-p+measured-b");
  });

  it("DCF > STRUCTURAL: unusable b + a DCF prior → the prior is the applied b", () => {
    const sel = selectAppliedPair(
      { usableP: false, usableB: false, measuredP: null, measuredB: null },
      MODEL_P,
      DCF_B
    );
    expect(sel.b).toBe(DCF_B);
    // SPEC_V10: applied LABELS unchanged — b source detail is in payoff.source.
    expect(sel.applied).toBe("model-p+structural-b");
  });

  it("STRUCTURAL: unusable b + no DCF → 1.5 exactly as before (V9 bit-identical)", () => {
    const sel = selectAppliedPair(
      { usableP: false, usableB: false, measuredP: null, measuredB: null },
      MODEL_P
    );
    expect(sel.b).toBe(STRUCTURAL_PAYOFF_B);
    expect(sel.applied).toBe("model-p+structural-b");
  });

  it("measured p + DCF fallback b keeps the unchanged label vocabulary", () => {
    const sel = selectAppliedPair(
      { usableP: true, usableB: false, measuredP: 0.6, measuredB: null },
      MODEL_P,
      DCF_B
    );
    expect(sel).toEqual({ p: 0.6, b: DCF_B, applied: "measured-p+structural-b" });
  });

  it("headline math hand-check: p=0.5, DCF b=1.8 → f*=0.2222, half=0.1111", () => {
    const sel = selectAppliedPair(
      { usableP: false, usableB: false, measuredP: null, measuredB: null },
      0.5,
      1.8
    );
    const k = computeKelly(sel.p, sel.b);
    // f* = 0.5 − 0.5/1.8 = 0.22222…
    expect(k.rawKelly).toBeCloseTo(0.222222, 5);
    expect(k.halfKelly).toBeCloseTo(0.111111, 5);
  });

  it("a clamped prior stays a valid Kelly b (never ≤ 0, never explosive)", () => {
    const floor = dcfImpliedPayoff({ bear: 50, base: 101, bull: 102 }, 100)!;
    const ceil = dcfImpliedPayoff({ bear: 99.9, base: 300, bull: 400 }, 100)!;
    expect(() => computeKelly(0.5, floor.b)).not.toThrow();
    expect(() => computeKelly(0.5, ceil.b)).not.toThrow();
    expect(floor.b).toBeGreaterThanOrEqual(DCF_PRIOR_MIN);
    expect(ceil.b).toBeLessThanOrEqual(DCF_PRIOR_MAX);
  });
});
