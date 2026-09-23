/**
 * Manual catch-up for a missed morning-refresh-and-scan, logged honestly.
 *
 * Context: the 08:45 IST job failed to run on 2026-09-21 and 2026-09-22.
 * Verified from the database, not a log file: cron_execution_logs had no row
 * and `analysis` / `rank_snapshots` were empty for the date. (The backend's
 * stdout log silently stops receiving output overnight while the process keeps
 * serving HTTP — observed on three separate log files — so it is not evidence
 * of anything.)
 *
 * ROOT CAUSE, found 2026-09-23 from `pmset -g log`: THE LAPTOP WAS ASLEEP.
 * On both mornings the machine sat in deep sleep with 2-second "dark wakes"
 * every ~17 minutes; the 08:45:00 instant fell inside one (09-21: DarkWake
 * 08:45:06, back to sleep 08:45:08) or between them (09-22: asleep 08:43→08:52).
 * node-cron has no catch-up, so a suspended instant is simply lost and nothing
 * reports it.
 *
 * Two earlier diagnoses were WRONG and are retracted: (1) ts-node-dev
 * hot-reloads detaching timers; (2) a long-armed node-cron timer bug. The
 * daily-expression + weekday-guard conversion those produced is harmless and
 * stays (the Sat/Sun day-of-week bug it also fixes WAS real), but the reason
 * recorded in cron_execution_logs was wrong twice; both rows now carry a dated
 * second correction naming sleep.
 *
 * This script remains as the manual fallback. The systematic fix is the
 * automatic missed-run catch-up in CronService (compares expected runs against
 * cron_execution_logs and runs whatever the machine slept through, logged as
 * "(auto catch-up)").
 *
 * Usage: npx ts-node --transpile-only scripts/runMissedMorningScan.ts
 */

import { AppDataSource } from "../src/config/database";
import { StockService } from "../src/services/StockService";
import { rankService } from "../src/services/RankService";

const JOB_NAME = "morning-refresh-and-scan (manual catch-up)";

async function main(): Promise<void> {
  await AppDataSource.initialize();
  const startedAt = new Date();
  const started = Date.now();
  let status = "success";
  let errorSummary: string | null = null;

  try {
    const stockService = new StockService();

    console.log("refreshing universe bars...");
    const { ok, failed } = await stockService.refreshUniverseBars();
    console.log(`universe refresh: ${ok.length} ok, ${failed.length} failed${failed.length ? ` (${failed.slice(0, 5).join(", ")}${failed.length > 5 ? "…" : ""})` : ""}`);

    console.log("running top-picks scan + logging predictions...");
    const scan = await stockService.scanUniverse({ logPredictions: true });
    console.log(`scan complete: ${scan.scannedCount} stocks scored, predictions logged per horizon`);

    // Mirrors the cron job: a rank-snapshot failure never sinks the scan.
    try {
      const snap = await rankService.persistTodaySnapshot();
      console.log(`rank snapshot: ${snap.rowsPersisted} tickers for ${snap.date}`);
    } catch (err) {
      console.error("rank snapshot failed:", err);
    }
  } catch (err) {
    status = "failed";
    errorSummary = err instanceof Error ? `${err.message}\n${err.stack ?? ""}`.slice(0, 4000) : String(err).slice(0, 4000);
    console.error("morning scan failed:", err);
  } finally {
    await AppDataSource.query(
      `INSERT INTO cron_execution_logs
         (job_name, execution_start, execution_end, execution_duration_ms, status, error_summary)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        JOB_NAME,
        startedAt,
        new Date(),
        Date.now() - started,
        status,
        errorSummary ??
          "Ran manually because the scheduled 08:45 IST firing did not occur: the laptop was asleep " +
            "through the instant (pmset log). node-cron has no catch-up. See CronService auto catch-up.",
      ]
    );
    console.log(`\nLogged to cron_execution_logs as "${JOB_NAME}", status=${status}.`);
  }
  await AppDataSource.destroy();
  process.exit(status === "success" ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
