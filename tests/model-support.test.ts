/**
 * Model-support layer: triple-barrier labeling, regime detection, conformal
 * intervals. These pin the honesty rules that make the downstream model layer
 * trustworthy: an ambiguous intrabar straddle never manufactures a realized R,
 * regimes are described not forecast, and a conformal band is withheld below
 * its calibration floor.
 */

import { labelTripleBarrier, TbBar } from "../src/services/shortterm/tripleBarrier";
import { classifyRegime, REGIME_THRESHOLDS } from "../src/services/shortterm/regime";
import { conformalInterval, empiricalCoverage, MIN_CALIBRATION } from "../src/services/shortterm/conformal";
import { Bar } from "../src/services/market/types";

const bar = (o: number, h: number, l: number, c: number, i = 0): TbBar => ({ date: `2026-06-${String(i + 1).padStart(2, "0")}`, open: o, high: h, low: l, close: c });

describe("labelTripleBarrier", () => {
  const common = { entryPrice: 100, atr: 5, upperMult: 2, lowerMult: 1, horizonSessions: 10 }; // upper 110, lower 95, risk 5

  test("a clean run to the upper barrier is TARGET with positive realized R", () => {
    const forward = [bar(100, 104, 99, 103, 0), bar(103, 111, 102, 110, 1)]; // hits 110
    const o = labelTripleBarrier({ ...common, forward });
    expect(o.label).toBe("TARGET");
    expect(o.upper).toBe(110);
    expect(o.lower).toBe(95);
    expect(o.realizedR).toBeGreaterThan(0);
  });

  test("hitting the lower barrier first is STOP with ~ −1R (minus costs)", () => {
    const forward = [bar(100, 101, 94, 95, 0)]; // low 94 ≤ 95
    const o = labelTripleBarrier({ ...common, forward });
    expect(o.label).toBe("STOP");
    expect(o.realizedR).toBeLessThan(0);
    expect(o.realizedR!).toBeLessThanOrEqual(-1 + 1e-9); // includes cost haircut
  });

  test("a single bar straddling BOTH barriers is AMBIGUOUS — no realized R invented", () => {
    const forward = [bar(100, 111, 94, 100, 0)]; // high ≥110 AND low ≤95 same bar
    const o = labelTripleBarrier({ ...common, forward });
    expect(o.label).toBe("AMBIGUOUS");
    expect(o.ambiguous).toBe(true);
    expect(o.realizedR).toBeNull(); // the key honesty property
    expect(o.conservativeR).toBeLessThan(0); // adverse leg handed to safety gates
  });

  test("no barrier touched by the horizon ⇒ TIME exit at the last close", () => {
    const forward = Array.from({ length: 10 }, (_, i) => bar(100, 102, 98, 101, i));
    const o = labelTripleBarrier({ ...common, forward, horizonSessions: 10 });
    expect(o.label).toBe("TIME");
    expect(o.exitPrice).toBe(101);
  });

  test("a gap-down open through the lower barrier fills STOP at the open", () => {
    const forward = [bar(92, 93, 90, 91, 0)]; // opens below 95
    const o = labelTripleBarrier({ ...common, forward });
    expect(o.label).toBe("STOP");
    expect(o.exitPrice).toBe(92);
  });

  test("malformed geometry is refused, never scored", () => {
    expect(labelTripleBarrier({ ...common, forward: [], atr: 0 }).label).toBe("DATA_INVALID");
    const bad = labelTripleBarrier({ ...common, forward: [bar(100, 90, 95, 92, 0)] }); // high < low
    expect(bad.label).toBe("DATA_INVALID");
  });
});

describe("classifyRegime", () => {
  const mk = (closes: number[]): Bar[] => closes.map((c, i) => ({ date: `d${i}`, open: c, high: c, low: c, close: c, volume: 0 }));

  test("a steady uptrend is TREND_UP", () => {
    const closes = Array.from({ length: 220 }, (_, i) => 100 * (1 + 0.0015) ** i); // ~0.15%/day
    const r = classifyRegime(mk(closes));
    expect(r.regime).toBe("TREND_UP");
    expect(r.trendScore).toBeGreaterThan(0);
  });

  test("a steady downtrend is TREND_DOWN", () => {
    const closes = Array.from({ length: 220 }, (_, i) => 100 * (1 - 0.0015) ** i);
    const r = classifyRegime(mk(closes));
    expect(r.regime).toBe("TREND_DOWN");
  });

  test("a deep, volatile drop is CRISIS", () => {
    // Ramp up then a violent −25% with big daily swings.
    const up = Array.from({ length: 180 }, (_, i) => 100 + i * 0.1);
    const crash = Array.from({ length: 40 }, (_, i) => 118 * (1 - 0.01 * (i % 2 ? 1 : -0.3)) ** i);
    const r = classifyRegime(mk([...up, ...crash]));
    expect(["CRISIS", "HIGH_VOL", "TREND_DOWN"]).toContain(r.regime); // risk-off family
    expect(r.drawdownPct).toBeLessThan(0);
  });

  test("insufficient history defaults to CHOPPY, honestly", () => {
    const r = classifyRegime(mk(Array.from({ length: 30 }, (_, i) => 100 + i)));
    expect(r.regime).toBe("CHOPPY");
    expect(r.reasons[0]).toMatch(/insufficient history/);
  });

  test("thresholds are exported and sane", () => {
    expect(REGIME_THRESHOLDS.highVolPct).toBeGreaterThan(0);
    expect(REGIME_THRESHOLDS.crisisDrawdownPct).toBeLessThan(0);
  });
});

describe("conformalInterval", () => {
  const residuals = Array.from({ length: 100 }, (_, i) => (i % 2 ? 1 : -1) * (i / 50)); // spread of ± up to ~2

  test("interval brackets the point and reports its sample size", () => {
    const r = conformalInterval(10, residuals, 0.8)!;
    expect(r).not.toBeNull();
    expect(r.lower).toBeLessThan(10);
    expect(r.upper).toBeGreaterThan(10);
    expect(r.sampleSize).toBe(100);
    expect(r.halfWidth).toBeGreaterThan(0);
  });

  test("higher coverage ⇒ wider interval", () => {
    const a = conformalInterval(10, residuals, 0.8)!;
    const b = conformalInterval(10, residuals, 0.95)!;
    expect(b.halfWidth).toBeGreaterThanOrEqual(a.halfWidth);
  });

  test("below the calibration floor the interval is WITHHELD (null), not faked", () => {
    expect(conformalInterval(10, [1, 2, 3], 0.8)).toBeNull();
    expect(conformalInterval(10, Array(MIN_CALIBRATION - 1).fill(1), 0.8)).toBeNull();
  });

  test("empirical coverage of the fitted half-width roughly meets the target", () => {
    const r = conformalInterval(0, residuals, 0.8)!;
    const cov = empiricalCoverage(r.halfWidth, residuals)!;
    expect(cov.pct).toBeGreaterThanOrEqual(80); // the fit covers its own set at ≥ target
  });
});
