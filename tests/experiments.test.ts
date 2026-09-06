/**
 * Phase D tests (spec §8) — purged/embargoed splits, date-block bootstrap,
 * and the baseline metrics every challenger must beat. All pure.
 */

import { buildPurgedSplits, dateBlockBootstrap } from "../src/services/experiments/splits";
import {
  constantBrier,
  directionBaselines,
  ewmaVol,
  intervalScore,
  lastPriceErrors,
  quantileLoss,
} from "../src/services/experiments/baselines";
import { mulberry32 } from "../src/services/quant/montecarlo";
import { addCalendarDays } from "../src/services/forecast/dates";

/** n weekday-ish dates from a start (every calendar day — fine for split math). */
const mkDates = (n: number, start = "2024-01-01"): string[] =>
  Array.from({ length: n }, (_, i) => addCalendarDays(start, i));

describe("buildPurgedSplits", () => {
  const dates = mkDates(200);
  const splits = buildPurgedSplits({
    dates,
    horizonDays: 10,
    embargoDays: 5,
    trainFrac: 0.5,
    valFrac: 0.2,
    calFrac: 0.15,
  });

  test("chronological, disjoint, date-grouped", () => {
    const all = [...splits.train, ...splits.validation, ...splits.calibration, ...splits.test];
    expect(new Set(all).size).toBe(all.length); // disjoint
    expect(Math.max(...splits.train.map((d) => Date.parse(d)))).toBeLessThan(
      Math.min(...splits.validation.map((d) => Date.parse(d)))
    );
    expect(Math.max(...splits.validation.map((d) => Date.parse(d)))).toBeLessThan(
      Math.min(...splits.calibration.map((d) => Date.parse(d)))
    );
    expect(Math.max(...splits.calibration.map((d) => Date.parse(d)))).toBeLessThan(
      Math.min(...splits.test.map((d) => Date.parse(d)))
    );
  });

  test("purge: no train label interval crosses the validation boundary", () => {
    const valStart = splits.validation[0];
    for (const d of splits.train) {
      expect(addCalendarDays(d, 10) < valStart).toBe(true);
    }
    expect(splits.purgedFromTrain.length).toBeGreaterThan(0);
  });

  test("embargo: later segments start > embargo gap after the boundary", () => {
    expect(splits.validation[0] > addCalendarDays(splits.boundaries.trainEnd, 5)).toBe(true);
    expect(splits.test[0] > addCalendarDays(splits.boundaries.calEnd, 5)).toBe(true);
    expect(splits.embargoed.length).toBeGreaterThan(0);
  });

  test("refuses degenerate configs", () => {
    expect(() =>
      buildPurgedSplits({ dates: mkDates(30), horizonDays: 10, embargoDays: 5, trainFrac: 0.5, valFrac: 0.2, calFrac: 0.15 })
    ).toThrow(/at least 40/);
    expect(() =>
      buildPurgedSplits({ dates, horizonDays: 10, embargoDays: 5, trainFrac: 0.6, valFrac: 0.3, calFrac: 0.2 })
    ).toThrow(/room for a test segment/);
  });
});

describe("dateBlockBootstrap", () => {
  test("deterministic under a seeded PRNG; preserves length; draws contiguous blocks", () => {
    const dates = mkDates(60);
    const a = dateBlockBootstrap(dates, 5, 3, mulberry32(7));
    const b = dateBlockBootstrap(dates, 5, 3, mulberry32(7));
    expect(b).toEqual(a);
    expect(a).toHaveLength(3);
    for (const sample of a) {
      expect(sample).toHaveLength(60);
      // Each 5-run inside the sample is contiguous in the original calendar.
      for (let i = 0; i < sample.length - 1; i++) {
        if (i % 5 !== 4) expect(sample[i + 1]).toBe(addCalendarDays(sample[i], 1));
      }
    }
  });
});

describe("baselines", () => {
  test("constant-50 Brier is 0.25 by definition on any balanced outcome set", () => {
    expect(constantBrier(0.5, [1, 0, 1, 0])).toBe(0.25);
    expect(constantBrier(0.5, [1, 1, 1])).toBe(0.25);
  });

  test("directionBaselines: base rate fitted on TRAIN only, majority applied to eval", () => {
    const train: Array<0 | 1> = [1, 1, 1, 0]; // 75% up in train
    const evalUps: Array<0 | 1> = [0, 0, 1, 0]; // 25% up in eval
    const b = directionBaselines(train, evalUps);
    expect(b.trainBaseRateP).toBe(0.75);
    expect(b.alwaysUpHitRatePct).toBe(25);
    expect(b.majorityHitRatePct).toBe(25); // majority=up, eval mostly down
    expect(b.baseRateBrier).toBeGreaterThan(0.25); // overconfident wrong-way prior scores worse
  });

  test("lastPriceErrors: exact on a known pair set", () => {
    const e = lastPriceErrors([
      { anchor: 100, actual: 102 }, // +2%
      { anchor: 100, actual: 97 }, // −3%
    ]);
    expect(e.maePct).toBe(2.5);
    expect(e.rmsePct).toBeCloseTo(Math.sqrt((4 + 9) / 2), 4);
  });

  test("ewmaVol: rises after a shock and uses only past information", () => {
    const calm = Array.from({ length: 40 }, () => 0.002);
    const shocked = [...calm, 0.08, 0.002, 0.002];
    const vol = ewmaVol(shocked);
    const iShock = 40;
    // No lookahead: vol AT the shock index only uses pre-shock returns (small);
    // the first index reflecting the shock is iShock+1, with a large jump.
    expect(vol[iShock]).toBeLessThan(0.005);
    expect(vol[iShock + 1]).toBeGreaterThan(vol[iShock] * 3);
  });

  test("quantileLoss penalizes the correct side asymmetrically", () => {
    // tau=0.9: under-prediction (actual above) costs 0.9/unit, over costs 0.1.
    expect(quantileLoss(0.9, [{ pred: 100, actual: 110 }])).toBeCloseTo(9, 6);
    expect(quantileLoss(0.9, [{ pred: 110, actual: 100 }])).toBeCloseTo(1, 6);
  });

  test("intervalScore: width + penalty, coverage measured", () => {
    const s = intervalScore(0.2, [
      { lo: 95, hi: 105, actual: 100 }, // covered, width 10
      { lo: 95, hi: 105, actual: 110 }, // missed above by 5 → +2/0.2×5 = +50
    ]);
    expect(s.coveragePct).toBe(50);
    expect(s.avgWidth).toBe(10);
    expect(s.score).toBeCloseTo((10 + 60) / 2, 4);
  });
});
