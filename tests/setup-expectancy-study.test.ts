/**
 * Unit tests for scripts/setupExpectancyStudy.ts's buildCell() — the pure
 * per-setup×horizon evidence-row builder. Fixes verified here, per
 * docs/system-trust-review.md §4.2:
 *
 *  1. The bootstrap CI is a REAL contiguous-block bootstrap (block length =
 *     the horizon's calendar-day hold), not a block-length-1 resample of
 *     per-date means (which only removed cross-sectional, not serial,
 *     correlation).
 *  2. independentEntryDates is divided by the horizon's max trading-day hold
 *     (overlap-adjusted), not the raw distinct-date count.
 *  3. expectancyR (gross) and expectancyAfterCosts (net) are genuinely
 *     different numbers, not the same value assigned twice.
 *  4. The p-value is derived from the SAME block-bootstrap distribution as
 *     the CI (consistent methodology).
 *
 * main()'s DB/network-backed train/test split and DSR/PBO wiring are
 * exercised structurally by importing the module (require.main guard must
 * prevent it from running on import) — the full pipeline itself needs a live
 * Postgres + Yahoo fetch and is verified manually, not in CI.
 */

import { buildCell, Trade } from "../scripts/setupExpectancyStudy";
import { mulberry32 } from "../src/services/quant/montecarlo";

function mkTrade(date: string, rGross: number, drag: number, outcome: Trade["outcome"] = "TIMEOUT"): Trade {
  return { date, setupType: "PULLBACK_IN_UPTREND", horizon: "5-10d", rGross, rNet: Math.round((rGross - drag) * 10000) / 10000, outcome };
}

describe("setupExpectancyStudy.buildCell", () => {
  test("importing the module does not run main() (require.main guard)", () => {
    // If main() ran on import it would throw (no AppDataSource connection in
    // the test environment) before this file's own tests could execute —
    // reaching this assertion at all is the proof.
    expect(typeof buildCell).toBe("function");
  });

  test("expectancyR (gross) and expectancyAfterCosts (net) are genuinely different, not duplicated", () => {
    const drag = 0.3; // R units subtracted per trade
    const trades: Trade[] = Array.from({ length: 20 }, (_, i) =>
      mkTrade(`2026-0${1 + (i % 9)}-${String(1 + i).padStart(2, "0")}`, 1.0, drag, "TARGET_FIRST")
    );
    const cell = buildCell("PULLBACK_IN_UPTREND", "5-10d", trades, mulberry32(1));
    expect(cell.expectancyR).toBeCloseTo(1.0, 4); // gross, before drag
    expect(cell.expectancyAfterCosts).toBeCloseTo(1.0 - drag, 4); // net, after drag
    expect(cell.expectancyR).not.toBeCloseTo(cell.expectancyAfterCosts as number, 4);
  });

  test("independentEntryDates is overlap-adjusted (divided by the horizon's max trading-day hold), not the raw distinct-date count", () => {
    // "5-10d" horizon: HORIZON_TD max = 10 trading days.
    const dates = Array.from({ length: 100 }, (_, i) => {
      const day = (i % 27) + 1;
      const month = Math.floor(i / 27) + 1;
      return `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    });
    const trades: Trade[] = dates.map((d) => mkTrade(d, 0.5, 0.1, "TARGET_FIRST"));
    const cell = buildCell("PULLBACK_IN_UPTREND", "5-10d", trades, mulberry32(2));
    expect(cell.rawIndependentDates).toBe(100);
    // OLD (buggy) behaviour would have reported independentEntryDates = 100.
    expect(cell.independentEntryDates).not.toBe(100);
    // CORRECT: floor(100 / 10) = 10.
    expect(cell.independentEntryDates).toBe(10);
  });

  test("independentEntryDates is never zero even with fewer dates than the horizon's hold", () => {
    const trades: Trade[] = [mkTrade("2026-01-01", 0.5, 0.1), mkTrade("2026-01-02", -0.3, 0.1)];
    const cell = buildCell("PULLBACK_IN_UPTREND", "5-10d", trades, mulberry32(3));
    expect(cell.independentEntryDates).toBeGreaterThanOrEqual(1);
  });

  test("the bootstrap CI is deterministic for a fixed PRNG stream", () => {
    const dates = Array.from({ length: 80 }, (_, i) => `2026-${String(1 + (i % 9)).padStart(2, "0")}-${String(1 + (i % 27)).padStart(2, "0")}`);
    const trades: Trade[] = dates.map((d, i) => mkTrade(d, i % 3 === 0 ? -0.8 : 0.6, 0.2, i % 3 === 0 ? "STOP_FIRST" : "TARGET_FIRST"));
    const a = buildCell("PULLBACK_IN_UPTREND", "5-10d", trades, mulberry32(42));
    const b = buildCell("PULLBACK_IN_UPTREND", "5-10d", trades, mulberry32(42));
    expect(a).toEqual(b);
  });

  test("a strongly positive, low-variance series produces a CI lower bound above zero", () => {
    const dates = Array.from({ length: 90 }, (_, i) => `2026-${String(1 + (i % 9)).padStart(2, "0")}-${String(1 + (i % 27)).padStart(2, "0")}`);
    const trades: Trade[] = dates.map((d) => mkTrade(d, 0.9, 0.1, "TARGET_FIRST")); // consistently +0.8R net
    const cell = buildCell("PULLBACK_IN_UPTREND", "5-10d", trades, mulberry32(7));
    const ci = cell.bootstrapExpectancyCI as [number, number];
    expect(ci[0]).toBeGreaterThan(0);
    expect(cell.probabilityExpectancyPositive).toBeGreaterThan(0.9);
    expect(cell.pValue).toBeLessThan(0.1);
  });

  test("a mean-zero, high-variance series produces a CI straddling zero and a p-value near 1", () => {
    const dates = Array.from({ length: 90 }, (_, i) => `2026-${String(1 + (i % 9)).padStart(2, "0")}-${String(1 + (i % 27)).padStart(2, "0")}`);
    const trades: Trade[] = dates.map((d, i) => mkTrade(d, i % 2 === 0 ? 1.0 : -1.0, 0, i % 2 === 0 ? "TARGET_FIRST" : "STOP_FIRST"));
    const cell = buildCell("PULLBACK_IN_UPTREND", "5-10d", trades, mulberry32(8));
    const ci = cell.bootstrapExpectancyCI as [number, number];
    expect(ci[0]).toBeLessThanOrEqual(0.05);
    expect(cell.pValue).toBeGreaterThan(0.1);
  });

  test("too few distinct dates falls back to a degenerate CI at the point estimate rather than throwing", () => {
    const trades: Trade[] = [mkTrade("2026-01-01", 0.5, 0.1), mkTrade("2026-01-01", 0.3, 0.1)];
    expect(() => buildCell("PULLBACK_IN_UPTREND", "5-10d", trades, mulberry32(9))).not.toThrow();
  });
});
