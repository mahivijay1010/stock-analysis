/**
 * Pure aggregation of graded capital decisions into a track record.
 * Conventions (shared with the other ledgers): observed outcomes only (filled,
 * unambiguous); every rate withheld below MIN_GRADED (10) with the reason
 * stated; Wilson 95% lower bound on the win rate; a normal-approximation 95% CI
 * on mean return; precision@k measured per plan-day on the desk's own ranking.
 */

import { wilsonLb95 } from "../evidence/selectivity";

export const MIN_GRADED_FOR_CAPITAL_RATE = 10;
export const MIN_PLANS_FOR_PRECISION = 10;

export interface CapitalOutcomeRow {
  allocationId: string;
  planId: string;
  planDate: string; // YYYY-MM-DD
  ticker: string;
  action: "ALLOCATE" | "WATCH";
  setupType: string;
  horizon: string;
  regime: string;
  riskProfile: string;
  sector: string | null;
  liquidityBucket: string; // e.g. "<2cr" | "2-10cr" | ">10cr"
  modelVersion: string;
  evidenceScore: number | null;
  rewardRisk: number | null;
  outcome: string; // TARGET | STOP | TIME | NOT_FILLED | AMBIGUOUS | DATA_INVALID
  realizedReturnPct: number | null;
  realizedNetR: number | null;
  benchmarkReturnPct: number | null;
  excessReturnPct: number | null;
  mfeR: number | null;
  maeR: number | null;
  exitAt: string | null;
}

export interface RateStat {
  n: number;
  pct: number | null;
  wilsonLb95Pct: number | null;
}
export interface MeanStat {
  n: number;
  mean: number | null;
  ci95: [number, number] | null;
  median: number | null;
}
export interface CapitalMetrics {
  totalRecommendations: number;
  resolved: number;
  observed: number;
  notFilled: number;
  ambiguous: number;
  winRate: RateStat;
  avgReturnPct: MeanStat;
  medianReturnPct: number | null;
  profitFactor: number | null;
  expectancyR: number | null;
  maxDrawdownPct: number | null;
  mfeR: number | null;
  maeR: number | null;
  benchmarkExcessPct: MeanStat;
  withheld: boolean;
  withheldReason: string | null;
}
export interface SegmentRow {
  key: string;
  metrics: CapitalMetrics;
}
export interface PrecisionAtK {
  k: number;
  plans: number;
  precision: number | null;
  withheldReason: string | null;
}
export interface CapitalTrackRecord {
  version: string;
  generatedAt: string;
  overall: CapitalMetrics;
  precision: PrecisionAtK[];
  bySetupType: SegmentRow[];
  byHorizon: SegmentRow[];
  byRegime: SegmentRow[];
  byRiskProfile: SegmentRow[];
  bySector: SegmentRow[];
  byLiquidityBucket: SegmentRow[];
  byModelVersion: SegmentRow[];
  headline: string;
  caveat: string;
}

export const CAPITAL_TRACK_RECORD_VERSION = "capital-track-record-v1";

const r2 = (v: number): number => Math.round(v * 100) / 100;

function meanStat(values: number[]): MeanStat {
  const n = values.length;
  if (n === 0) return { n: 0, mean: null, ci95: null, median: null };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sorted = [...values].sort((a, b) => a - b);
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  if (n < 2) return { n, mean: r2(mean), ci95: null, median: r2(median) };
  const sd = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1));
  const half = (1.96 * sd) / Math.sqrt(n);
  return { n, mean: r2(mean), ci95: [r2(mean - half), r2(mean + half)], median: r2(median) };
}

export function computeMetrics(rows: CapitalOutcomeRow[]): CapitalMetrics {
  const resolved = rows.filter((r) => r.outcome !== "DATA_INVALID");
  const observed = resolved.filter((r) => r.realizedReturnPct != null && r.outcome !== "NOT_FILLED" && r.outcome !== "AMBIGUOUS");
  const notFilled = resolved.filter((r) => r.outcome === "NOT_FILLED").length;
  const ambiguous = resolved.filter((r) => r.outcome === "AMBIGUOUS").length;
  const enough = observed.length >= MIN_GRADED_FOR_CAPITAL_RATE;
  const empty: CapitalMetrics = {
    totalRecommendations: rows.length,
    resolved: resolved.length,
    observed: observed.length,
    notFilled,
    ambiguous,
    winRate: { n: observed.length, pct: null, wilsonLb95Pct: null },
    avgReturnPct: { n: observed.length, mean: null, ci95: null, median: null },
    medianReturnPct: null,
    profitFactor: null,
    expectancyR: null,
    maxDrawdownPct: null,
    mfeR: null,
    maeR: null,
    benchmarkExcessPct: { n: 0, mean: null, ci95: null, median: null },
    withheld: !enough,
    withheldReason: enough ? null : `withheld — ${observed.length} observed outcomes < ${MIN_GRADED_FOR_CAPITAL_RATE} minimum`,
  };
  if (!enough) return empty;
  const returns = observed.map((r) => r.realizedReturnPct as number);
  const wins = returns.filter((v) => v > 0).length;
  const grossWin = returns.filter((v) => v > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(returns.filter((v) => v < 0).reduce((a, b) => a + b, 0));
  const rs = observed.map((r) => r.realizedNetR).filter((v): v is number => v != null);
  const mfe = observed.map((r) => r.mfeR).filter((v): v is number => v != null);
  const mae = observed.map((r) => r.maeR).filter((v): v is number => v != null);
  const excess = observed.map((r) => r.excessReturnPct).filter((v): v is number => v != null);
  // Max drawdown of the cumulative return path in exit order.
  const ordered = [...observed].sort((a, b) => (a.exitAt ?? "").localeCompare(b.exitAt ?? ""));
  let cum = 0;
  let peak = 0;
  let mdd = 0;
  for (const r of ordered) {
    cum += r.realizedReturnPct as number;
    peak = Math.max(peak, cum);
    mdd = Math.min(mdd, cum - peak);
  }
  const avg = meanStat(returns);
  return {
    ...empty,
    winRate: { n: observed.length, pct: r2((wins / observed.length) * 100), wilsonLb95Pct: r2((wilsonLb95(wins, observed.length) ?? 0) * 100) },
    avgReturnPct: avg,
    medianReturnPct: avg.median,
    profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : grossWin > 0 ? Infinity : null,
    expectancyR: rs.length ? r2(rs.reduce((a, b) => a + b, 0) / rs.length) : null,
    maxDrawdownPct: r2(mdd),
    mfeR: mfe.length ? r2(mfe.reduce((a, b) => a + b, 0) / mfe.length) : null,
    maeR: mae.length ? r2(mae.reduce((a, b) => a + b, 0) / mae.length) : null,
    benchmarkExcessPct: meanStat(excess),
    withheld: false,
    withheldReason: null,
  };
}

function segment(rows: CapitalOutcomeRow[], keyOf: (r: CapitalOutcomeRow) => string): SegmentRow[] {
  const groups = new Map<string, CapitalOutcomeRow[]>();
  for (const r of rows) {
    const k = keyOf(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  return [...groups.entries()]
    .map(([key, g]) => ({ key, metrics: computeMetrics(g) }))
    .sort((a, b) => b.metrics.observed - a.metrics.observed);
}

/** precision@k: per plan day, rank ALLOCATE rows by evidenceScore desc, share of top-k with excess > 0. */
export function precisionAtK(rows: CapitalOutcomeRow[], ks = [1, 3, 5]): PrecisionAtK[] {
  const byPlan = new Map<string, CapitalOutcomeRow[]>();
  for (const r of rows) {
    if (r.action !== "ALLOCATE" || r.excessReturnPct == null) continue;
    if (!byPlan.has(r.planId)) byPlan.set(r.planId, []);
    byPlan.get(r.planId)!.push(r);
  }
  return ks.map((k) => {
    const hits: number[] = [];
    for (const g of byPlan.values()) {
      if (g.length < k) continue;
      const top = [...g].sort((a, b) => (b.evidenceScore ?? 0) - (a.evidenceScore ?? 0)).slice(0, k);
      hits.push(top.filter((r) => (r.excessReturnPct as number) > 0).length / k);
    }
    const enough = hits.length >= MIN_PLANS_FOR_PRECISION;
    return {
      k,
      plans: hits.length,
      precision: enough ? r2(hits.reduce((a, b) => a + b, 0) / hits.length) : null,
      withheldReason: enough ? null : `withheld — ${hits.length} plan-days with ≥${k} graded allocations < ${MIN_PLANS_FOR_PRECISION}`,
    };
  });
}

export function buildCapitalTrackRecord(rows: CapitalOutcomeRow[], generatedAt: string): CapitalTrackRecord {
  const overall = computeMetrics(rows);
  const headline = overall.withheld
    ? `${rows.length} recommendations logged, ${overall.observed} observed outcomes — no hit rate shown below ${MIN_GRADED_FOR_CAPITAL_RATE}. The desk has not yet earned a track record.`
    : overall.benchmarkExcessPct.mean != null && overall.benchmarkExcessPct.ci95 && overall.benchmarkExcessPct.ci95[0] > 0
      ? `Mean excess return over NIFTY ${overall.benchmarkExcessPct.mean}% (95% CI ${overall.benchmarkExcessPct.ci95[0]}…${overall.benchmarkExcessPct.ci95[1]}) on ${overall.observed} observed outcomes — positive and distinguishable from zero, so far.`
      : `Win rate ${overall.winRate.pct}% (Wilson LB ${overall.winRate.wilsonLb95Pct}%), mean excess over NIFTY ${overall.benchmarkExcessPct.mean ?? "—"}% on ${overall.observed} observed outcomes — not distinguishable from no edge.`;
  return {
    version: CAPITAL_TRACK_RECORD_VERSION,
    generatedAt,
    overall,
    precision: precisionAtK(rows),
    bySetupType: segment(rows, (r) => r.setupType),
    byHorizon: segment(rows, (r) => r.horizon),
    byRegime: segment(rows, (r) => r.regime),
    byRiskProfile: segment(rows, (r) => r.riskProfile),
    bySector: segment(rows, (r) => r.sector ?? "Unclassified"),
    byLiquidityBucket: segment(rows, (r) => r.liquidityBucket),
    byModelVersion: segment(rows, (r) => r.modelVersion),
    headline,
    caveat:
      "Observed outcomes only (filled, unambiguous). Rates withheld below 10. Benchmark is NIFTY close-to-close over the same sessions. This measures whether the desk's recommendations beat the index; it does not promise they will.",
  };
}

export function liquidityBucketOf(advInr: number | null): string {
  if (advInr == null) return "unknown";
  if (advInr < 2e7) return "<2cr";
  if (advInr < 1e8) return "2-10cr";
  return ">10cr";
}
