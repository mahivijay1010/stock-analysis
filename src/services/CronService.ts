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
 *
 * REMOVED in the v2 upgrade (upgrade-spec §2; audit §2.2): the evening
 * ensemble-weight update (FTRL) and the nightly Kelly-drift snapshot. Their
 * historical rows (ensemble_weights, kelly_drift) are preserved untouched.
 * The morning rank snapshot STAYS — rank_snapshots feed future evaluation.
 */

import * as cron from "node-cron";
import { StockService } from "./StockService";
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
import { sessionCalendarService } from "./forecast/SessionCalendarService";
import { forecastService } from "./forecast/ForecastService";
import { decisionService } from "./decision/DecisionService";

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
      // Part V (autonomous directive): prospective research jobs — idempotent.
      {
        name: "evening-resolve-shadow-outcomes",
        expression: "45 18 * * 1-5",
        run: () => this.resolveShadowOutcomes(),
      },
      {
        name: "monthly-governance-review",
        expression: "0 21 1 * *",
        run: () => this.monthlyGovernanceReview(),
      },
      {
        // Global macro (RBI + FRED India CPI/GDP + MoSPI when configured);
        // series are universe-wide, not per-ticker. 07:30 IST on the 1st.
        name: "monthly-macro-refresh",
        expression: "30 7 1 * *",
        run: () => this.monthlyMacroRefresh(),
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

  /** 18:45 IST weekdays — resolve matured short-term shadow predictions (idempotent). */
  private async resolveShadowOutcomes(): Promise<void> {
    const { researchJobsService } = await import("./research/ResearchJobsService");
    const r = await researchJobsService.resolveShadowOutcomes();
    console.log(`🧪 [CRON] shadow outcomes: resolved ${r.resolved}, still pending ${r.pending}`);
  }

  /** 21:00 IST on the 1st — live-shadow snapshot + pre-registered demotions (never promotes). */
  private async monthlyGovernanceReview(): Promise<void> {
    const { researchJobsService } = await import("./research/ResearchJobsService");
    const r = await researchJobsService.monthlyGovernanceReview();
    console.log(`🏛️ [CRON] governance review: ${r.snapshots} snapshots, ${r.transitions} demotions`);
  }

  /** 07:30 IST on the 1st — global macro refresh (RBI + FRED India series + MoSPI). */
  private async monthlyMacroRefresh(): Promise<void> {
    const { intelligenceService } = await import("./intelligence/IntelligenceService");
    const r = (await intelligenceService.refreshMacro()) as { values?: unknown[]; errors?: unknown[] };
    console.log(`🌐 [CRON] macro refresh: ${r.values?.length ?? 0} observations, ${r.errors?.length ?? 0} provider notes`);
  }


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

    // REMOVED in the v2 upgrade (upgrade-audit §2.2 evening steps 2–3):
    //  - the V7 FTRL ensemble-weight update (ensemble_weights rows preserved
    //    as experiment artifacts; nothing writes them anymore), and
    //  - the V9 nightly Kelly-drift snapshot (kelly_drift rows preserved).
    // Both features are out of production execution per upgrade-spec §2.

    // Phase C (spec §5): reconcile the session calendar against today's real
    // bars, grade matured forecast points, and ensure the current month has an
    // original snapshot for every followed/held instrument. All idempotent and
    // downtime-recovering (a re-run picks up whatever was missed); failures
    // never sink the evening job.
    try {
      const cal = await sessionCalendarService.reconcile();
      console.log(
        `📅 [CRON] Session calendar reconciled: +${cal.observed} observed, ` +
          `${cal.closedNoData} closed(no-data), ${cal.projected} projected`
      );
      const graded = await forecastService.verifyOutcomes();
      console.log(
        `📅 [CRON] Forecast outcomes: ${graded.verified} verified, ${graded.noSession} no-session, ` +
          `${graded.missingData} missing-data, ${graded.pending} pending (of ${graded.examined} matured)`
      );
      const sweep = await forecastService.issueDailyForAll();
      console.log(
        `📅 [CRON] Daily forecast issuances: ${sweep.issued} new, ${sweep.reused} reused, ` +
          `${sweep.failed.length} failed`
      );
      const renewal = await forecastService.renewMonthly();
      console.log(
        `📅 [CRON] Monthly snapshots (${renewal.period}): ${renewal.issued.length} issued, ` +
          `${renewal.skipped.length} already present, ${renewal.failed.length} failed`
      );
      const decisions = await decisionService.publishForAll();
      console.log(
        `⚖️ [CRON] Decision snapshots: ${decisions.published} published, ` +
          `${decisions.failed.length} failed`
      );
    } catch (err) {
      console.error("📅 [CRON] Forecast maintenance failed:", err);
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
