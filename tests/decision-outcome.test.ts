/**
 * Lane C outcome grading (decision-grader-v1) — the ledger the Evidence tab
 * was missing. These tests hand-compute returns so the grader is verified
 * against arithmetic, not against itself, and they pin the honesty rules:
 * next-open entry (never the anchor close), the claim's own cost model,
 * truncation/pending/invalid statuses instead of silent guesses, and
 * sample-size-gated cohort rates with Wilson lower bounds.
 */

import { gradeDecisionOutcome, SnapshotClaim, GraderBar, DECISION_GRADER_VERSION } from "../src/services/decision/outcomeGrader";
import { aggregateCohorts, CohortInputRow, MIN_GRADED_FOR_LANE_C_RATE } from "../src/services/evidence/DecisionOutcomeService";
import { addCalendarDays } from "../src/services/forecast/dates";
import { wilsonLb95 } from "../src/services/evidence/selectivity";

const CLAIM: SnapshotClaim = {
  snapshotId: "snap-1",
  ticker: "TEST.NS",
  decisionStatus: "BUY_CANDIDATE",
  asOfDate: "2026-06-01",
  horizonDays: 30,
  evAfterCostsPct: 2.0,
  p10RetPct: -5.0,
  p90RetPct: 8.0,
  transactionCostPct: 0.4,
};

/** n consecutive calendar-day bars from start; close interpolates a→b. */
function bars(start: string, n: number, closeFrom: number, closeTo: number, openOffset = 0.5): GraderBar[] {
  const out: GraderBar[] = [];
  let d = start;
  for (let i = 0; i < n; i++) {
    const close = closeFrom + ((closeTo - closeFrom) * i) / Math.max(1, n - 1);
    out.push({ date: d, open: close - openOffset, close });
    d = addCalendarDays(d, 1);
  }
  return out;
}

describe("gradeDecisionOutcome — reference frames and arithmetic", () => {
  test("BUY win: enters at the NEXT session's OPEN, nets the claim's own costs", () => {
    // Anchor 2026-06-01 close 100; terminal is the first bar ≥ 2026-07-01.
    const series = bars("2026-06-01", 32, 100, 106, 0.5); // last bar 2026-07-02
    const o = gradeDecisionOutcome(CLAIM, series, "2026-07-10");
    expect(o.outcomeStatus).toBe("GRADED");
    expect(o.graderVersion).toBe(DECISION_GRADER_VERSION);
    expect(o.anchorDate).toBe("2026-06-01");
    expect(o.entryDate).toBe("2026-06-02"); // never the anchor close
    expect(o.terminalDate).toBe("2026-07-01"); // first session at/after anchor+30d
    const anchorClose = series[0].close;
    const entryOpen = series[1].open;
    const terminalClose = series[30].close;
    expect(o.claimGrossReturnPct).toBeCloseTo(((terminalClose / anchorClose - 1) * 100), 3);
    expect(o.tradeableGrossReturnPct).toBeCloseTo(((terminalClose / entryOpen - 1) * 100), 3);
    expect(o.tradeableNetReturnPct).toBeCloseTo(o.tradeableGrossReturnPct! - 0.4, 3); // claim's cost model
    expect(o.costPct).toBe(0.4);
    expect(o.directionHit).toBe(true); // net > 0
    expect(o.withinBand80).toBe(true); // claim-frame gross inside [-5, +8]
    expect(o.evErrorPct).toBeCloseTo(o.tradeableNetReturnPct! - 2.0, 3);
    expect(o.flags).not.toContain("COST_MODEL_IMPUTED");
  });

  test("gap open at entry is measured and flagged, and the ACTION frame pays it", () => {
    const series = bars("2026-06-01", 32, 100, 106, 0.5);
    series[1] = { ...series[1], open: 103 }; // +3% gap over the 100 anchor close
    const o = gradeDecisionOutcome(CLAIM, series, "2026-07-10");
    expect(o.entryGapPct).toBeCloseTo(3.0, 2);
    expect(o.flags.some((f) => f.startsWith("ENTRY_GAP_"))).toBe(true);
    // Claim frame is unchanged; the tradeable return is worse than the claim's.
    expect(o.tradeableGrossReturnPct!).toBeLessThan(o.claimGrossReturnPct!);
  });

  test("horizon not reached + current feed ⇒ PENDING (no grade is invented)", () => {
    const series = bars("2026-06-01", 10, 100, 102); // ends 2026-06-10
    const o = gradeDecisionOutcome(CLAIM, series, "2026-06-11"); // feed is current
    expect(o.outcomeStatus).toBe("PENDING");
    expect(o.tradeableNetReturnPct).toBeNull();
    expect(o.directionHit).toBeNull();
  });

  test("series died mid-window ⇒ TRUNCATED at the last bar, loudly flagged", () => {
    const series = bars("2026-06-01", 15, 100, 95); // ends 2026-06-15, falling
    const o = gradeDecisionOutcome(CLAIM, series, "2026-08-01"); // feed long stale
    expect(o.outcomeStatus).toBe("TRUNCATED");
    expect(o.terminalDate).toBe("2026-06-15");
    expect(o.flags).toContain("TRUNCATED_HORIZON_14_OF_30D");
    expect(o.directionHit).toBe(false); // graded on what WAS observable
  });

  test("no session ever traded after the anchor ⇒ ENTRY_UNAVAILABLE", () => {
    const series = bars("2026-06-01", 1, 100, 100);
    const o = gradeDecisionOutcome(CLAIM, series, "2026-08-01");
    expect(o.outcomeStatus).toBe("ENTRY_UNAVAILABLE");
    expect(o.flags).toContain("SERIES_ENDED_AT_ANCHOR");
  });

  test("a malformed bar inside the window ⇒ DATA_INVALID, nothing scored", () => {
    const series = bars("2026-06-01", 32, 100, 106);
    series[5] = { ...series[5], close: 0 };
    const o = gradeDecisionOutcome(CLAIM, series, "2026-07-10");
    expect(o.outcomeStatus).toBe("DATA_INVALID");
    expect(o.tradeableNetReturnPct).toBeNull();
    expect(o.flags.some((f) => f.startsWith("MALFORMED_BAR_"))).toBe(true);
  });

  test("a split inside the window grades on the ADJUSTED basis and says so", () => {
    // 1:2 split on day 10: raw close halves; adjusted series is smooth.
    const series = bars("2026-06-01", 32, 100, 106).map((b, i) => {
      if (i < 10) return { ...b, adjustedClose: b.close / 2 }; // pre-split factor 0.5
      return { ...b, open: b.open / 2, close: b.close / 2, adjustedClose: b.close / 2 };
    });
    const o = gradeDecisionOutcome(CLAIM, series, "2026-07-10");
    expect(o.outcomeStatus).toBe("GRADED");
    expect(o.flags).toContain("ADJUSTED_BASIS_APPLIED");
    // Adjusted frame: ~+6% underlying move, NOT the raw −47% a naive grader sees.
    expect(o.claimGrossReturnPct!).toBeGreaterThan(0);
    expect(o.claimGrossReturnPct!).toBeLessThan(10);
  });

  test("AVOID is graded gross (no trade ⇒ no costs); WAIT has no hit at all", () => {
    const falling = bars("2026-06-01", 32, 100, 92);
    const avoid = gradeDecisionOutcome({ ...CLAIM, decisionStatus: "AVOID_NEW_ENTRY" }, falling, "2026-07-10");
    expect(avoid.directionHit).toBe(true); // it did not rise — avoiding was right
    const wait = gradeDecisionOutcome({ ...CLAIM, decisionStatus: "WAIT" }, falling, "2026-07-10");
    expect(wait.directionHit).toBeNull(); // an abstention has no hit definition
  });

  test("missing stored cost model ⇒ imputed AND flagged, never silent", () => {
    const series = bars("2026-06-01", 32, 100, 106);
    const o = gradeDecisionOutcome({ ...CLAIM, transactionCostPct: null, evAfterCostsPct: null, p10RetPct: null, p90RetPct: null }, series, "2026-07-10");
    expect(o.flags).toContain("COST_MODEL_IMPUTED");
    expect(o.costPct).toBeGreaterThan(0);
    expect(o.withinBand80).toBeNull(); // no band claim ⇒ no band grade
    expect(o.evErrorPct).toBeNull();
  });

  test("band coverage: a move beyond p90 grades OUTSIDE the claimed band", () => {
    const series = bars("2026-06-01", 32, 100, 113); // +13% > p90 of +8%
    const o = gradeDecisionOutcome(CLAIM, series, "2026-07-10");
    expect(o.withinBand80).toBe(false);
  });
});

describe("aggregateCohorts — sample-size honesty", () => {
  const row = (over: Partial<CohortInputRow>): CohortInputRow => ({
    decision_status: "BUY_CANDIDATE",
    outcome_status: "GRADED",
    tradeable_net_return_pct: "1.5",
    claim_gross_return_pct: "2.0",
    direction_hit: true,
    within_band80: true,
    ev_error_pct: "-0.5",
    ...over,
  });

  test("a 4-outcome cohort WITHHOLDS every rate with an explicit reason", () => {
    const cohorts = aggregateCohorts([row({}), row({}), row({ direction_hit: false }), row({})]);
    const buy = cohorts.find((c) => c.decisionStatus === "BUY_CANDIDATE")!;
    expect(buy.observations).toBe(4);
    expect(buy.hitRate).toBeNull();
    expect(buy.meanNetReturnPct).toBeNull(); // even the mean is withheld under min-n
    expect(buy.hitRateWithheldReason).toContain(`< ${MIN_GRADED_FOR_LANE_C_RATE} minimum`);
  });

  test("at n=12 the rate appears WITH n and a hand-checked Wilson lower bound", () => {
    const rows: CohortInputRow[] = [];
    for (let i = 0; i < 12; i++) rows.push(row({ direction_hit: i < 8 })); // 8 of 12
    const buy = aggregateCohorts(rows).find((c) => c.decisionStatus === "BUY_CANDIDATE")!;
    expect(buy.hitRate).not.toBeNull();
    expect(buy.hitRate!.n).toBe(12);
    expect(buy.hitRate!.pct).toBeCloseTo(66.7, 1);
    // Hand-computed Wilson 95% LB for 8/12 ≈ 0.3906.
    expect(wilsonLb95(8, 12)!).toBeCloseTo(0.3906, 3);
    expect(buy.hitRate!.wilsonLb95Pct).toBeCloseTo(39.1, 1);
    expect(buy.hitRate!.wilsonLb95Pct).toBeLessThan(buy.hitRate!.pct); // the bound is the defensible claim
  });

  test("WAIT never gets a hit rate — abstentions are context, not accuracy", () => {
    const rows: CohortInputRow[] = [];
    for (let i = 0; i < 15; i++) rows.push(row({ decision_status: "WAIT", direction_hit: null }));
    const wait = aggregateCohorts(rows).find((c) => c.decisionStatus === "WAIT")!;
    expect(wait.hitRate).toBeNull();
    expect(wait.hitRateWithheldReason).toContain("abstention");
    expect(wait.meanNetReturnPct).not.toBeNull(); // distribution IS shown for context
  });

  test("TRUNCATED outcomes are counted separately, never laundered into GRADED", () => {
    const rows: CohortInputRow[] = [row({}), row({ outcome_status: "TRUNCATED" }), row({ outcome_status: "TRUNCATED" })];
    const buy = aggregateCohorts(rows).find((c) => c.decisionStatus === "BUY_CANDIDATE")!;
    expect(buy.truncated).toBe(2);
    expect(buy.observations).toBe(3);
  });
});
