/**
 * OpportunityOutcomeService — the learning loop for the broad scan. Every
 * candidate that reached the setup engine with a plan is graded (same bracket
 * simulator + NIFTY leg as the Money Desk) once its horizon has elapsed, and
 * performance is aggregated by sector, cap bucket, setup type, liquidity tier,
 * regime, horizon and volatility regime — withheld below 10 observations.
 * Candidates are graded whether or not they qualified, so the dataset can show
 * what the gates rejected as well as what they passed.
 */

import { AppDataSource } from "../../config/database";
import { OpportunityOutcome } from "../../entities";
import { gradeAllocation } from "../capital/capitalOutcome";
import { buildCapitalTrackRecord, CapitalOutcomeRow, CapitalTrackRecord, computeMetrics, MIN_GRADED_FOR_CAPITAL_RATE, SegmentRow } from "../capital/capitalTrackRecord";
import { marketDataService } from "../market/MarketDataService";
import { toAdjustedOhlc } from "../shortterm/shadowFill";

export const OPPORTUNITY_GRADER_VERSION = "opportunity-grader-v1";

export interface UniverseLearning extends CapitalTrackRecord {
  byCapBucket: SegmentRow[];
  byLiquidityTier: SegmentRow[];
  byVolRegime: SegmentRow[];
  byStage: SegmentRow[];
  statements: Array<{ text: string; n: number; metric: string }>;
}

export class OpportunityOutcomeService {
  async gradeMatured(limit = 800): Promise<{ graded: number; pending: number; failed: number }> {
    const rows: Array<Record<string, unknown>> = await AppDataSource.query(
      `SELECT c.id, c.yahoo_ticker, c.as_of::text, c.plan, c.created_at, c.feature_cutoff_at
         FROM opportunity_candidates c
        WHERE c.plan IS NOT NULL AND (c.plan->>'initialStop') IS NOT NULL AND (c.plan->>'target1') IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM opportunity_outcomes o WHERE o.candidate_id = c.id AND o.grader_version = $1)
        ORDER BY c.created_at ASC LIMIT $2`,
      [OPPORTUNITY_GRADER_VERSION, limit]
    );
    let nifty: Array<{ date: string; close: number }> = [];
    try {
      nifty = (await marketDataService.getNiftyBars("1y")).map((b) => ({ date: b.date, close: b.adjustedClose ?? b.close }));
    } catch { /* excess null */ }
    const repo = AppDataSource.getRepository(OpportunityOutcome);
    let graded = 0, pending = 0, failed = 0;
    const barsCache = new Map<string, ReturnType<typeof toAdjustedOhlc>>();
    for (const r of rows) {
      const plan = r.plan as Record<string, unknown>;
      const entry = Number(plan.entryZoneHigh ?? plan.entryTriggerPrice);
      const stop = Number(plan.initialStop), target = Number(plan.target1);
      if (![entry, stop, target].every(Number.isFinite)) {
        failed += 1;
        continue;
      }
      try {
        const t = String(r.yahoo_ticker);
        if (!barsCache.has(t)) barsCache.set(t, toAdjustedOhlc(await marketDataService.getDailyBars(t, "6mo")));
        const g = gradeAllocation({
          decisionDate: String(r.as_of),
          entryType: String(plan.entryType ?? "NONE"),
          entryZoneLow: plan.entryZoneLow != null ? Number(plan.entryZoneLow) : null,
          entryZoneHigh: plan.entryZoneHigh != null ? Number(plan.entryZoneHigh) : null,
          entryTriggerPrice: plan.entryTriggerPrice != null ? Number(plan.entryTriggerPrice) : null,
          entryPrice: entry,
          stop,
          target1: target,
          expectedHoldingSessions: Number(plan.expectedHoldingDays ?? 7),
          quantity: 1,
          bars: barsCache.get(t)!,
          benchmark: nifty,
        });
        if (!g.matured) {
          pending += 1;
          continue;
        }
        await repo.insert(repo.create({ candidateId: String(r.id), graderVersion: OPPORTUNITY_GRADER_VERSION, outcome: g.outcome, entryAt: g.entryAt, entryPrice: g.entryPrice != null ? String(g.entryPrice) : null, exitAt: g.exitAt, exitPrice: g.exitPrice != null ? String(g.exitPrice) : null, realizedReturnPct: g.realizedReturnPct != null ? String(g.realizedReturnPct) : null, realizedNetR: g.realizedNetR != null ? String(g.realizedNetR) : null, benchmarkReturnPct: g.benchmarkReturnPct != null ? String(g.benchmarkReturnPct) : null, excessReturnPct: g.excessReturnPct != null ? String(g.excessReturnPct) : null, mfeR: g.mfeR != null ? String(g.mfeR) : null, maeR: g.maeR != null ? String(g.maeR) : null, holdingSessions: g.holdingSessions, ambiguous: g.ambiguous, featureCutoffAt: r.feature_cutoff_at ? new Date(String(r.feature_cutoff_at)) : null, decisionTime: new Date(String(r.created_at)), outcomeMaturityTime: g.outcomeMaturityDate ? new Date(`${g.outcomeMaturityDate}T15:30:00+05:30`) : null, flags: g.flags }));
        graded += 1;
      } catch {
        failed += 1;
      }
    }
    return { graded, pending, failed };
  }

  async learning(): Promise<UniverseLearning> {
    const rows: Array<Record<string, unknown>> = await AppDataSource.query(
      `SELECT c.id, c.scan_id, c.as_of::text, c.symbol, c.sector, c.market_cap_bucket, c.liquidity_tier, c.setup_type, c.stage_reached, c.decision_status, c.technical_score, c.features, s.regime,
              o.outcome, o.realized_return_pct, o.realized_net_r, o.benchmark_return_pct, o.excess_return_pct, o.mfe_r, o.mae_r, o.exit_at::text
         FROM opportunity_candidates c JOIN opportunity_scans s ON s.id = c.scan_id
         JOIN opportunity_outcomes o ON o.candidate_id = c.id AND o.grader_version = $1`,
      [OPPORTUNITY_GRADER_VERSION]
    );
    const n = (v: unknown): number | null => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
    const mapped: Array<CapitalOutcomeRow & { capBucket: string; liquidityTier: string; volRegime: string; stage: string }> = rows.map((r) => {
      const f = (r.features ?? {}) as Record<string, unknown>;
      const vol = n(f.realizedVol20AnnPct);
      const plan = (r.features ?? {}) as Record<string, unknown>;
      return {
        allocationId: String(r.id),
        planId: String(r.scan_id),
        planDate: String(r.as_of),
        ticker: String(r.symbol),
        action: r.decision_status === "QUALIFIED" ? "ALLOCATE" : "WATCH",
        setupType: String(r.setup_type ?? "NO_SETUP"),
        horizon: String((plan.expectedHoldingDays as number) ?? "5-10d"),
        regime: String(r.regime ?? "UNKNOWN"),
        riskProfile: "n/a",
        sector: r.sector ? String(r.sector) : null,
        liquidityBucket: String(r.liquidity_tier),
        modelVersion: OPPORTUNITY_GRADER_VERSION,
        evidenceScore: n(r.technical_score),
        rewardRisk: null,
        outcome: String(r.outcome),
        realizedReturnPct: n(r.realized_return_pct),
        realizedNetR: n(r.realized_net_r),
        benchmarkReturnPct: n(r.benchmark_return_pct),
        excessReturnPct: n(r.excess_return_pct),
        mfeR: n(r.mfe_r),
        maeR: n(r.mae_r),
        exitAt: r.exit_at ? String(r.exit_at) : null,
        capBucket: String(r.market_cap_bucket),
        liquidityTier: String(r.liquidity_tier),
        volRegime: vol == null ? "unknown" : vol < 20 ? "low-vol" : vol <= 40 ? "normal-vol" : "high-vol",
        stage: String(r.stage_reached),
      };
    });
    const base = buildCapitalTrackRecord(mapped, new Date().toISOString());
    const seg = (key: (r: (typeof mapped)[number]) => string): SegmentRow[] => {
      const g = new Map<string, typeof mapped>();
      for (const r of mapped) g.set(key(r), [...(g.get(key(r)) ?? []), r]);
      return [...g.entries()].map(([k, v]) => ({ key: k, metrics: computeMetrics(v) })).sort((a, b) => b.metrics.observed - a.metrics.observed);
    };
    const byCap = seg((r) => r.capBucket), byTier = seg((r) => r.liquidityTier), byVol = seg((r) => r.volRegime), byStage = seg((r) => r.stage);
    const statements: UniverseLearning["statements"] = [];
    const say = (rows: SegmentRow[], label: string) => {
      for (const s of rows) {
        if (s.metrics.withheld || s.metrics.expectancyR == null) continue;
        statements.push({ text: `${s.key} ${label}: expectancy ${s.metrics.expectancyR}R, win rate ${s.metrics.winRate.pct}% (Wilson LB ${s.metrics.winRate.wilsonLb95Pct}%), excess vs NIFTY ${s.metrics.benchmarkExcessPct.mean ?? "—"}% over ${s.metrics.observed} resolved observations.`, n: s.metrics.observed, metric: "expectancyR" });
      }
    };
    say(base.bySetupType, "setups");
    say(byCap, "cap bucket");
    say(base.byRegime, "regime");
    say(byTier, "liquidity tier");
    say(byVol, "volatility regime");
    if (!statements.length) statements.push({ text: `No segment has ${MIN_GRADED_FOR_CAPITAL_RATE} resolved observations yet (${mapped.length} graded in total). No performance statement is made.`, n: mapped.length, metric: "observed" });
    return { ...base, byCapBucket: byCap, byLiquidityTier: byTier, byVolRegime: byVol, byStage, statements, caveat: "Graded broad-scan candidates (qualified or not) with the shared bracket simulator and a NIFTY benchmark. Statements appear only at ≥10 observations per segment. Descriptive; not a forecast." };
  }
}

export const opportunityOutcomeService = new OpportunityOutcomeService();
