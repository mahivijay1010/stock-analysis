/**
 * The intraday learning loop's two load-bearing rules, pinned.
 *
 * A bug in the promotion rule would let the system quietly promote a
 * parameter set on the very data that suggested it — the exact failure the
 * whole methodology exists to prevent. A bug in the catch-up detector would
 * either double-run heavy jobs or silently keep losing the ones the laptop
 * sleeps through. Neither may drift.
 */

import {
  PROMOTION_RULE,
  challengerSet,
  decidePromotion,
  evaluateChallengers,
  rescore,
} from "../src/services/research/intradayCalibrationRun";
import { IntradayModelParams, StoredOutcomeRow } from "../src/services/realtime/intradayOutcomeRepository";
import { CATCHUP_GRACE_MS, baseJobName, dailyExpressionToIst, missedRuns } from "../src/services/cronCatchup";

const INC: IntradayModelParams = { driftSign: 1, driftShrinkage: 0.25, driftHalfLifeBars: 10, minProbability: 0.35, maxProbability: 0.65, minBarsForForecast: 10 };

/** A stored row made under the incumbent with raw drift `raw` (%/bar) and a known outcome. */
function row(i: number, raw: number, actualUp: boolean, barVol = 0.05): StoredOutcomeRow {
  const horizon = 1;
  const expected = INC.driftSign * INC.driftShrinkage * raw * horizon;
  const dir: "UP" | "DOWN" = expected >= 0 ? "UP" : "DOWN";
  const actualDir: "UP" | "DOWN" = actualUp ? "UP" : "DOWN";
  return {
    id: `r${i}`,
    session_date: "2026-09-24",
    security_id: "X",
    ticker: "X.NS",
    horizon_min: horizon,
    made_at: new Date(Date.UTC(2026, 8, 24, 3, 45) + i * 60_000),
    base_price: "100",
    expected_return_pct: String(expected),
    probability_up: "0.55",
    direction: dir,
    low80_pct: String(expected - 1.2816 * barVol),
    high80_pct: String(expected + 1.2816 * barVol),
    bar_vol_pct: String(barVol),
    bars_used: 20,
    params_version: "ip-v1",
    model_params: INC,
    round_trip_cost_pct: "0.2",
    actual_return_pct: actualUp ? "0.03" : "-0.03",
    actual_direction: actualDir,
    outcome: dir === actualDir ? "CORRECT" : "WRONG",
    clears_cost: false,
  };
}

describe("rescore — exact closed-form re-scoring of a stored forecast", () => {
  test("re-scoring under the incumbent's own params reproduces its direction", () => {
    const r = row(0, +0.02, true);
    expect(rescore(r, INC).direction).toBe("UP");
    const r2 = row(1, -0.02, false);
    expect(rescore(r2, INC).direction).toBe("DOWN");
  });

  test("driftSign −1 inverts every direction call", () => {
    const r = row(0, +0.02, true);
    expect(rescore(r, { ...INC, driftSign: -1 }).direction).toBe("DOWN");
  });

  test("the null model withholds direction, sits at P=0.5, Brier 0.25, and can never be 'correct'", () => {
    const s = rescore(row(0, +0.02, true), { ...INC, driftSign: 0 });
    expect(s.direction).toBeNull();
    expect(s.probabilityUp).toBe(0.5);
    expect(s.brier).toBe(0.25);
    expect(s.correct).toBe(false);
  });

  test("higher shrinkage moves probability further from 0.5 but stays inside the clamp", () => {
    const r = row(0, +0.05, true);
    const p25 = rescore(r, INC).probabilityUp;
    const p100 = rescore(r, { ...INC, driftShrinkage: 1.0 }).probabilityUp;
    expect(p100).toBeGreaterThan(p25);
    expect(p100).toBeLessThanOrEqual(INC.maxProbability);
  });
});

describe("evaluateChallengers / decidePromotion — the pre-registered rule", () => {
  /** A day where the incumbent's momentum call is wrong ~60% of the time: raw drift sign disagrees with the outcome. */
  function antiMomentumDay(n: number, wrongFrac: number): StoredOutcomeRow[] {
    const rows: StoredOutcomeRow[] = [];
    for (let i = 0; i < n; i++) {
      const raw = i % 2 === 0 ? 0.02 : -0.02;
      const momentumUp = raw > 0;
      // 1/200 granularity so fractions like 0.505 are expressible (0.505 → 101 of 200 wrong).
      const wrong = (i % 200) / 200 < wrongFrac;
      rows.push(row(i, raw, wrong ? !momentumUp : momentumUp));
    }
    return rows;
  }

  test("splits chronologically, first 60% fit / last 40% hold-out, never shuffled", () => {
    const rows = antiMomentumDay(1000, 0.6);
    const ev = evaluateChallengers(rows, "ip-v1", INC, 1, "2026-09-24");
    expect(ev.split.fitN).toBe(600);
    expect(ev.split.holdoutN).toBe(400);
    expect(ev.split.boundaryMadeAt).toBe(rows[600].made_at.toISOString());
  });

  test("mean-reversion qualifies and is promoted when the incumbent is systematically wrong and n is sufficient", () => {
    const ev = evaluateChallengers(antiMomentumDay(2000, 0.6), "ip-v1", INC, 1, "2026-09-24");
    const mr = ev.challengers.find((c) => c.key === "mean-reversion")!;
    expect(ev.incumbent.holdout.hitRatePct).toBeCloseTo(40, 0);
    expect(mr.holdout.hitRatePct).toBeCloseTo(60, 0);
    expect(mr.qualifies).toBe(true);
    const d = decidePromotion(ev);
    expect(d.promote).toBe(true);
    expect(d.winner?.key).toBe("mean-reversion");
  });

  test("REFUSES to promote on too little hold-out data, however good the number looks", () => {
    const ev = evaluateChallengers(antiMomentumDay(600, 0.6), "ip-v1", INC, 1, "2026-09-24"); // hold-out n = 240
    const d = decidePromotion(ev);
    expect(ev.split.holdoutN).toBeLessThan(PROMOTION_RULE.minHoldoutN);
    expect(d.promote).toBe(false);
    expect(d.reason).toMatch(/too little data/);
  });

  test("a challenger at exactly a coin flip does not qualify — >50% is strict", () => {
    const ev = evaluateChallengers(antiMomentumDay(2000, 0.5), "ip-v1", INC, 1, "2026-09-24");
    const mr = ev.challengers.find((c) => c.key === "mean-reversion")!;
    expect(mr.holdout.hitRatePct).toBeCloseTo(50, 0);
    expect(mr.qualifies).toBe(false);
    expect(mr.why).toMatch(/≤ 50%/);
  });

  test("when nothing qualifies and the incumbent is ≤ 50%, the NULL model is promoted — a coin beats a confident wrong call", () => {
    // 50.5% wrong → incumbent 49.5%, mean-reversion 50.5%: MR is >50% but the lift is only
    // 1.0 pp < 1.5 → does not qualify; incumbent ≤ 50% → the NULL model is promoted.
    const ev = evaluateChallengers(antiMomentumDay(2000, 0.505), "ip-v1", INC, 1, "2026-09-24");
    const d = decidePromotion(ev);
    expect(ev.challengers.find((c) => c.key === "mean-reversion")!.qualifies).toBe(false);
    expect(d.promote).toBe(true);
    expect(d.winner?.params.driftSign).toBe(0);
    expect(d.reason).toMatch(/NULL model/);
  });

  test("an incumbent that is winning is retained — nothing changes without a qualifying challenger", () => {
    const ev = evaluateChallengers(antiMomentumDay(2000, 0.4), "ip-v1", INC, 1, "2026-09-24"); // incumbent 60%
    const d = decidePromotion(ev);
    expect(d.promote).toBe(false);
    expect(d.reason).toMatch(/retained/);
  });

  test("the challenger set is fixed and small — four named variants derived from the incumbent", () => {
    expect(challengerSet(INC).map((c) => c.key)).toEqual(["mean-reversion", "null", "shrink-0.5", "shrink-1.0"]);
  });
});

describe("cronCatchup — detecting what the laptop slept through", () => {
  const specs = [
    { name: "morning-refresh-and-scan", hourIst: 8, minuteIst: 45, weekdaysOnly: true, run: async () => {} },
    { name: "evening-verify-predictions", hourIst: 18, minuteIst: 30, weekdaysOnly: true, run: async () => {} },
    { name: "midnight-cleanup-analyses", hourIst: 0, minuteIst: 0, run: async () => {} },
    { name: "weekly-official-filings-refresh", hourIst: 20, minuteIst: 15, onlyWeekday: 6, run: async () => {} },
    { name: "weekly-calibration-refresh", hourIst: 6, minuteIst: 0, onlyWeekday: 0, run: async () => {} },
  ];
  // 2026-09-23 is a Wednesday. 10:12 IST = 04:42 UTC.
  const wedTenAm = Date.UTC(2026, 8, 23, 4, 42);

  test("the 2026-09-23 case: woke at 10:12 with only midnight logged → 08:45 is missed, evening is not yet due", () => {
    const missed = missedRuns(specs, wedTenAm, [{ job_name: "midnight-cleanup-analyses" }]);
    expect(missed.map((m) => m.name)).toEqual(["morning-refresh-and-scan"]);
  });

  test("midnight itself is caught up if the machine slept through it", () => {
    const missed = missedRuns(specs, wedTenAm, []);
    expect(missed.map((m) => m.name)).toEqual(["midnight-cleanup-analyses", "morning-refresh-and-scan"]);
  });

  test("a run logged under ANY label counts — manual or auto catch-up is never double-run", () => {
    const logged = [{ job_name: "midnight-cleanup-analyses" }, { job_name: "morning-refresh-and-scan (manual catch-up)" }];
    expect(missedRuns(specs, wedTenAm, logged)).toEqual([]);
    expect(baseJobName("x (auto catch-up)")).toBe("x");
    expect(baseJobName("x (manual catch-up)")).toBe("x");
    expect(baseJobName("x")).toBe("x");
  });

  test("weekend-only jobs are never caught up on the wrong day", () => {
    const missed = missedRuns(specs, wedTenAm, []);
    expect(missed.find((m) => m.name.startsWith("weekly"))).toBeUndefined();
  });

  test("weekday jobs are not caught up on a Sunday", () => {
    const sunNoon = Date.UTC(2026, 8, 20, 6, 30); // Sunday 12:00 IST
    const missed = missedRuns(specs, sunNoon, []);
    expect(missed.map((m) => m.name)).toEqual(["midnight-cleanup-analyses", "weekly-calibration-refresh"]);
  });

  test("respects the grace window so the real scheduler gets first claim", () => {
    const justAfter845 = Date.UTC(2026, 8, 23, 3, 15) + CATCHUP_GRACE_MS - 1000; // 08:45 IST + grace − 1s
    expect(missedRuns(specs, justAfter845, [{ job_name: "midnight-cleanup-analyses" }])).toEqual([]);
    const pastGrace = justAfter845 + 2000;
    expect(missedRuns(specs, pastGrace, [{ job_name: "midnight-cleanup-analyses" }]).map((m) => m.name)).toEqual(["morning-refresh-and-scan"]);
  });

  test("parses only daily expressions — day-of-week fields are refused by design", () => {
    expect(dailyExpressionToIst("45 8 * * *")).toEqual({ hourIst: 8, minuteIst: 45 });
    expect(dailyExpressionToIst("0 0 * * *")).toEqual({ hourIst: 0, minuteIst: 0 });
    expect(dailyExpressionToIst("45 8 * * 1-5")).toBeNull();
    expect(dailyExpressionToIst("0 6 * * 0")).toBeNull();
  });
});
