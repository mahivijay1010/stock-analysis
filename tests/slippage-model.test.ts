/**
 * Fill-ratio slippage model + the slippage stress sweep
 * (docs/tsp-study-notes.md §4 items 1–2, from Seykota's TSP "Skid and Trading
 * Frequency" study).
 *
 * The point of the fill-ratio model is that every term is OBSERVABLE, so the
 * ratio can be MEASURED from real fills rather than assumed. These tests pin
 * the round trip — price → ratio → price — because that invertibility is what
 * makes calibration possible at all.
 */

import {
  fillPriceFromRatio,
  ratioToSlippagePct,
  slippageRatioFromFill,
  SLIPPAGE_RATIO_BEST,
  SLIPPAGE_RATIO_WORST,
  SLIPPAGE_RATIO_UNCALIBRATED_MID,
  estimateSlippagePct,
} from "../src/services/shortterm/costs";
import { slippageStress, Trade } from "../scripts/setupExpectancyStudy";

describe("fillPriceFromRatio — Seykota's skid formula", () => {
  // The article's own worked example: buy stop at $7.00 filling at $7.50.
  test("BUY: fill = stop + (high − stop) × ratio", () => {
    const args = { side: "BUY" as const, stop: 7, barHigh: 8, barLow: 6.5 };
    expect(fillPriceFromRatio({ ...args, ratio: 0 })).toBe(7); // perfect fill
    expect(fillPriceFromRatio({ ...args, ratio: 0.5 })).toBe(7.5); // the article's $0.50 skid
    expect(fillPriceFromRatio({ ...args, ratio: 1 })).toBe(8); // worst print in the bar
  });

  test("SELL: fill = stop − (stop − low) × ratio — slippage always works against the trader", () => {
    const args = { side: "SELL" as const, stop: 8, barHigh: 8.5, barLow: 7 };
    expect(fillPriceFromRatio({ ...args, ratio: 0 })).toBe(8);
    expect(fillPriceFromRatio({ ...args, ratio: 0.5 })).toBe(7.5); // the article's trailing-stop example
    expect(fillPriceFromRatio({ ...args, ratio: 1 })).toBe(7);
  });

  test("the article's round trip: $1.00 gross becomes $0.00 net at ratio 0.5", () => {
    const buy = fillPriceFromRatio({ side: "BUY", stop: 7, barHigh: 8, barLow: 6.5, ratio: 0.5 })!;
    const sell = fillPriceFromRatio({ side: "SELL", stop: 8, barHigh: 8.5, barLow: 7, ratio: 0.5 })!;
    expect(sell - buy).toBe(0); // 7.50 → 7.50
  });

  test("a bar that never reached the level cannot fill — returns null, not a fabricated price", () => {
    expect(fillPriceFromRatio({ side: "BUY", stop: 10, barHigh: 9.9, barLow: 9, ratio: 1 })).toBeNull();
    expect(fillPriceFromRatio({ side: "SELL", stop: 5, barHigh: 6, barLow: 5.1, ratio: 1 })).toBeNull();
  });

  test("ratios are clamped to [0,1] and non-finite input is refused", () => {
    const args = { side: "BUY" as const, stop: 7, barHigh: 8, barLow: 6 };
    expect(fillPriceFromRatio({ ...args, ratio: -5 })).toBe(7); // clamped to best
    expect(fillPriceFromRatio({ ...args, ratio: 99 })).toBe(8); // clamped to worst
    expect(fillPriceFromRatio({ ...args, ratio: Number.NaN })).toBeNull();
    expect(fillPriceFromRatio({ ...args, stop: Number.NaN, ratio: 0.5 })).toBeNull();
    expect(fillPriceFromRatio({ side: "BUY", stop: 7, barHigh: 5, barLow: 8, ratio: 0.5 })).toBeNull(); // high < low
  });

  test("the named bounds mean what they say", () => {
    expect(SLIPPAGE_RATIO_BEST).toBe(0);
    expect(SLIPPAGE_RATIO_WORST).toBe(1);
    expect(SLIPPAGE_RATIO_UNCALIBRATED_MID).toBe(0.5);
  });
});

describe("slippageRatioFromFill — the calibration primitive", () => {
  test("recovers the ratio from an achieved fill (inverse of fillPriceFromRatio)", () => {
    for (const ratio of [0, 0.25, 0.5, 0.75, 1]) {
      const bar = { side: "BUY" as const, stop: 100, barHigh: 104, barLow: 99 };
      const fill = fillPriceFromRatio({ ...bar, ratio })!;
      expect(slippageRatioFromFill({ ...bar, actualFill: fill })).toBeCloseTo(ratio, 10);
    }
  });

  test("round-trips on the SELL side too", () => {
    const bar = { side: "SELL" as const, stop: 100, barHigh: 101, barLow: 96 };
    const fill = fillPriceFromRatio({ ...bar, ratio: 0.4 })!;
    expect(slippageRatioFromFill({ ...bar, actualFill: fill })).toBeCloseTo(0.4, 10);
  });

  test("a bar with no adverse excursion yields null — the ratio is undefined there, not zero", () => {
    expect(slippageRatioFromFill({ side: "BUY", stop: 100, barHigh: 100, barLow: 98, actualFill: 100 })).toBeNull();
    expect(slippageRatioFromFill({ side: "SELL", stop: 100, barHigh: 102, barLow: 100, actualFill: 100 })).toBeNull();
  });

  test("a better-than-stop fill clamps to 0 rather than reporting negative slippage", () => {
    expect(slippageRatioFromFill({ side: "BUY", stop: 100, barHigh: 104, barLow: 98, actualFill: 99 })).toBe(0);
  });

  test("a fill beyond the bar clamps to 1", () => {
    expect(slippageRatioFromFill({ side: "BUY", stop: 100, barHigh: 104, barLow: 98, actualFill: 110 })).toBe(1);
  });
});

describe("ratioToSlippagePct — bridges to the existing percentage model", () => {
  test("expresses the skid as a percentage of the reference price", () => {
    // stop 100, high 104, ratio 0.5 ⇒ fill 102 ⇒ 2.00 of skid on a 100 reference.
    expect(ratioToSlippagePct({ side: "BUY", stop: 100, barHigh: 104, barLow: 98, ratio: 0.5, referencePrice: 100 })).toBe(2);
  });

  test("ratio 0 is zero slippage regardless of bar width", () => {
    expect(ratioToSlippagePct({ side: "BUY", stop: 100, barHigh: 120, barLow: 98, ratio: 0, referencePrice: 100 })).toBe(0);
  });

  test("unfillable bars and bad reference prices return null", () => {
    expect(ratioToSlippagePct({ side: "BUY", stop: 100, barHigh: 99, barLow: 98, ratio: 1, referencePrice: 100 })).toBeNull();
    expect(ratioToSlippagePct({ side: "BUY", stop: 100, barHigh: 104, barLow: 98, ratio: 1, referencePrice: 0 })).toBeNull();
  });

  test("the legacy percentage model is untouched — this is additive, not a replacement", () => {
    // Same call as before the change; still the invented-constant model.
    const pct = estimateSlippagePct({ atrPct: 3, relVolume: 1, orderValueInr: 100_000, advInr: 1e9 });
    expect(pct).toBeGreaterThanOrEqual(0.1); // documented floor
    // base 0.05 × 3 × 1/√1 = 0.15, plus participation impact
    // (100_000/1e9) × 100 × 0.05 = 0.0005 ⇒ 0.1505.
    expect(pct).toBeCloseTo(0.1505, 4);
  });
});

// ── the stress sweep ─────────────────────────────────────────────────────────

function trade(over: Partial<Trade> = {}): Trade {
  return {
    date: "2026-09-01",
    setupType: "PULLBACK_IN_UPTREND",
    horizon: "5-10d",
    rGross: 1,
    rNet: 0.8,
    outcome: "TARGET_FIRST",
    costR: 0.1,
    slippageR: 0.1,
    entryOverRisk: 10,
    ...over,
  };
}

describe("slippageStress — TSP Skid conclusion 3 as a statistic", () => {
  test("baseline (1x) reproduces the study's own after-cost expectancy", () => {
    const r = slippageStress([trade({ rGross: 1, costR: 0.1, slippageR: 0.1 })]);
    expect(r.baselineExpectancy).toBeCloseTo(0.8, 6); // 1 − 0.1 − 0.1
  });

  test("expectancy falls linearly as slippage is scaled up", () => {
    const ts = [trade({ rGross: 1, costR: 0.1, slippageR: 0.1 })];
    const r = slippageStress(ts, [0, 1, 2, 5]);
    const at = (m: number) => r.points.find((p) => p.multiple === m)!.expectancyAfterCosts;
    expect(at(0)).toBeCloseTo(0.9, 6); // no slippage at all
    expect(at(1)).toBeCloseTo(0.8, 6);
    expect(at(2)).toBeCloseTo(0.7, 6);
    expect(at(5)).toBeCloseTo(0.4, 6);
  });

  test("reports the largest multiple survived and interpolates the break-even exactly", () => {
    // rGross 0.5, cost 0.1, slippage 0.1 ⇒ zero at multiple 4.
    const r = slippageStress([trade({ rGross: 0.5, costR: 0.1, slippageR: 0.1 })], [0, 1, 2, 3, 5]);
    expect(r.survivesUpToMultiple).toBe(3); // 0.5−0.1−0.3 = +0.1
    expect(r.breakEvenMultiple).toBeCloseTo(4, 6); // exact: expectancy is linear in the multiple
  });

  test("a cell that is already negative survives nothing and has no break-even", () => {
    const r = slippageStress([trade({ rGross: 0.05, costR: 0.1, slippageR: 0.1 })]);
    expect(r.baselineExpectancy).toBeLessThan(0);
    expect(r.survivesUpToMultiple).toBeNull();
    expect(r.breakEvenMultiple).toBeNull();
  });

  test("a cell profitable even with zero slippage but negative at 1x is caught", () => {
    const r = slippageStress([trade({ rGross: 0.15, costR: 0.1, slippageR: 0.1 })], [0, 1, 2]);
    expect(r.points.find((p) => p.multiple === 0)!.positive).toBe(true);
    expect(r.points.find((p) => p.multiple === 1)!.positive).toBe(false);
    expect(r.survivesUpToMultiple).toBe(0);
    expect(r.breakEvenMultiple).toBeCloseTo(0.5, 6);
  });

  test("averages across trades rather than scoring them individually", () => {
    const r = slippageStress(
      [trade({ rGross: 2, costR: 0.1, slippageR: 0.1 }), trade({ rGross: -1, costR: 0.1, slippageR: 0.1 })],
      [1]
    );
    expect(r.baselineExpectancy).toBeCloseTo(0.3, 6); // mean(1.8, −1.2)
  });

  test("an empty cell is handled without throwing", () => {
    const r = slippageStress([]);
    expect(r.baselineExpectancy).toBe(0);
    expect(r.survivesUpToMultiple).toBeNull();
  });

  test("the note states the two caveats that stop this being over-read", () => {
    const r = slippageStress([trade()]);
    expect(r.note).toMatch(/uncalibrated/);
    expect(r.note).toMatch(/UPPER bound/);
  });
});
