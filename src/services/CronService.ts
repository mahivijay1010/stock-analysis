/**
 * CronService — scheduled background jobs (all times Asia/Kolkata):
 *
 *  - 08:45 IST Mon-Fri  refresh universe bars from Yahoo, then run the
 *                       top-picks scan and persist PredictionLog rows per
 *                       horizon for every scanned stock.
 *  - 18:30 IST Mon-Fri  verify matured PredictionLog rows against real bars
 *                       (fills actual_return / prediction_correct) and refresh
 *                       ModelPerformance aggregates for affected tickers.
 *  - 06:00 IST Sunday   continuous-learning refresh (docs/system-trust-review.md
 *                       batch 3): re-fits calibrators/ensemble on the latest
 *                       walk-forward harness run and re-runs the champion-vs-
 *                       baselines experiment against newly-resolved
 *                       PredictionLog rows. Can only PROMOTE via each
 *                       sub-job's own already-correct, independently-verified
 *                       out-of-sample check — this job automates WHEN that
 *                       check runs, never what it may conclude.
 *  - 00:00 IST daily    delete Analysis rows older than 365 days.
 *                       NEVER deletes PredictionLog or ModelPerformance rows —
 *                       those are the permanent accuracy record.
 *
 * NOTE ON SCHEDULING: NO job here uses a day-of-week cron field. Every job is
 * registered with a DAILY expression and gates itself in its own body via
 * istWeekday()/isIstWeekday(), throwing NotScheduledToday on a day it should
 * not act (logged as status='skipped', not 'failed').
 *
 * This is because node-cron 4.2.1's day-of-week handling cannot be trusted:
 *  - 2026-09-20: "15 20 * * 6" and "0 6 * * 0" had NEVER fired since they were
 *    added; getNextRun() resolved them to 2028 and 2034 respectively, traced
 *    to MatcherWalker.matchNext() advancing by a YEAR per iteration instead of
 *    a day when the candidate date's weekday does not match.
 *  - 2026-09-21 and 2026-09-22: "45 8 * * 1-5" did not fire on either day, in
 *    processes that had been running for hours and whose "0 0 * * *" job fired
 *    normally at midnight. A freshly-armed `* * 1-5` timer fires correctly, so
 *    the failure only appears once the timer has been armed for a long period
 *    — consistent with getDelay()'s 24h-clamped re-arm recomputing the next
 *    match through the same broken day-of-week path.
 * The root cause of the second case is not fully proven. The daily+guard
 * pattern is used because it avoids the suspect code path entirely rather than
 * depending on a diagnosis being right.
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
import { AppDataSource } from "../config/database";

const TZ = "Asia/Kolkata";

/**
 * IST weekday (0=Sunday..6=Saturday), computed independent of the process's
 * own timezone.
 *
 * Needed because two of our schedules were being expressed with a
 * day-of-week cron field (`* * 6`, `* * 0`) and node-cron 4.2.1 has a real bug
 * there: MatcherWalker.matchNext()'s weekday-fallback loop advances the
 * candidate date by a full YEAR per iteration instead of by a day when the
 * day-of-month it first lands on doesn't fall on the required weekday. For
 * "15 20 * * 6" (Saturday 20:15) that resolved to 2028; for "0 6 * * 0"
 * (Sunday 06:00) it resolved to 2034 — confirmed against the installed
 * library on 2026-09-20, the two jobs having silently never fired since they
 * were added. Both are now expressed as DAILY cron expressions (a field
 * combination node-cron computes correctly) with the weekday check moved in
 * here, which avoids the buggy code path entirely rather than depending on a
 * library fix or version pin.
 */
function istWeekday(): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(new Date());
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts as "Sun"] ?? new Date().getDay();
}

/**
 * Thrown by a nominally-daily job to say "today was not my day" — distinct
 * from a real failure. Caught by guarded() and logged as status='skipped'
 * rather than 'failed', so a week of correct no-ops on
 * weekly-official-filings-refresh / weekly-calibration-refresh cannot be
 * misread as either six failures or six successful real runs.
 */
/**
 * True on a weekday (Mon-Fri) in IST.
 *
 * Used the same way as istWeekday(): the three weekday jobs are registered
 * with DAILY cron expressions and gate themselves here, rather than relying on
 * a `1-5` day-of-week field. See the NOTE ON SCHEDULING at the top of this
 * file for why that field is not trusted in this codebase.
 */
function isIstWeekday(): boolean {
  const d = istWeekday();
  return d >= 1 && d <= 5;
}

class NotScheduledToday extends Error {
  constructor() {
    super("not scheduled to run today");
  }
}

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
        // Daily; the job itself skips weekends (see isIstWeekday).
        expression: "45 8 * * *",
        run: () => this.morningRefreshAndScan(),
      },
      {
        name: "evening-verify-predictions",
        // Daily; the job itself skips weekends (see isIstWeekday).
        expression: "30 18 * * *",
        run: () => this.eveningVerify(),
      },
      {
        name: "midnight-cleanup-analyses",
        expression: "0 0 * * *",
        run: () => this.midnightCleanup(),
      },
      {
        // Was "15 20 * * 6" (Saturday-only). node-cron 4.2.1 cannot schedule
        // that correctly (see istWeekday() above), so this now fires DAILY at
        // 20:15 IST and the job itself only acts on Saturday.
        name: "weekly-official-filings-refresh",
        expression: "15 20 * * *",
        run: () => this.weeklyIntelligenceRefresh(),
      },
      // Part V (autonomous directive): prospective research jobs — idempotent.
      {
        name: "evening-resolve-shadow-outcomes",
        // Daily; the job itself skips weekends (see isIstWeekday).
        expression: "45 18 * * *",
        run: () => this.resolveShadowOutcomes(),
      },
      {
        name: "monthly-governance-review",
        expression: "0 21 1 * *",
        run: () => this.monthlyGovernanceReview(),
      },
      {
        // Continuous-learning refresh (docs/system-trust-review.md batch 3):
        // re-fits calibrators + ensemble on the latest walk-forward harness
        // run, and re-runs the champion-vs-baselines experiment against
        // newly-resolved PredictionLog rows. Sunday (no trading day) so a
        // full settled week of resolved predictions is available and it
        // never contends with the weekday scan/verify jobs.
        // Was "0 6 * * 0" (Sunday-only). Same node-cron day-of-week bug as
        // above, so this now fires DAILY at 06:00 IST and the job itself only
        // acts on Sunday.
        name: "weekly-calibration-refresh",
        expression: "0 6 * * *",
        run: () => this.weeklyCalibrationRefresh(),
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
    console.log("✓ Cron jobs scheduled — official-filings (Sat) and calibration (Sun) run daily, self-gated by weekday");
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
    if (!isIstWeekday()) throw new NotScheduledToday();
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

  /** 06:00 IST Sunday — continuous-learning refresh: calibration/ensemble + live baseline experiment. */
  private async weeklyCalibrationRefresh(): Promise<void> {
    // Fires daily at 06:00 IST (see istWeekday()); only act on Sunday — no
    // trading day, so a full settled week of resolved predictions is
    // available and it never contends with the weekday scan/verify jobs.
    if (istWeekday() !== 0) throw new NotScheduledToday();
    const { researchJobsService } = await import("./research/ResearchJobsService");
    const r = await researchJobsService.weeklyCalibrationRefresh();
    const failures: string[] = [];

    if ("error" in r.calibration) {
      console.error(`🎯 [CRON] calibration refresh failed: ${r.calibration.error}`);
      failures.push(`calibration: ${r.calibration.error}`);
    } else {
      console.log(
        `🎯 [CRON] calibration refresh: run ${r.calibration.experimentRunId}, ` +
          `${r.calibration.calibratorsPromoted}/${r.calibration.calibratorsFit} calibrators promoted`
      );
    }
    if (typeof r.experimentRunId === "object") {
      console.error(`🎯 [CRON] live baseline experiment failed: ${r.experimentRunId.error}`);
      failures.push(`live-baseline-experiment: ${r.experimentRunId.error}`);
    } else {
      console.log(`🎯 [CRON] live baseline experiment: run ${r.experimentRunId}`);
    }

    // Both sub-jobs isolate their own failures and RETURN them rather than
    // throwing (so one genuinely cannot sink the other — see
    // runWeeklyCalibrationRefresh). That means a clean return here does not
    // mean success: without this check, guarded() would log 'success' with no
    // error text even if BOTH halves failed, which is exactly the silent-loop
    // failure mode the durable cron log exists to catch.
    if (failures.length > 0) {
      throw new Error(`weeklyCalibrationRefresh: ${failures.length} of 2 sub-jobs failed — ${failures.join(" | ")}`);
    }
  }

  /** 07:30 IST on the 1st — global macro refresh (RBI + FRED India series + MoSPI). */
  private async monthlyMacroRefresh(): Promise<void> {
    const { intelligenceService } = await import("./intelligence/IntelligenceService");
    const r = (await intelligenceService.refreshMacro()) as { values?: unknown[]; errors?: unknown[] };
    console.log(`🌐 [CRON] macro refresh: ${r.values?.length ?? 0} observations, ${r.errors?.length ?? 0} provider notes`);
  }


  /** 08:45 IST — refresh universe bars, then scan + log predictions. */
  private async morningRefreshAndScan(): Promise<void> {
    if (!isIstWeekday()) throw new NotScheduledToday();
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
    if (!isIstWeekday()) throw new NotScheduledToday();
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

    // Lane C grading (decision-grader-v1): append outcomes for matured
    // DecisionSnapshots so the gate that actually decides live recommendations
    // builds its own track record. Isolated try — a grading failure must never
    // sink the verify job, and vice versa.
    try {
      const { decisionOutcomeService } = await import("./evidence/DecisionOutcomeService");
      const laneC = await decisionOutcomeService.gradeMatured();
      console.log(
        `⚖️ [CRON] Lane C outcomes: ${laneC.written} written (${laneC.graded} graded, ${laneC.truncated} truncated, ` +
          `${laneC.entryUnavailable} entry-unavailable, ${laneC.dataInvalid} invalid), ${laneC.pending} pending; ` +
          `${laneC.tickersExamined} tickers examined, ${laneC.tickersRemaining} deferred to the next run`
      );
    } catch (err) {
      console.error("⚖️ [CRON] Lane C grading failed:", err);
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
    // Fires daily at 20:15 IST (see istWeekday()); only act on Saturday.
    if (istWeekday() !== 6) throw new NotScheduledToday();
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
  /**
   * Run a scheduled job and PERSIST the attempt.
   *
   * Previously this logged only to the console, which meant the learning loop
   * left no durable trace: a failed grading run vanished on the next restart,
   * and `cron_execution_logs` stayed empty forever. That is precisely the
   * evidence needed to answer "is this system actually training itself, or has
   * it silently stopped?", so every attempt is now written to the table —
   * failures included, with their error text.
   *
   * The log write is best-effort and never masks the job: a logging failure
   * must not turn a successful refresh into a reported failure, and the job's
   * own error is always re-surfaced on the console.
   */
  private async guarded(name: string, run: () => Promise<void>): Promise<void> {
    if (this.running.has(name)) {
      console.warn(`⚠️ [CRON] ${name} still running — skipping this trigger`);
      return;
    }
    this.running.add(name);
    const started = Date.now();
    const startedAt = new Date();
    let status = "success";
    let errorSummary: string | null = null;

    try {
      await run();
      console.log(`✓ [CRON] ${name} finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    } catch (err) {
      if (err instanceof NotScheduledToday) {
        status = "skipped";
        console.log(`… [CRON] ${name}: not scheduled today`);
      } else {
        status = "failed";
        errorSummary = err instanceof Error ? `${err.message}\n${err.stack ?? ""}`.slice(0, 4000) : String(err).slice(0, 4000);
        console.error(`✗ [CRON] ${name} failed:`, err);
      }
    } finally {
      this.running.delete(name);
      try {
        await AppDataSource.query(
          `INSERT INTO cron_execution_logs
             (job_name, execution_start, execution_end, execution_duration_ms, status, error_summary)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [name, startedAt, new Date(), Date.now() - started, status, errorSummary]
        );
      } catch (logErr) {
        // Never let bookkeeping failure masquerade as job failure.
        console.error(`⚠️ [CRON] could not persist execution log for ${name}:`, logErr);
      }
    }
  }
}

export default CronService;
