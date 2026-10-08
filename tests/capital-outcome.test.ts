/**
 * Money Desk grader: same bracket simulator as the shadow ledgers + NIFTY leg.
 * Adversarial: future-data leakage, look-ahead, missing prices, extreme gaps,
 * ambiguous bars, corporate actions (adjusted OHLC), quantity scaling.
 */
import { gradeAllocation, GradeInput } from "../src/services/capital/capitalOutcome";
import { toAdjustedOhlc } from "../src/services/shortterm/shadowFill";

const day = (i: number) => `2026-09-${String(i).padStart(2, "0")}`;
const bar = (i: number, o: number, h: number, l: number, c: number) => ({ date: day(i), open: o, high: h, low: l, close: c });
const flat = (from: number, to: number, px: number) => Array.from({ length: to - from + 1 }, (_, k) => bar(from + k, px, px + 1, px - 1, px));
const bench = (from: number, to: number, start: number, step: number) => Array.from({ length: to - from + 1 }, (_, k) => ({ date: day(from + k), close: start + step * k }));

const base = (over: Partial<GradeInput> = {}): GradeInput => ({
  decisionDate: day(1),
  entryType: "PULLBACK_ZONE",
  entryZoneLow: 98,
  entryZoneHigh: 100,
  entryTriggerPrice: null,
  entryPrice: 100,
  stop: 95,
  target1: 110,
  expectedHoldingSessions: 5,
  quantity: 10,
  bars: [...flat(1, 1, 100), bar(2, 100, 101, 99, 100), bar(3, 100, 104, 99, 103), bar(4, 103, 111, 102, 110), ...flat(5, 15, 110)],
  benchmark: bench(1, 15, 1000, 1),
  ...over,
});

describe("gradeAllocation", () => {
  test("not matured when fewer sessions than entry window + horizon have elapsed", () => {
    const g = gradeAllocation(base({ bars: [...flat(1, 1, 100), bar(2, 100, 101, 99, 100), bar(3, 100, 104, 99, 103)] }));
    expect(g.matured).toBe(false);
    expect(g.flags[0]).toMatch(/not matured/);
  });
  test("target hit → TARGET with realized return, R, and excess over the benchmark", () => {
    const g = gradeAllocation(base());
    expect(g.matured).toBe(true);
    expect(g.outcome).toBe("TARGET");
    expect(g.entryTriggered).toBe(true);
    expect(g.exitPrice).toBe(110);
    expect(g.realizedReturnPct).toBeGreaterThan(9);
    expect(g.realizedNetR).toBeGreaterThan(1.5);
    expect(g.benchmarkReturnPct).not.toBeNull();
    expect(g.excessReturnPct).toBeCloseTo((g.realizedReturnPct as number) - (g.benchmarkReturnPct as number), 3);
    expect(g.realizedPnlInr).toBeCloseTo(10 * (g.entryPrice as number) * ((g.realizedReturnPct as number) / 100), 1);
  });
  test("quantity scales realized P&L linearly", () => {
    const a = gradeAllocation(base({ quantity: 10 }));
    const b = gradeAllocation(base({ quantity: 30 }));
    expect(b.realizedPnlInr).toBeCloseTo((a.realizedPnlInr as number) * 3, 2);
  });
  test("NO future-data leakage: bars on/before the decision date cannot change the grade", () => {
    const g1 = gradeAllocation(base());
    const mutated = base();
    mutated.bars = [bar(1, 1, 999, 0.5, 500), ...mutated.bars.slice(1)]; // absurd decision-day bar
    const g2 = gradeAllocation(mutated);
    expect(g2).toEqual(g1);
  });
  test("look-ahead: a target touched ON the decision day does not count", () => {
    const g = gradeAllocation(base({ bars: [bar(1, 100, 120, 99, 100), ...flat(2, 15, 100)] }));
    expect(g.outcome).toBe("TIME");
  });
  test("stop hit → STOP with negative return", () => {
    const g = gradeAllocation(base({ bars: [...flat(1, 2, 100), bar(3, 100, 101, 94, 95), ...flat(4, 15, 95)] }));
    expect(g.outcome).toBe("STOP");
    expect(g.realizedReturnPct).toBeLessThan(0);
  });
  test("never filled (price runs away above the zone) → NOT_FILLED, no return", () => {
    const g = gradeAllocation(base({ bars: [...flat(1, 1, 100), ...flat(2, 15, 120)] }));
    expect(g.outcome).toBe("NOT_FILLED");
    expect(g.realizedReturnPct).toBeNull();
    expect(g.excessReturnPct).toBeNull();
  });
  test("extreme gap through the stop fills the exit at the open (gap-aware), not at the stop", () => {
    const g = gradeAllocation(base({ bars: [...flat(1, 2, 100), bar(3, 80, 82, 78, 80), ...flat(4, 15, 80)] }));
    expect(g.outcome).toBe("STOP");
    expect(g.exitPrice).toBeLessThanOrEqual(82);
    expect(g.realizedReturnPct).toBeLessThan(-15);
  });
  test("ambiguous bar (stop and target in one bar) → AMBIGUOUS, not an observed return", () => {
    const g = gradeAllocation(base({ bars: [...flat(1, 2, 100), bar(3, 100, 112, 94, 100), ...flat(4, 15, 100)] }));
    expect(g.outcome).toBe("AMBIGUOUS");
    expect(g.ambiguous).toBe(true);
    expect(g.realizedReturnPct).toBeNull();
    expect(g.flags.join(" ")).toMatch(/ambiguous/);
  });
  test("missing prices (empty bars) → not matured, never DATA_INVALID-as-loss", () => {
    const g = gradeAllocation(base({ bars: [] }));
    expect(g.matured).toBe(false);
    expect(g.realizedReturnPct).toBeNull();
  });
  test("invalid geometry recorded at decision time → DATA_INVALID, matured, flagged", () => {
    const g = gradeAllocation(base({ stop: 105 }));
    expect(g.outcome).toBe("DATA_INVALID");
    expect(g.flags[0]).toMatch(/invalid geometry/);
  });
  test("corporate action: adjusted OHLC grades the same as the un-split series", () => {
    const raw = base().bars;
    // 2-for-1 split after day 8: raw prices halve, adjustedClose keeps continuity
    const split = raw.map((b, i) => (i >= 8 ? { ...b, open: b.open / 2, high: b.high / 2, low: b.low / 2, close: b.close / 2, adjustedClose: b.close } : { ...b, adjustedClose: b.close }));
    const g1 = gradeAllocation(base({ bars: toAdjustedOhlc(raw.map((b) => ({ ...b, adjustedClose: b.close }))) }));
    const g2 = gradeAllocation(base({ bars: toAdjustedOhlc(split) }));
    expect(g2.outcome).toBe(g1.outcome);
    expect(g2.realizedReturnPct).toBeCloseTo(g1.realizedReturnPct as number, 3);
  });
  test("benchmark window: unavailable benchmark is flagged, excess null", () => {
    const g = gradeAllocation(base({ benchmark: [] }));
    expect(g.benchmarkReturnPct).toBeNull();
    expect(g.excessReturnPct).toBeNull();
    expect(g.flags.join(" ")).toMatch(/benchmark unavailable/);
  });
  test("breakout trigger entry uses stop-buy semantics", () => {
    const g = gradeAllocation(base({ entryType: "BREAKOUT_TRIGGER", entryZoneLow: null, entryZoneHigh: null, entryTriggerPrice: 102, bars: [...flat(1, 2, 100), bar(3, 100, 104, 99, 103), bar(4, 103, 111, 102, 110), ...flat(5, 15, 110)] }));
    expect(g.entryTriggered).toBe(true);
    expect(g.entryPrice).toBeGreaterThanOrEqual(102);
  });
});
