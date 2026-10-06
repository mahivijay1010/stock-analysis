/**
 * Sub-₹100 wide-ledger core (wide-ledger-v1). These tests pin the three
 * properties that make the cheap-stock lane honest: the AI can only CAP a
 * decision (never raise it), only GRADEABLE picks are logged, and every cohort
 * rate is deduped, observed-only, and withheld below the sample-size floor.
 */

import {
  applyAiCap,
  selectPicksToLog,
  aggregateWideTrackRecord,
  DECISION_LADDER,
  MIN_GRADED_FOR_WIDE_RATE,
  WideDecision,
  WideOutcomeRow,
  LoggableRow,
} from "../src/services/shortterm/wideLedger";
import { wilsonLb95 } from "../src/services/evidence/selectivity";

describe("applyAiCap — the cap-only contract", () => {
  const all: WideDecision[] = ["NO TRADE", "WATCH", "WAIT", "BUY"];

  test("AFFIRM is a pass-through for every decision", () => {
    for (const d of all) expect(applyAiCap(d, "AFFIRM")).toBe(d);
  });

  test("CAP_TO_WATCH floors at WATCH — never raises anything below it", () => {
    expect(applyAiCap("BUY", "CAP_TO_WATCH")).toBe("WATCH");
    expect(applyAiCap("WAIT", "CAP_TO_WATCH")).toBe("WATCH");
    expect(applyAiCap("WATCH", "CAP_TO_WATCH")).toBe("WATCH");
    expect(applyAiCap("NO TRADE", "CAP_TO_WATCH")).toBe("NO TRADE"); // already lower — not raised
  });

  test("CAP_TO_NO_TRADE forces NO TRADE from anywhere", () => {
    for (const d of all) expect(applyAiCap(d, "CAP_TO_NO_TRADE")).toBe("NO TRADE");
  });

  test("the cap can NEVER produce a more aggressive decision than the input", () => {
    const rank = (d: WideDecision) => DECISION_LADDER.indexOf(d);
    for (const d of all) {
      for (const cap of ["AFFIRM", "CAP_TO_WATCH", "CAP_TO_NO_TRADE"] as const) {
        expect(rank(applyAiCap(d, cap))).toBeLessThanOrEqual(rank(d));
      }
    }
  });
});

describe("selectPicksToLog — only gradeable picks are logged", () => {
  const row = (over: Partial<LoggableRow>): LoggableRow => ({
    symbol: "ABC",
    ticker: "ABC.NS",
    evaluation: { setupType: "PULLBACK", freshness: { lastUpdate: "2026-09-24T10:00:00Z" }, plan: { initialStop: 40, target1: 52 }, gates: { passed: true } },
    decision: { newBuyer: "WAIT" },
    ...over,
  });

  test("a pick with stop AND target is logged, with its anchor date and cohort", () => {
    const { picks, skipped } = selectPicksToLog([row({})], "2026-09-25");
    expect(picks).toHaveLength(1);
    expect(picks[0].anchorDate).toBe("2026-09-24"); // from freshness, not the fallback
    expect(picks[0].decision).toBe("WAIT");
    expect(picks[0].gatesPassed).toBe(true);
    expect(skipped).toEqual({ ungradeable: 0, noEvaluation: 0 });
  });

  test("a plan missing stop or target is SKIPPED (ungradeable), never logged", () => {
    const noStop = row({ evaluation: { setupType: "X", plan: { initialStop: null, target1: 52 }, gates: { passed: false } } });
    const noTarget = row({ evaluation: { setupType: "X", plan: { initialStop: 40, target1: null }, gates: { passed: false } } });
    const { picks, skipped } = selectPicksToLog([noStop, noTarget], "2026-09-25");
    expect(picks).toHaveLength(0);
    expect(skipped.ungradeable).toBe(2);
  });

  test("a row with no evaluation is counted separately, not dropped silently", () => {
    const { picks, skipped } = selectPicksToLog([row({ evaluation: null })], "2026-09-25");
    expect(picks).toHaveLength(0);
    expect(skipped.noEvaluation).toBe(1);
  });

  test("anchor falls back to the supplied date when freshness is absent", () => {
    const { picks } = selectPicksToLog([row({ evaluation: { setupType: "X", plan: { initialStop: 40, target1: 52 }, gates: { passed: true } } })], "2026-09-25");
    expect(picks[0].anchorDate).toBe("2026-09-25");
  });
});

describe("aggregateWideTrackRecord — observed-only, deduped, sample-size-gated", () => {
  const out = (over: Partial<WideOutcomeRow>): WideOutcomeRow => ({
    decision: "BUY",
    outcomeStatus: "TARGET_FIRST",
    filled: true,
    realizedNetR: 1.2,
    returnPct: 8,
    ...over,
  });

  test("below the floor, every rate is withheld with a reason", () => {
    const rows = [out({}), out({ outcomeStatus: "STOP_FIRST", realizedNetR: -1 }), out({})];
    const tr = aggregateWideTrackRecord(rows, { logged: 3, resolved: 3, pending: 0 });
    const buy = tr.cohorts.find((c) => c.decision === "BUY")!;
    expect(buy.logged).toBe(3);
    expect(buy.targetFirstRate).toBeNull();
    expect(buy.expectancyR).toBeNull();
    expect(buy.withheldReason).toContain(`< ${MIN_GRADED_FOR_WIDE_RATE}`);
  });

  test("at the floor the rate appears with n and a hand-checked Wilson bound", () => {
    const rows: WideOutcomeRow[] = [];
    for (let i = 0; i < 12; i++) rows.push(out({ outcomeStatus: i < 7 ? "TARGET_FIRST" : "STOP_FIRST", realizedNetR: i < 7 ? 1.3 : -1 }));
    const buy = aggregateWideTrackRecord(rows, { logged: 12, resolved: 12, pending: 0 }).cohorts.find((c) => c.decision === "BUY")!;
    expect(buy.targetFirstRate!.n).toBe(12);
    expect(buy.targetFirstRate!.pct).toBeCloseTo(58.3, 1); // 7/12
    expect(wilsonLb95(7, 12)!).toBeCloseTo(0.3195, 3);
    expect(buy.targetFirstRate!.wilsonLb95Pct).toBeCloseTo(32, 0);
    expect(buy.targetFirstRate!.wilsonLb95Pct).toBeLessThan(buy.targetFirstRate!.pct);
  });

  test("NEVER_ENTERED plans are counted but EXCLUDED from rates (not trades)", () => {
    const rows: WideOutcomeRow[] = [];
    for (let i = 0; i < 11; i++) rows.push(out({ outcomeStatus: "TARGET_FIRST", realizedNetR: 1.1 }));
    rows.push(out({ outcomeStatus: "NEVER_ENTERED", filled: false, realizedNetR: null, returnPct: null }));
    const buy = aggregateWideTrackRecord(rows, { logged: 12, resolved: 12, pending: 0 }).cohorts.find((c) => c.decision === "BUY")!;
    expect(buy.logged).toBe(12);
    expect(buy.neverEntered).toBe(1);
    expect(buy.targetFirstRate!.n).toBe(11); // the un-entered one is not in the denominator
  });

  test("AMBIGUOUS_INTRABAR is counted but excluded from realized expectancy", () => {
    const rows: WideOutcomeRow[] = [];
    for (let i = 0; i < 10; i++) rows.push(out({ outcomeStatus: "TARGET_FIRST", realizedNetR: 1.0 }));
    rows.push(out({ outcomeStatus: "AMBIGUOUS_INTRABAR", filled: true, realizedNetR: null, returnPct: null }));
    const buy = aggregateWideTrackRecord(rows, { logged: 11, resolved: 11, pending: 0 }).cohorts.find((c) => c.decision === "BUY")!;
    expect(buy.ambiguous).toBe(1);
    expect(buy.targetFirstRate!.n).toBe(10); // observed only
    expect(buy.expectancyR).toBe(1.0);
  });

  test("zero resolved ⇒ an honest 'no track record' headline, not a fabricated one", () => {
    const tr = aggregateWideTrackRecord([], { logged: 40, resolved: 0, pending: 40 });
    expect(tr.headline).toContain("ZERO have matured");
    expect(tr.cohorts).toHaveLength(0);
  });
});
