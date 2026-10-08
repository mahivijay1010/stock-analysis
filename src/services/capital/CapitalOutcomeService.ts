/**
 * CapitalOutcomeService — grades matured ALLOCATE / WATCH recommendations with
 * the shared bracket simulator + a NIFTY benchmark leg, appends immutable
 * outcome rows, and aggregates the desk's track record (withheld below 10).
 * Lifecycle: DECISION → ENTRY CONDITION → ENTRY TRIGGERED / EXPIRED →
 * POSITION MONITORED → TARGET / STOP / TIME EXIT → OUTCOME → EVALUATION.
 */

import { AppDataSource } from "../../config/database";
import { CapitalDecisionOutcome } from "../../entities";
import { marketDataService } from "../market/MarketDataService";
import { toAdjustedOhlc } from "../shortterm/shadowFill";
import { CAPITAL_GRADER_VERSION, gradeAllocation } from "./capitalOutcome";
import { buildCapitalTrackRecord, CapitalOutcomeRow, CapitalTrackRecord, liquidityBucketOf } from "./capitalTrackRecord";

interface PendingRow {
  id: string;
  capital_plan_id: string;
  plan_date: string;
  ticker: string;
  action: string;
  entry_type: string | null;
  entry_zone_low: string | null;
  entry_zone_high: string | null;
  entry_price: string | null;
  stop_price: string | null;
  target1: string | null;
  expected_holding_sessions: number | null;
  recommended_qty: number | null;
  created_at: string;
  feature_cutoff_at: string | null;
  detail: Record<string, unknown> | null;
}

export class CapitalOutcomeService {
  /** Grade every ALLOCATE/WATCH allocation without an outcome whose horizon has elapsed. */
  async gradeMatured(limit = 500): Promise<{ graded: number; pending: number; failed: number; notes: string[] }> {
    const rows: PendingRow[] = await AppDataSource.query(
      `SELECT a.id, a.capital_plan_id, a.plan_date::text, a.ticker, a.action, a.entry_type, a.entry_zone_low, a.entry_zone_high,
              a.entry_price, a.stop_price, a.target1, a.expected_holding_sessions, a.recommended_qty, a.created_at, a.detail,
              p.feature_cutoff_at
         FROM capital_allocations a
         JOIN capital_plans p ON p.id = a.capital_plan_id
        WHERE a.action IN ('ALLOCATE','WATCH')
          AND NOT EXISTS (SELECT 1 FROM capital_decision_outcomes o WHERE o.capital_allocation_id = a.id AND o.grader_version = $1)
        ORDER BY a.created_at ASC
        LIMIT $2`,
      [CAPITAL_GRADER_VERSION, limit]
    );
    let graded = 0;
    let pending = 0;
    let failed = 0;
    const notes: string[] = [];
    let nifty: Array<{ date: string; close: number }> = [];
    try {
      nifty = (await marketDataService.getNiftyBars("1y")).map((b) => ({ date: b.date, close: b.adjustedClose ?? b.close }));
    } catch {
      notes.push("NIFTY bars unavailable — excess return will be null for this run");
    }
    const repo = AppDataSource.getRepository(CapitalDecisionOutcome);
    for (const r of rows) {
      const entry = Number(r.entry_price);
      const stop = Number(r.stop_price);
      const target = Number(r.target1);
      if (!Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(target)) {
        failed += 1;
        continue;
      }
      try {
        const bars = await marketDataService.getDailyBars(r.ticker, "6mo");
        const g = gradeAllocation({
          decisionDate: r.plan_date,
          entryType: r.entry_type ?? "NONE",
          entryZoneLow: r.entry_zone_low != null ? Number(r.entry_zone_low) : null,
          entryZoneHigh: r.entry_zone_high != null ? Number(r.entry_zone_high) : null,
          entryTriggerPrice: (r.entry_type ?? "").includes("BREAKOUT") ? entry : null,
          entryPrice: entry,
          stop,
          target1: target,
          expectedHoldingSessions: r.expected_holding_sessions ?? 7,
          quantity: r.recommended_qty ?? 0,
          bars: toAdjustedOhlc(bars),
          benchmark: nifty,
        });
        if (!g.matured) {
          pending += 1;
          continue;
        }
        await repo.insert(
          repo.create({
            capitalAllocationId: r.id,
            graderVersion: CAPITAL_GRADER_VERSION,
            outcome: g.outcome,
            entryTriggered: g.entryTriggered,
            entryPrice: g.entryPrice != null ? String(g.entryPrice) : null,
            entryAt: g.entryAt,
            exitTriggered: g.exitTriggered,
            exitPrice: g.exitPrice != null ? String(g.exitPrice) : null,
            exitAt: g.exitAt,
            realizedPnlInr: g.realizedPnlInr != null ? g.realizedPnlInr.toFixed(2) : null,
            realizedReturnPct: g.realizedReturnPct != null ? String(g.realizedReturnPct) : null,
            realizedNetR: g.realizedNetR != null ? String(g.realizedNetR) : null,
            conservativeNetR: g.conservativeNetR != null ? String(g.conservativeNetR) : null,
            mfeR: g.mfeR != null ? String(g.mfeR) : null,
            maeR: g.maeR != null ? String(g.maeR) : null,
            holdingSessions: g.holdingSessions,
            benchmarkReturnPct: g.benchmarkReturnPct != null ? String(g.benchmarkReturnPct) : null,
            excessReturnPct: g.excessReturnPct != null ? String(g.excessReturnPct) : null,
            ambiguous: g.ambiguous,
            featureCutoffAt: r.feature_cutoff_at ? new Date(r.feature_cutoff_at) : null,
            decisionTime: new Date(r.created_at),
            outcomeMaturityTime: g.outcomeMaturityDate ? new Date(`${g.outcomeMaturityDate}T15:30:00+05:30`) : null,
            flags: g.flags,
          })
        );
        graded += 1;
      } catch (err) {
        failed += 1;
        notes.push(`${r.ticker}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { graded, pending, failed, notes: notes.slice(0, 20) };
  }

  async trackRecord(accountId?: string): Promise<CapitalTrackRecord> {
    const rows: Array<Record<string, unknown>> = await AppDataSource.query(
      `SELECT a.id AS allocation_id, a.capital_plan_id, a.plan_date::text, a.ticker, a.action, a.setup_type, a.detail, a.model_version,
              a.evidence_score, a.reward_risk, p.horizon, p.market_regime, p.risk_profile,
              o.outcome, o.realized_return_pct, o.realized_net_r, o.benchmark_return_pct, o.excess_return_pct, o.mfe_r, o.mae_r, o.exit_at::text
         FROM capital_allocations a
         JOIN capital_plans p ON p.id = a.capital_plan_id
         JOIN capital_decision_outcomes o ON o.capital_allocation_id = a.id AND o.grader_version = $1
        WHERE a.action IN ('ALLOCATE','WATCH') ${accountId ? "AND a.account_id = $2" : ""}
        ORDER BY a.plan_date ASC`,
      accountId ? [CAPITAL_GRADER_VERSION, accountId] : [CAPITAL_GRADER_VERSION]
    );
    const n = (v: unknown): number | null => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
    const mapped: CapitalOutcomeRow[] = rows.map((r) => {
      const detail = (r.detail ?? {}) as Record<string, unknown>;
      return {
        allocationId: String(r.allocation_id),
        planId: String(r.capital_plan_id),
        planDate: String(r.plan_date),
        ticker: String(r.ticker),
        action: r.action === "ALLOCATE" ? "ALLOCATE" : "WATCH",
        setupType: String(r.setup_type ?? "NO_SETUP"),
        horizon: String(r.horizon),
        regime: String(r.market_regime),
        riskProfile: String(r.risk_profile),
        sector: typeof detail.sector === "string" ? detail.sector : null,
        liquidityBucket: liquidityBucketOf(n(detail.advInr)),
        modelVersion: String(r.model_version),
        evidenceScore: n(r.evidence_score),
        rewardRisk: n(r.reward_risk),
        outcome: String(r.outcome),
        realizedReturnPct: n(r.realized_return_pct),
        realizedNetR: n(r.realized_net_r),
        benchmarkReturnPct: n(r.benchmark_return_pct),
        excessReturnPct: n(r.excess_return_pct),
        mfeR: n(r.mfe_r),
        maeR: n(r.mae_r),
        exitAt: r.exit_at ? String(r.exit_at) : null,
      };
    });
    const totalRows: Array<{ c: string }> = await AppDataSource.query(
      `SELECT COUNT(*)::text AS c FROM capital_allocations WHERE action IN ('ALLOCATE','WATCH') ${accountId ? "AND account_id = $1" : ""}`,
      accountId ? [accountId] : []
    );
    const rec = buildCapitalTrackRecord(mapped, new Date().toISOString());
    rec.overall.totalRecommendations = Number(totalRows[0]?.c ?? mapped.length);
    return rec;
  }
}

export const capitalOutcomeService = new CapitalOutcomeService();
