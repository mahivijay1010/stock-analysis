/**
 * Barrier-first outcomes — the rules that make the intraday ledger comparable
 * to the daily study and honest about what a resting order would have done.
 *
 * The properties that matter most:
 *  - a bar spanning both barriers is a STOP (we cannot know the intra-bar order);
 *  - a bar that OPENS through the stop fills at the open (gap risk counts against us);
 *  - a missing path is null, never "NONE";
 *  - the DOWN frame is an exact mirror of UP;
 *  - the Monte Carlo is deterministic and its driftless limit is the classic b/(a+b).
 */

import {
  BARRIER_STOP_PCT,
  BARRIER_TARGET_PCT,
  barrierProbabilities,
  evaluateBarrierPath,
  scoreBarriers,
} from "../src/services/realtime/barrierOutcomes";
import { CompletedBar } from "../src/services/realtime/types";

const T0 = Date.UTC(2026, 8, 24, 4, 0); // 09:30 IST
const BASE = 1000;

/** One-minute bars starting at T0+1min; each entry is [open, high, low, close]. */
function bars(rows: Array<[number, number, number, number]>): CompletedBar[] {
  return rows.map(([o, h, l, c], i) => ({
    securityId: "X",
    startAt: T0 + (i + 1) * 60_000,
    endAt: T0 + (i + 2) * 60_000,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 100,
    tradeCount: 10,
    complete: true as const,
  }));
}

describe("evaluateBarrierPath — UP frame", () => {
  const common = { madeAt: T0, basePrice: BASE, horizonMin: 5, direction: "UP" as const };

  test("target hit cleanly → TARGET, with minutes-to-hit and MFE recorded from the high", () => {
    const r = evaluateBarrierPath({ ...common, bars: bars([[1000, 1002, 999, 1001], [1001, 1006, 1000, 1005], [1005, 1007, 1004, 1006]]) })!;
    expect(r.firstHit).toBe("TARGET"); // +0.5% = 1005 reached by bar 2's high 1006
    expect(r.minutesToHit).toBe(2);
    expect(r.mfePct).toBeCloseTo(0.6, 6); // high 1006 before resolution
    expect(r.maePct).toBeCloseTo(-0.1, 6); // low 999 in bar 1
  });

  test("stop hit cleanly → STOP", () => {
    const r = evaluateBarrierPath({ ...common, bars: bars([[1000, 1001, 998, 999], [999, 999.5, 996.5, 997]]) })!;
    expect(r.firstHit).toBe("STOP"); // −0.3% = 997 reached by bar 2's low 996.5
    expect(r.minutesToHit).toBe(2);
    expect(r.maePct).toBeCloseTo(-0.35, 6);
  });

  test("a bar spanning BOTH barriers is scored as STOP — the intra-bar order is unknowable", () => {
    const r = evaluateBarrierPath({ ...common, bars: bars([[1000, 1006, 996, 1003]]) })!;
    expect(r.firstHit).toBe("STOP");
  });

  test("a bar that OPENS through the stop is a stop at the open — gap risk counts against us", () => {
    const r = evaluateBarrierPath({ ...common, bars: bars([[1000, 1001, 999.5, 1000.5], [995, 1010, 994, 1009]]) })!;
    expect(r.firstHit).toBe("STOP");
    expect(r.minutesToHit).toBe(2);
  });

  test("neither barrier within the horizon → NONE, with the final return and a complete path", () => {
    const r = evaluateBarrierPath({
      ...common,
      bars: bars([[1000, 1001, 999, 1000.5], [1000.5, 1002, 1000, 1001], [1001, 1002, 1000.5, 1001.5], [1001.5, 1003, 1001, 1002], [1002, 1003, 1001.5, 1002.5]]),
    })!;
    expect(r.firstHit).toBe("NONE");
    expect(r.hitAt).toBeNull();
    expect(r.finalReturnPct).toBeCloseTo(0.25, 6);
    expect(r.complete).toBe(true);
    expect(r.barsSeen).toBe(5);
    expect(r.returnsAtPct[5]).toBeCloseTo(0.25, 6);
  });

  test("a path shorter than the horizon is marked incomplete, not NONE-by-default", () => {
    const r = evaluateBarrierPath({ ...common, bars: bars([[1000, 1001, 999, 1000.5], [1000.5, 1002, 1000, 1001]]) })!;
    expect(r.complete).toBe(false);
    expect(r.barsSeen).toBe(2);
  });

  test("no bars in the window → null (missing data), never a NONE outcome", () => {
    expect(evaluateBarrierPath({ ...common, bars: [] })).toBeNull();
    // Bars entirely before madeAt are not in the window either.
    const before = bars([[1000, 1001, 999, 1000]]).map((b) => ({ ...b, startAt: T0 - 120_000, endAt: T0 - 60_000 }));
    expect(evaluateBarrierPath({ ...common, bars: before })).toBeNull();
  });

  test("bars after the horizon are ignored — a late target does not count", () => {
    const rows: Array<[number, number, number, number]> = [];
    for (let i = 0; i < 5; i++) rows.push([1000, 1001, 999, 1000]);
    rows.push([1000, 1010, 999, 1009]); // bar 6, outside a 5-minute horizon
    const r = evaluateBarrierPath({ ...common, bars: bars(rows) })!;
    expect(r.firstHit).toBe("NONE");
    expect(r.barsSeen).toBe(5);
  });

  test("returns are recorded at 5/10/15/30/60 only where the horizon reaches", () => {
    const rows: Array<[number, number, number, number]> = [];
    for (let i = 0; i < 15; i++) rows.push([1000, 1000.5, 999.5, 1000 + i * 0.1]);
    const r = evaluateBarrierPath({ ...common, horizonMin: 15, bars: bars(rows) })!;
    expect(Object.keys(r.returnsAtPct).map(Number).sort((a, b) => a - b)).toEqual([5, 10, 15]);
    expect(r.returnsAtPct[10]).toBeCloseTo(((1000 + 9 * 0.1 - 1000) / 1000) * 100, 6);
  });
});

describe("evaluateBarrierPath — DOWN frame mirrors UP exactly", () => {
  const common = { madeAt: T0, basePrice: BASE, horizonMin: 5, direction: "DOWN" as const };

  test("target for a DOWN call is −0.5%; hit via the LOW", () => {
    const r = evaluateBarrierPath({ ...common, bars: bars([[1000, 1001, 998, 999], [999, 999.5, 994, 995]]) })!;
    expect(r.firstHit).toBe("TARGET"); // 995 = −0.5%
    expect(r.mfePct).toBeCloseTo(0.6, 6); // favourable excursion is DOWNWARD: low 994 ⇒ +0.6% in frame
  });

  test("stop for a DOWN call is +0.3%; hit via the HIGH", () => {
    const r = evaluateBarrierPath({ ...common, bars: bars([[1000, 1003.5, 999, 1002]]) })!;
    expect(r.firstHit).toBe("STOP");
  });

  test("a DOWN call that gaps UP through its stop at the open is stopped at the open", () => {
    const r = evaluateBarrierPath({ ...common, bars: bars([[1000, 1000.5, 999.5, 1000], [1004, 1004.5, 990, 991]]) })!;
    expect(r.firstHit).toBe("STOP");
  });
});

describe("barrierProbabilities — deterministic and sane", () => {
  test("is deterministic for a given seed", () => {
    const a = barrierProbabilities({ driftPerBarPct: 0.01, barVolPct: 0.06, horizonBars: 30, direction: "UP" });
    const b = barrierProbabilities({ driftPerBarPct: 0.01, barVolPct: 0.06, horizonBars: 30, direction: "UP" });
    expect(a).toEqual(b);
  });

  test("probabilities sum to one", () => {
    const p = barrierProbabilities({ driftPerBarPct: 0, barVolPct: 0.1, horizonBars: 60, direction: "UP" });
    expect(p.pTargetFirst + p.pStopFirst + p.pNeither).toBeCloseTo(1, 10);
  });

  test("driftless, long horizon: P(target first | resolved) → stop/(target+stop) = 0.3/0.8 = 37.5%", () => {
    // Large vol so nearly every path resolves; then the gambler's-ruin ratio applies.
    const p = barrierProbabilities({ driftPerBarPct: 0, barVolPct: 0.4, horizonBars: 600, direction: "UP", paths: 4000 });
    const resolved = p.pTargetFirst + p.pStopFirst;
    expect(resolved).toBeGreaterThan(0.95);
    expect(p.pTargetFirst / resolved).toBeCloseTo(BARRIER_STOP_PCT / (BARRIER_TARGET_PCT + BARRIER_STOP_PCT), 1);
  });

  test("positive drift raises P(target first); the DOWN frame with the same drift lowers it", () => {
    const up = barrierProbabilities({ driftPerBarPct: 0.02, barVolPct: 0.1, horizonBars: 60, direction: "UP" });
    const flat = barrierProbabilities({ driftPerBarPct: 0, barVolPct: 0.1, horizonBars: 60, direction: "UP" });
    const down = barrierProbabilities({ driftPerBarPct: 0.02, barVolPct: 0.1, horizonBars: 60, direction: "DOWN" });
    expect(up.pTargetFirst).toBeGreaterThan(flat.pTargetFirst);
    expect(down.pTargetFirst).toBeLessThan(flat.pTargetFirst);
  });

  test("at a 1-minute horizon with realistic vol, almost nothing resolves — the bracket is unreachable", () => {
    // 6 bps/bar realised vol (our 09-24 mean |move|): a 50 bp target in one step is ~8 sigma.
    const p = barrierProbabilities({ driftPerBarPct: 0, barVolPct: 0.06, horizonBars: 1, direction: "UP" });
    expect(p.pNeither).toBeGreaterThan(0.99);
  });
});

describe("scoreBarriers", () => {
  test("aggregates first-hit rates, excursions, time-to-hit and the ex-ante Brier", () => {
    const mk = (firstHit: "TARGET" | "STOP" | "NONE", minutes: number | null, p: number) => ({
      outcome: {
        targetPct: 0.5, stopPct: 0.3, direction: "UP" as const, firstHit, hitAt: minutes == null ? null : T0 + minutes * 60_000,
        minutesToHit: minutes, mfePct: 0.4, maePct: -0.2, returnsAtPct: {}, finalReturnPct: 0.1, barsSeen: 30, complete: true,
      },
      exAnte: { targetPct: 0.5, stopPct: 0.3, direction: "UP" as const, pTargetFirst: p, pStopFirst: 1 - p, pNeither: 0, paths: 400 },
    });
    const s = scoreBarriers([mk("TARGET", 10, 0.6), mk("STOP", 4, 0.6), mk("NONE", null, 0.6), mk("TARGET", 20, 0.4)]);
    expect(s.n).toBe(4);
    expect(s.targetFirstRatePct).toBe(50);
    expect(s.stopFirstRatePct).toBe(25);
    expect(s.neitherRatePct).toBe(25);
    expect(s.meanMinutesToHit).toBeCloseTo((10 + 4 + 20) / 3, 6);
    // Brier: (0.6-1)^2 + (0.6-0)^2 + (0.6-0)^2 + (0.4-1)^2 = 0.16+0.36+0.36+0.36 = 1.24 / 4
    expect(s.brierTarget).toBeCloseTo(0.31, 6);
  });

  test("empty input yields nulls, not zeros", () => {
    expect(scoreBarriers([]).targetFirstRatePct).toBeNull();
  });
});
