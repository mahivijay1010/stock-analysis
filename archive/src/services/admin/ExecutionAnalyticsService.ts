/**
 * V9 E1 — ExecutionAnalyticsService: the measure step of the execution
 * feedback loop (log → measure → adapt Kelly).
 *
 * The EXISTING PaperTrade ledger is the execution log (SPEC_V9 mandate — no
 * duplicate entity, no extra logging route): closed trades already carry
 * entry/exit/qty/realizedPnl. This service reads the admin account's CLOSED
 * trades (newest first, realizedPnl=null excluded) and computes:
 *
 *  - measuredP / measuredB over the "last 30" window (pure math in
 *    executionStats.ts, shared with the prediction audit),
 *  - the model p for the universe (V8 source: aggregate 7d backtest hit rate
 *    via stockService.getAccuracy() — same rows /api/accuracy shows),
 *  - the ADAPTED half-Kelly from the applied (p, b) pair,
 *  - the Kelly-drift history (E3 table, one upserted row per IST date).
 *
 * Honesty rule: every number is measured from real fills at live quotes;
 * nothing is simulated. Paper fills have ZERO slippage — stated in the note.
 */

import { IsNull, Not } from "typeorm";
import { AppDataSource } from "../../config/database";
import { PaperTrade } from "../../entities/PaperTrade";
import { KellyDrift } from "../../entities/KellyDrift";
import { adminService } from "./AdminService";
import { stockService } from "../StockService";
import { computeKelly, KellyResult } from "../quant/kelly";
import {
  computeExecutionStats,
  computeFactorInsights,
  selectAppliedPair,
  AppliedSelection,
  ContextTrade,
  ExecutionWindowStats,
  EXECUTION_WINDOW_SIZE,
} from "./executionStats";
import { ExecutionSummaryResponse, KellyDriftPoint } from "../../types";

const round2 = (x: number): number => {
  const r = Math.round(x * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
};
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/** YYYY-MM-DD in Asia/Kolkata (same convention as AdminService/RankService). */
function istDateString(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export interface ModelWinRate {
  p: number; // fraction 0..1
  winRatePct: number;
  source: string;
}

export interface AdaptedKelly extends AppliedSelection {
  kelly: KellyResult;
  halfKellyPct: number; // round2(kelly.halfKelly × 100)
}

export class ExecutionAnalyticsService {
  /**
   * Windowed measurements from the admin desk's CLOSED paper trades
   * (newest EXECUTION_WINDOW_SIZE by exitAt; realizedPnl=null excluded).
   */
  async getMeasuredStats(): Promise<ExecutionWindowStats> {
    const account = await adminService.ensureSeeded();
    const repo = AppDataSource.getRepository(PaperTrade);
    const where = {
      accountId: account.id,
      status: "CLOSED" as const,
      realizedPnl: Not(IsNull()),
    };
    const [windowRows, closedTrades] = await Promise.all([
      repo.find({ where, order: { exitAt: "DESC" }, take: EXECUTION_WINDOW_SIZE }),
      repo.count({ where }),
    ]);
    const pnls = windowRows
      .map((t) => (t.realizedPnl != null ? Number(t.realizedPnl) : null))
      .filter((p): p is number => p !== null && Number.isFinite(p));
    return computeExecutionStats(pnls, closedTrades);
  }

  /**
   * The V8 model p for the UNIVERSE: sample-weighted aggregate 7d direction
   * hit rate over each ticker's latest walk-forward backtest row — read via
   * stockService.getAccuracy() (the exact rows /api/accuracy serves), never
   * recomputed here. Neutral 0.5 when no backtest data exists (stated).
   */
  async getModelWinRate(): Promise<ModelWinRate> {
    try {
      const accuracy = await stockService.getAccuracy();
      const h7 = accuracy.overall.find((h) => h.horizonDays === 7);
      if (h7 && h7.samples > 0) {
        return {
          p: round4(h7.directionHitRatePct / 100),
          winRatePct: round2(h7.directionHitRatePct),
          source: `universe aggregate 7d walk-forward backtest (${h7.samples.toLocaleString(
            "en-IN"
          )} samples)`,
        };
      }
    } catch {
      // fall through to the stated neutral fallback
    }
    return {
      p: 0.5,
      winRatePct: 50,
      source: "neutral fallback (no measured backtest data — run scripts/refreshBacktests.ts)",
    };
  }

  /** E2 selection rule + Kelly math on the APPLIED pair (shared with drift). */
  adaptKelly(stats: ExecutionWindowStats, modelP: number): AdaptedKelly {
    const selection = selectAppliedPair(stats, modelP);
    const kelly = computeKelly(selection.p, selection.b);
    return { ...selection, kelly, halfKellyPct: round2(kelly.halfKelly * 100) };
  }

  /**
   * V10 B4 — closed trades that carry an entry_context snapshot (newest 500),
   * as pure {pnl, context} pairs for computeFactorInsights. Trades recorded
   * before V10 have entryContext=null and are simply not in this set.
   */
  private async getContextTrades(): Promise<ContextTrade[]> {
    const account = await adminService.ensureSeeded();
    const rows = await AppDataSource.getRepository(PaperTrade).find({
      where: {
        accountId: account.id,
        status: "CLOSED" as const,
        realizedPnl: Not(IsNull()),
        entryContext: Not(IsNull()),
      },
      order: { exitAt: "DESC" },
      take: 500,
    });
    return rows.map((t) => ({
      pnl: Number(t.realizedPnl),
      context: t.entryContext ?? null,
    }));
  }

  /** GET /api/execution/summary — the whole feedback loop in one response. */
  async getSummary(): Promise<ExecutionSummaryResponse> {
    const stats = await this.getMeasuredStats();
    const model = await this.getModelWinRate();
    const adapted = this.adaptKelly(stats, model.p);
    const drift = await this.getDrift();
    const factorInsights = computeFactorInsights(await this.getContextTrades());

    const expectancyNote =
      stats.expectancy === null
        ? "No closed paper trades yet — expectancy unlocks from the first close " +
          "(Expectancy = Win% × Avg Win − Loss% × Avg Loss, the audit's formula)."
        : `Expectancy = (Win% × Avg Win) − (Loss% × Avg Loss) = ₹${stats.expectancy.toLocaleString(
            "en-IN",
            { minimumFractionDigits: 2, maximumFractionDigits: 2 }
          )} per trade over the last ${stats.window.used} closed trade${
            stats.window.used === 1 ? "" : "s"
          } ("last ${stats.window.size}" window) — same formula as the prediction audit.`;

    return {
      closedTrades: stats.closedTrades,
      window: stats.window,
      measured: {
        winRatePct: stats.measuredP !== null ? round2(stats.measuredP * 100) : null,
        payoff: stats.measuredB !== null ? round4(stats.measuredB) : null,
        halfKellyPct: adapted.halfKellyPct,
        usableP: stats.usableP,
        usableB: stats.usableB,
        reasons: stats.reasons,
        applied: adapted.applied,
        wins: stats.wins,
        losses: stats.losses,
        avgWin: stats.avgWin !== null ? round2(stats.avgWin) : null,
        avgLoss: stats.avgLoss !== null ? round2(stats.avgLoss) : null,
      },
      model: { winRatePct: model.winRatePct, source: model.source },
      expectancy: { value: stats.expectancy, note: expectancyNote },
      drift,
      factorInsights,
      note:
        `Measured from the desk's last-${stats.window.size} closed paper trades; win rate applies from ` +
        `30 closed, payoff from 10 with both wins and losses. Honest caveat: paper fills execute at ` +
        `live quotes with ZERO slippage — live results will be worse by fees + slippage.`,
    };
  }

  /** Drift history for the summary/chart — ascending by date. */
  async getDrift(): Promise<KellyDriftPoint[]> {
    const rows = await AppDataSource.getRepository(KellyDrift).find({
      order: { date: "ASC" },
    });
    return rows.map((r) => ({
      date: String(r.date),
      closedTrades: r.closedTrades,
      measuredP: r.measuredP ?? null,
      measuredB: r.measuredB ?? null,
      halfKellyPct: r.halfKellyPct ?? null,
      applied: r.applied,
    }));
  }

  /**
   * E3 — upsert TODAY's (IST) drift row from the live measurements. The
   * evening cron (after the verify job) and scripts/recordKellyDrift.ts both
   * run exactly this code path. Idempotent: date is UNIQUE, re-runs overwrite.
   */
  async recordDriftSnapshot(): Promise<KellyDriftPoint> {
    const stats = await this.getMeasuredStats();
    const model = await this.getModelWinRate();
    const adapted = this.adaptKelly(stats, model.p);
    const row: KellyDriftPoint = {
      date: istDateString(new Date()),
      closedTrades: stats.closedTrades,
      measuredP: stats.measuredP !== null ? round4(stats.measuredP) : null,
      measuredB: stats.measuredB !== null ? round4(stats.measuredB) : null,
      halfKellyPct: adapted.halfKellyPct,
      applied: adapted.applied,
    };
    await AppDataSource.getRepository(KellyDrift).upsert(row, ["date"]);
    return row;
  }
}

/** Singleton export. */
export const executionAnalyticsService = new ExecutionAnalyticsService();
export default executionAnalyticsService;
