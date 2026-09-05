/**
 * CronService — scheduled background jobs (all times Asia/Kolkata):
 *
 *  - 08:45 IST Mon-Fri  refresh universe bars from Yahoo, then run the
 *                       top-picks scan and persist PredictionLog rows per
 *                       horizon for every scanned stock.
 *  - 18:30 IST Mon-Fri  verify matured PredictionLog rows against real bars
 *                       (fills actual_return / prediction_correct) and refresh
 *                       ModelPerformance aggregates for affected tickers.
 *  - 00:00 IST daily    delete Analysis rows older than 365 days.
 *                       NEVER deletes PredictionLog or ModelPerformance rows —
 *                       those are the permanent accuracy record.
 */

import * as cron from "node-cron";
import { StockService } from "./StockService";
import { ensembleService } from "./ensemble/EnsembleService";
import { intelligenceService } from "./intelligence/IntelligenceService";
import { IntelligenceRepository } from "./intelligence/IntelligenceRepository";
import {
  pickRotationCandidates,
  RotationFreshness,
  ROTATION_BATCH_SIZE,
  ROTATION_THROTTLE_MS,
} from "./intelligenceRotation";
import { NSE_UNIVERSE } from "../data/nseUniverse";
import { rankService } from "./RankService";
import { executionAnalyticsService } from "./admin/ExecutionAnalyticsService";

const TZ = "Asia/Kolkata";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface JobSpec {
  name: string;
  expression: string;
  run: () => Promise<void>;
}

export class CronService {
  private stockService: StockService;
  private tasks: cron.ScheduledTask[] = [];
  private running = new Set<string>();
  private readonly intelligenceRepository = new IntelligenceRepository();

  constructor(stockService: StockService) {
    this.stockService = stockService;
  }

  startAll(): void {
    if (this.tasks.length > 0) {
      console.warn("⚠️ Cron jobs already started — skipping duplicate startAll()");
      return;
    }
    console.log(`🕐 Scheduling cron jobs (timezone ${TZ})...`);

    const jobs: JobSpec[] = [
      {
        name: "morning-refresh-and-scan",
        expression: "45 8 * * 1-5",
        run: () => this.morningRefreshAndScan(),
      },
      {
        name: "evening-verify-predictions",
        expression: "30 18 * * 1-5",
        run: () => this.eveningVerify(),
      },
      {
        name: "midnight-cleanup-analyses",
        expression: "0 0 * * *",
        run: () => this.midnightCleanup(),
      },
      {
        name: "weekly-official-filings-refresh",
        expression: "15 20 * * 6",
        run: () => this.weeklyIntelligenceRefresh(),
      },
    ];

    for (const job of jobs) {
      const task = cron.schedule(
        job.expression,
        () => this.guarded(job.name, job.run),
        { timezone: TZ, name: job.name, noOverlap: true }
      );
      this.tasks.push(task);
      console.log(`  ✓ ${job.name}: "${job.expression}" (${TZ})`);
    }
    console.log("✓ Cron jobs scheduled, including official-filings refresh at 20:15 IST Saturday");
  }

  stopAll(): void {
    if (this.tasks.length === 0) return;
    console.log("⏸️ Stopping cron jobs...");
    for (const task of this.tasks) {
      void task.stop();
    }
    this.tasks = [];
    console.log("✓ All cron jobs stopped");
  }

  getStatus(): { totalJobs: number; jobs: Array<{ name: string; nextRun: string | null }> } {
    return {
      totalJobs: this.tasks.length,
      jobs: this.tasks.map((t) => ({
        name: t.name ?? t.id,
        nextRun: t.getNextRun()?.toISOString() ?? null,
      })),
    };
  }

  // ── Job bodies ─────────────────────────────────────────────────────────────

  /** 08:45 IST — refresh universe bars, then scan + log predictions. */
  private async morningRefreshAndScan(): Promise<void> {
    console.log("📊 [CRON] 08:45 IST — refreshing universe bars...");
    const { ok, failed } = await this.stockService.refreshUniverseBars();
    console.log(`📊 [CRON] Universe refresh: ${ok.length} ok, ${failed.length} failed${failed.length ? ` (${failed.join(", ")})` : ""}`);

    console.log("📊 [CRON] Running top-picks scan + logging predictions...");
    const scan = await this.stockService.scanUniverse({ logPredictions: true });
    console.log(`📊 [CRON] Scan complete: ${scan.scannedCount} stocks scored, predictions logged per horizon`);

    // V8 R1: persist today's cross-sectional rank snapshot AFTER the scan so
    // the future IC measurement has real, logged-in-advance ranks. A failure
    // here never sinks the morning job.
    try {
      const snap = await rankService.persistTodaySnapshot();
      console.log(
        `🏁 [CRON] Rank snapshot persisted: ${snap.rowsPersisted} tickers for ${snap.date}`
      );
    } catch (err) {
      console.error("🏁 [CRON] Rank snapshot failed:", err);
    }

    // V10 B1: rotating intelligence refresh — the 10 universe tickers with the
    // OLDEST stored metrics (never-stored first), each ~13s of NSE scraping,
    // throttled ≥5s apart. Failures are logged per ticker and NEVER sink the
    // morning job; full-universe coverage builds in ~3 weeks at 10/night.
    try {
      await this.rotatingIntelligenceRefresh();
    } catch (err) {
      console.error("📚 [CRON] Rotating intelligence refresh failed:", err);
    }
  }

  /**
   * V10 B1 — refresh stored intelligence for the stalest universe tickers.
   * Public: scripts/rotateIntelligence.ts runs this exact body on demand
   * (same one-off pattern as persistRankSnapshot/recordKellyDrift).
   */
  async rotatingIntelligenceRefresh(): Promise<void> {
    const universe = NSE_UNIVERSE.map((u) => u.ticker.replace(/\.(NS|BO)$/i, "").toUpperCase());
    const stored = await this.intelligenceRepository.latestStoredMetrics(universe);
    const freshness: RotationFreshness[] = universe.map((ticker) => ({
      ticker,
      lastStoredAt: stored.has(ticker)
        ? new Date(stored.get(ticker)!.latestCalculatedAt)
        : null,
    }));
    const picks = pickRotationCandidates(freshness, new Date());
    console.log(
      `📚 [CRON] Rotating intelligence refresh: coverage ${stored.size}/${universe.length}; ` +
        `refreshing ${picks.length} stalest of the ${ROTATION_BATCH_SIZE}-ticker batch` +
        (picks.length ? ` (${picks.join(", ")})` : " (all candidates <24h fresh — nothing to do)")
    );
    let ok = 0;
    for (let i = 0; i < picks.length; i++) {
      try {
        const result = await intelligenceService.refreshTicker(picks[i]);
        ok++;
        console.log(
          `📚 [CRON] Intelligence refreshed ${picks[i]}: ${(result as { filingsFound?: number }).filingsFound ?? 0} filings`
        );
      } catch (err) {
        console.error(`📚 [CRON] Intelligence refresh failed for ${picks[i]}:`, (err as Error).message);
      }
      if (i < picks.length - 1) await sleep(ROTATION_THROTTLE_MS);
    }
    console.log(`📚 [CRON] Rotating refresh done: ${ok}/${picks.length} succeeded`);
  }

  /**
   * 18:30 IST — fill matured prediction outcomes + refresh ModelPerformance.
   *
   * V2-D note: the admin paper account is mark-to-market on request — the
   * equity curve is DERIVED from PaperTrade history + daily closes whenever
   * /api/admin/account is hit (per spec, deriving beats storing), so no
   * extra persistence step is needed here.
   */
  private async eveningVerify(): Promise<void> {
    console.log("🔎 [CRON] 18:30 IST — verifying matured predictions...");
    const { verified, tickersRefreshed } = await this.stockService.verifyMaturedPredictions();
    console.log(`🔎 [CRON] Verified ${verified} predictions; refreshed ModelPerformance for ${tickersRefreshed} tickers`);
    console.log("🔎 [CRON] Admin paper account equity is derived on request (no storage step).");

    // V7 A3: online regret update of the ensemble weights from the freshly
    // matured outcomes. A failure here never sinks the verify job.
    try {
      const r = await ensembleService.updateFromLatestMaturedDay();
      console.log(
        `⚖️ [CRON] Ensemble weights updated: ${r.updatedPairs} (ticker,horizon) pairs from ` +
          `${r.latestOutcomeDate ?? "no matured day"}; ${r.switches} best-model switches, ${r.skipped} skipped`
      );
    } catch (err) {
      console.error("⚖️ [CRON] Ensemble weight update failed:", err);
    }

    // V9 E3: nightly Kelly-drift snapshot AFTER the verify step — upserts
    // today's kelly_drift row from the measured execution stats (same code
    // path as scripts/recordKellyDrift.ts). A failure never sinks the job.
    try {
      const row = await executionAnalyticsService.recordDriftSnapshot();
      console.log(
        `📈 [CRON] Kelly drift recorded for ${row.date}: closedTrades=${row.closedTrades}, ` +
          `measuredP=${row.measuredP ?? "null"}, measuredB=${row.measuredB ?? "null"}, ` +
          `halfKelly=${row.halfKellyPct ?? "null"}%, applied=${row.applied}`
      );
    } catch (err) {
      console.error("📈 [CRON] Kelly drift snapshot failed:", err);
    }
  }

  /** 00:00 IST — Analysis rows older than 365 days only. */
  private async midnightCleanup(): Promise<void> {
    console.log("🧹 [CRON] 00:00 IST — cleaning up Analysis rows older than 365 days...");
    const deleted = await this.stockService.cleanupOldAnalyses();
    console.log(`🧹 [CRON] Deleted ${deleted} old Analysis rows (PredictionLog/ModelPerformance untouched)`);
  }

  /** Refresh only the explicitly configured coverage universe; empty means a safe no-op. */
  private async weeklyIntelligenceRefresh(): Promise<void> {
    const tickers = (process.env.INTELLIGENCE_REFRESH_TICKERS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    if (tickers.length === 0) {
      console.log("📚 [CRON] INTELLIGENCE_REFRESH_TICKERS is empty — official filings refresh skipped");
      return;
    }
    for (const ticker of tickers) {
      try {
        const result = await intelligenceService.refreshTicker(ticker);
        console.log(`📚 [CRON] Official filings refreshed for ${ticker}: ${result.filingsFound ?? 0} filings`);
      } catch (error) {
        console.error(`📚 [CRON] Official filings refresh failed for ${ticker}:`, error);
      }
    }
    await intelligenceService.refreshMacro();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** Belt-and-braces overlap guard (in addition to node-cron's noOverlap). */
  private async guarded(name: string, run: () => Promise<void>): Promise<void> {
    if (this.running.has(name)) {
      console.warn(`⚠️ [CRON] ${name} still running — skipping this trigger`);
      return;
    }
    this.running.add(name);
    const started = Date.now();
    try {
      await run();
      console.log(`✓ [CRON] ${name} finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    } catch (err) {
      console.error(`✗ [CRON] ${name} failed:`, err);
    } finally {
      this.running.delete(name);
    }
  }
}

export default CronService;
