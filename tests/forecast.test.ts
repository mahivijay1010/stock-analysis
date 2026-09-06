/**
 * Phase C tests (upgrade-spec §5) — pure pieces of the forecast stack:
 * per-step quantile Monte Carlo and the IST calendar-date helpers. The DB
 * flows (immutable runs, outcome grading) are exercised live against the API;
 * synthetic fixtures never enter production records.
 */

import { simulateDailyQuantiles } from "../src/services/quant/montecarlo";
import {
  addCalendarDays,
  calendarDaysBetween,
  calendarRange,
  isoWeekday,
  isWeekend,
  monthBounds,
  monthKey,
} from "../src/services/forecast/dates";

const mkReturns = (n: number, fn: (i: number) => number): number[] =>
  Array.from({ length: n }, (_, i) => fn(i));

const mixed = mkReturns(250, (i) => 0.01 * Math.sin(i / 3) + (i % 5 === 0 ? -0.008 : 0.004));

describe("simulateDailyQuantiles", () => {
  test("deterministic: same inputs → bit-identical output", () => {
    const a = simulateDailyQuantiles(mixed, 22);
    const b = simulateDailyQuantiles(mixed, 22);
    expect(b).toEqual(a);
  });

  test("one step per trading-day offset, 1..steps", () => {
    const sim = simulateDailyQuantiles(mixed, 22);
    expect(sim.perStep).toHaveLength(22);
    expect(sim.perStep.map((s) => s.offset)).toEqual(
      Array.from({ length: 22 }, (_, i) => i + 1)
    );
  });

  test("quantiles are ordered p05 ≤ p10 ≤ p25 ≤ p50 ≤ p75 ≤ p90 ≤ p95 at every step", () => {
    const sim = simulateDailyQuantiles(mixed, 22);
    for (const s of sim.perStep) {
      const { p05, p10, p25, p50, p75, p90, p95 } = s.q;
      expect(p05).toBeLessThanOrEqual(p10);
      expect(p10).toBeLessThanOrEqual(p25);
      expect(p25).toBeLessThanOrEqual(p50);
      expect(p50).toBeLessThanOrEqual(p75);
      expect(p75).toBeLessThanOrEqual(p90);
      expect(p90).toBeLessThanOrEqual(p95);
      expect(s.pop).toBeGreaterThanOrEqual(0);
      expect(s.pop).toBeLessThanOrEqual(1);
    }
  });

  test("uncertainty grows with horizon: the 80% band is wider at step 20 than step 1", () => {
    const sim = simulateDailyQuantiles(mixed, 20);
    const spread = (i: number) => sim.perStep[i].q.p90 - sim.perStep[i].q.p10;
    expect(spread(19)).toBeGreaterThan(spread(0));
  });

  test("refuses to fabricate: throws below 60 usable returns and on bad steps", () => {
    expect(() => simulateDailyQuantiles(mixed.slice(0, 59), 5)).toThrow(/at least 60/);
    expect(() => simulateDailyQuantiles(mixed, 0)).toThrow(/steps/);
    expect(() => simulateDailyQuantiles(mixed, 41)).toThrow(/steps/);
    expect(() => simulateDailyQuantiles(mixed, 2.5 as unknown as number)).toThrow(/steps/);
  });

  test("matches simulateBootstrap's engine family: mean is a genuine sample mean", () => {
    // All-positive returns ⇒ every path compounds up ⇒ pop = 1 and mean > 0.
    const up = mkReturns(250, () => 0.005);
    const sim = simulateDailyQuantiles(up, 5);
    for (const s of sim.perStep) {
      expect(s.pop).toBe(1);
      expect(s.mean).toBeGreaterThan(0);
      expect(s.q.p05).toBeGreaterThan(0);
    }
  });
});

describe("forecast dates (IST calendar helpers)", () => {
  test("addCalendarDays crosses month/year boundaries", () => {
    expect(addCalendarDays("2026-09-06", 30)).toBe("2026-10-06");
    expect(addCalendarDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addCalendarDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  test("calendarDaysBetween is signed and exact", () => {
    expect(calendarDaysBetween("2026-09-01", "2026-09-30")).toBe(29);
    expect(calendarDaysBetween("2026-09-30", "2026-09-01")).toBe(-29);
  });

  test("isoWeekday/isWeekend: 2026-09-06 is a Sunday", () => {
    expect(isoWeekday("2026-09-06")).toBe(7);
    expect(isWeekend("2026-09-06")).toBe(true);
    expect(isWeekend("2026-09-07")).toBe(false); // Monday
  });

  test("monthBounds handles lengths and leap years", () => {
    expect(monthBounds("2026-09")).toEqual({ start: "2026-09-01", end: "2026-09-30" });
    expect(monthBounds("2026-02")).toEqual({ start: "2026-02-01", end: "2026-02-28" });
    expect(monthBounds("2028-02")).toEqual({ start: "2028-02-01", end: "2028-02-29" });
  });

  test("calendarRange renders EVERY calendar day inclusive (spec: day-wise output)", () => {
    const range = calendarRange("2026-09-07", "2026-10-06");
    expect(range).toHaveLength(30);
    expect(range[0]).toBe("2026-09-07");
    expect(range[29]).toBe("2026-10-06");
    expect(calendarRange("2026-09-07", "2026-09-06")).toEqual([]);
  });

  test("monthKey extracts the period", () => {
    expect(monthKey("2026-09-06")).toBe("2026-09");
  });
});
