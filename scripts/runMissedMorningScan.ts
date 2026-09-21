/**
 * Manual catch-up for a missed morning-refresh-and-scan, logged honestly.
 *
 * Context: on 2026-09-21 the 08:45 IST job did not run. Verified from the
 * database rather than a log file (cron_execution_logs had no row, and both
 * `analysis` and `rank_snapshots` were empty for the date), because the
 * backend's stdout log had silently stopped receiving output hours earlier
 * while the process kept serving HTTP. The most likely cause is that repeated
 * ts-node-dev hot-reloads — triggered by editing backend source during the
 * session — detached the cron timers from the still-running process. A
 * freshly-restarted process was verified to fire a `* * 1-5` expression
 * correctly, so the schedule shape itself is sound.
 *
 * This runs the same work the cron job would have, through the same durable
 * logging, labelled "(manual catch-up)" with the reason recorded — so the
 * pipeline history shows what actually happened rather than a clean run that
 * never occurred.
 *
 * Deliberately does NOT re-run the rotating intelligence refresh: that is a
 * throttled ~13s-per-ticker scrape whose only purpose is slow background
 * coverage, and skipping one day costs nothing while re-running it mid-session
 * would compete with the live feed for network.
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
          "Ran manually because the scheduled 08:45 IST firing did not occur — most likely ts-node-dev " +
            "hot-reloads detaching cron timers after backend source was edited during the session.",
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
