/**
 * Valuation & quality read. The point in penny-stock land is TRAP DETECTION:
 * "cheap" must survive quality + ownership checks or it is flagged, not praised.
 * These pin that a loss-making or promoter-dumping name is VALUE_TRAP however
 * cheap it looks, that genuine cheap+quality reads UNDERVALUED_QUALITY, and that
 * missing fundamentals yield INSUFFICIENT_DATA, never a fabricated verdict.
 */

import { computeValuation, ValuationMetrics } from "../src/services/shortterm/valuationQuality";

const base: ValuationMetrics = {
  pe: 15,
  bookValuePerShare: 50,
  roe: 14,
  roce: 16,
  deRatio: 0.4,
  dcfBaseIntrinsic: 130,
  promoterHolding: 55,
  promoterChangeQoq: 0,
  operatingMargin: 12,
  profitGrowthYoy: 10,
};

describe("computeValuation", () => {
  test("cheap (DCF +44%) AND quality (ROCE 16%) ⇒ UNDERVALUED_QUALITY", () => {
    const v = computeValuation(base, 90); // intrinsic 130 vs 90 ⇒ +44%
    expect(v.verdict).toBe("UNDERVALUED_QUALITY");
    expect(v.dcfMarginOfSafetyPct).toBeGreaterThan(20);
    expect(v.pb).toBeCloseTo(1.8, 1); // 90 / 50
    expect(v.isValueTrap).toBe(false);
    expect(v.valueScore).toBeGreaterThan(50);
  });

  test("a loss-making name is a VALUE_TRAP no matter how cheap the DCF looks", () => {
    const v = computeValuation({ ...base, roe: -8, dcfBaseIntrinsic: 300 }, 50); // DCF +500% but losing money
    expect(v.verdict).toBe("VALUE_TRAP");
    expect(v.isValueTrap).toBe(true);
    expect(v.trapFlags.join(" ")).toMatch(/loss-making/);
  });

  test("promoters dumping ⇒ VALUE_TRAP (ownership check)", () => {
    const v = computeValuation({ ...base, promoterChangeQoq: -3 }, 90);
    expect(v.isValueTrap).toBe(true);
    expect(v.trapFlags.join(" ")).toMatch(/promoters selling/);
  });

  test("high leverage ⇒ VALUE_TRAP", () => {
    const v = computeValuation({ ...base, deRatio: 3.5 }, 90);
    expect(v.isValueTrap).toBe(true);
    expect(v.trapFlags.join(" ")).toMatch(/high leverage/);
  });

  test("cheap but weak quality ⇒ CHEAP_BUT_RISKY, not a quality bargain", () => {
    const v = computeValuation({ ...base, roce: 9, roe: 9, dcfBaseIntrinsic: 130 }, 90); // cheap but ROCE < 12
    expect(v.verdict).toBe("CHEAP_BUT_RISKY");
  });

  test("trading well above DCF intrinsic ⇒ EXPENSIVE", () => {
    const v = computeValuation({ ...base, dcfBaseIntrinsic: 60 }, 100); // −40% margin of safety
    expect(v.verdict).toBe("EXPENSIVE");
  });

  test("no DCF, no ROCE, no P/E ⇒ INSUFFICIENT_DATA (never fabricated)", () => {
    const v = computeValuation({ ...base, pe: null, roce: null, roe: null, dcfBaseIntrinsic: null, bookValuePerShare: null }, 90);
    expect(v.verdict).toBe("INSUFFICIENT_DATA");
    expect(v.valueScore).toBeNull();
  });

  test("the 'cheap on P/E but DCF overvalued' classic trap is flagged", () => {
    const v = computeValuation({ ...base, pe: 8, dcfBaseIntrinsic: 70 }, 100); // PE 8 looks cheap, DCF says overvalued
    expect(v.trapFlags.join(" ")).toMatch(/classic trap/);
  });

  test("every result carries the descriptive-not-a-buy-signal caveat", () => {
    const v = computeValuation(base, 90);
    expect(v.notes.join(" ")).toMatch(/not a buy signal/i);
  });
});
