/**
 * One-off manual trigger for this week's calibration refresh, logged
 * honestly as a manual run.
 *
 * Context: weekly-calibration-refresh was scheduled as "0 6 * * 0" and never
 * actually fired — node-cron 4.2.1's day-of-week fallback has a real bug
 * (confirmed 2026-09-20; see CronService.istWeekday() docstring) that
 * resolved that expression's next match to the year 2034. The fix moves the
 * weekday check into the job body and runs it daily instead, but the fix
 * landed at 21:28 IST on Sunday 2026-09-20 — after today's 06:00 window had
 * already passed. Rather than let an entire week go by with zero learning
 * (again), this script runs the same underlying job the cron would have run,
 * through the same guarded()-style durable logging, so the record shows
 * exactly what it is: a manual catch-up, not a scheduled success.
 *
 * Usage: npx ts-node --transpile-only scripts/runMissedCalibration.ts
 */

import { AppDataSource } from "../src/config/database";
import { researchJobsService } from "../src/services/research/ResearchJobsService";

const JOB_NAME = "weekly-calibration-refresh";

async function main(): Promise<void> {
  await AppDataSource.initialize();
  const startedAt = new Date();
  const started = Date.now();
  let status = "success";
  let errorSummary: string | null = null;

  try {
    const r = await researchJobsService.weeklyCalibrationRefresh();
    const failures: string[] = [];

    if ("error" in r.calibration) {
      failures.push(`calibration: ${r.calibration.error}`);
    } else {
      console.log(
        `calibration refresh: run ${r.calibration.experimentRunId}, ` +
          `${r.calibration.calibratorsPromoted}/${r.calibration.calibratorsFit} calibrators promoted`
      );
    }
    if (typeof r.experimentRunId === "object") {
      failures.push(`live-baseline-experiment: ${r.experimentRunId.error}`);
    } else {
      console.log(`live baseline experiment: run ${r.experimentRunId}`);
    }

    if (failures.length > 0) {
      throw new Error(`${failures.length} of 2 sub-jobs failed — ${failures.join(" | ")}`);
    }
  } catch (err) {
    status = "failed";
    errorSummary = err instanceof Error ? `${err.message}\n${err.stack ?? ""}`.slice(0, 4000) : String(err).slice(0, 4000);
    console.error("calibration refresh failed:", err);
  } finally {
    await AppDataSource.query(
      `INSERT INTO cron_execution_logs
         (job_name, execution_start, execution_end, execution_duration_ms, status, error_summary)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        `${JOB_NAME} (manual catch-up)`,
        startedAt,
        new Date(),
        Date.now() - started,
        status,
        errorSummary ??
          "Ran manually because the scheduled 06:00 IST Sunday firing was lost to a node-cron day-of-week " +
            "bug (see CronService.istWeekday()); the fix landed after today's window had already passed.",
      ]
    );
    console.log(`\nLogged to cron_execution_logs as "${JOB_NAME} (manual catch-up)", status=${status}.`);
  }
  await AppDataSource.destroy();
  process.exit(status === "success" ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
