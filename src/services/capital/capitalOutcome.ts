/**
 * Pure outcome grading for a capital allocation. Replays the recorded plan with
 * the SAME fill-aware bracket simulator the shadow ledgers use (shadowFill.ts),
 * so a Money Desk recommendation is graded exactly like a radar prediction:
 * proven fill, gap-aware, ambiguous bars flagged. Adds a benchmark leg (NIFTY
 * close-to-close over the same sessions) so excess return is measurable.
 *
 * Leakage rule: only bars strictly AFTER the decision's feature cutoff date are
 * used; the function refuses to grade a plan whose maturity has not elapsed.
 */

import { OhlcBar, simulateBracket } from "../shortterm/shadowFill";

export const CAPITAL_GRADER_VERSION = "capital-grader-v1";
export const ENTRY_WINDOW_SESSIONS = 3;

export type CapitalOutcomeKind = "TARGET" | "STOP" | "TIME" | "NOT_FILLED" | "AMBIGUOUS" | "DATA_INVALID";

export interface GradeInput {
  decisionDate: string; // YYYY-MM-DD — bars on/before this date are NOT used
  entryType: string;
  entryZoneLow: number | null;
  entryZoneHigh: number | null;
  entryTriggerPrice: number | null;
  entryPrice: number;
  stop: number;
  target1: number;
  expectedHoldingSessions: number;
  quantity: number;
  roundTripCostPct?: number;
  slippagePct?: number;
  /** Stock bars, ascending, adjusted OHLC. */
  bars: OhlcBar[];
  /** Benchmark bars (NIFTY) ascending close series. */
  benchmark: Array<{ date: string; close: number }>;
}

export interface GradeResult {
  graderVersion: string;
  matured: boolean;
  outcome: CapitalOutcomeKind;
  entryTriggered: boolean;
  entryPrice: number | null;
  entryAt: string | null;
  exitTriggered: boolean;
  exitPrice: number | null;
  exitAt: string | null;
  realizedPnlInr: number | null;
  realizedReturnPct: number | null;
  realizedNetR: number | null;
  conservativeNetR: number | null;
  mfeR: number | null;
  maeR: number | null;
  holdingSessions: number;
  benchmarkReturnPct: number | null;
  excessReturnPct: number | null;
  ambiguous: boolean;
  outcomeMaturityDate: string | null;
  flags: string[];
}

const r4 = (v: number): number => Math.round(v * 10000) / 10000;

export function gradeAllocation(input: GradeInput): GradeResult {
  const flags: string[] = [];
  const forward = input.bars.filter((b) => b.date > input.decisionDate);
  const needed = ENTRY_WINDOW_SESSIONS + input.expectedHoldingSessions;
  const maturityDate = forward.length > needed ? forward[needed].date : null;
  const base: GradeResult = {
    graderVersion: CAPITAL_GRADER_VERSION,
    matured: false,
    outcome: "DATA_INVALID",
    entryTriggered: false,
    entryPrice: null,
    entryAt: null,
    exitTriggered: false,
    exitPrice: null,
    exitAt: null,
    realizedPnlInr: null,
    realizedReturnPct: null,
    realizedNetR: null,
    conservativeNetR: null,
    mfeR: null,
    maeR: null,
    holdingSessions: 0,
    benchmarkReturnPct: null,
    excessReturnPct: null,
    ambiguous: false,
    outcomeMaturityDate: maturityDate,
    flags,
  };
  if (!(input.stop < input.entryPrice && input.target1 > input.entryPrice)) {
    flags.push("invalid geometry recorded at decision time");
    return { ...base, matured: true };
  }
  if (forward.length <= needed) {
    flags.push(`not matured: ${forward.length} sessions since decision, ${needed + 1} required`);
    return base;
  }
  const isTrigger = input.entryType.includes("BREAKOUT") || (input.entryTriggerPrice != null && input.entryZoneHigh == null);
  const res = simulateBracket({
    forward,
    entryType: isTrigger ? "trigger" : "zone",
    zoneLow: input.entryZoneLow,
    zoneHigh: input.entryZoneHigh ?? input.entryPrice,
    triggerPrice: input.entryTriggerPrice,
    stop: input.stop,
    target: input.target1,
    entryWindow: ENTRY_WINDOW_SESSIONS,
    maxHold: input.expectedHoldingSessions,
    roundTripCostPct: input.roundTripCostPct ?? 0.3,
    slippagePct: input.slippagePct ?? 0.2,
  });
  const outcome: CapitalOutcomeKind =
    res.outcome === "DATA_INVALID"
      ? "DATA_INVALID"
      : res.outcome === "NEVER_ENTERED" || !res.filled
        ? "NOT_FILLED"
        : res.outcome === "AMBIGUOUS_INTRABAR" || res.ambiguous
          ? "AMBIGUOUS"
          : res.outcome === "TARGET_FIRST"
            ? "TARGET"
            : res.outcome === "STOP_FIRST"
              ? "STOP"
              : "TIME";
  if (res.ambiguous) flags.push("ambiguous intrabar: adverse leg assumed, not counted as observed");

  // Benchmark over the same session span: first forward session close → exit (or maturity) close.
  let benchmarkReturnPct: number | null = null;
  const bStart = input.benchmark.find((b) => b.date >= forward[0].date);
  const endDate = res.exitDate ?? maturityDate;
  if (bStart && endDate) {
    const bEnd = [...input.benchmark].reverse().find((b) => b.date <= endDate);
    if (bEnd && bStart.close > 0 && bEnd.date >= bStart.date) benchmarkReturnPct = r4(((bEnd.close - bStart.close) / bStart.close) * 100);
  }
  if (benchmarkReturnPct == null) flags.push("benchmark unavailable for the window");

  const realizedReturnPct = res.filled && !res.ambiguous && res.returnPct != null ? r4(res.returnPct) : null;
  const realizedPnl = realizedReturnPct != null && res.fillPrice != null ? r4(input.quantity * res.fillPrice * (realizedReturnPct / 100)) : null;
  return {
    ...base,
    matured: true,
    outcome,
    entryTriggered: res.filled,
    entryPrice: res.fillPrice,
    entryAt: res.fillDate,
    exitTriggered: res.filled && res.exitDate != null,
    exitPrice: res.exitPrice,
    exitAt: res.exitDate,
    realizedPnlInr: realizedPnl,
    realizedReturnPct,
    realizedNetR: res.realizedNetR,
    conservativeNetR: res.conservativeNetR,
    mfeR: res.mfeR,
    maeR: res.maeR,
    holdingSessions: res.holdingDays,
    benchmarkReturnPct,
    excessReturnPct: realizedReturnPct != null && benchmarkReturnPct != null ? r4(realizedReturnPct - benchmarkReturnPct) : null,
    ambiguous: res.ambiguous,
    outcomeMaturityDate: maturityDate,
    flags,
  };
}
