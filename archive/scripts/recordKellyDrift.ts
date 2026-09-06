/**
 * V9 E3 — one-off/maintenance runner for the SAME code path the 18:30 IST
 * evening cron executes after the verify job: measure the desk's execution
 * stats and upsert TODAY's kelly_drift row. Safe to re-run (unique date
 * upsert — a re-run simply overwrites today's row with fresh measurements).
 *
 *   npx ts-node scripts/recordKellyDrift.ts
 */

import "reflect-metadata";
import * as dotenv from "dotenv";
dotenv.config();

import { AppDataSource } from "../src/config/database";
import { executionAnalyticsService } from "../src/services/admin/ExecutionAnalyticsService";

async function main(): Promise<void> {
  await AppDataSource.initialize();
  console.log("DB connected — recording today's Kelly-drift snapshot...");
  const started = Date.now();
  const row = await executionAnalyticsService.recordDriftSnapshot();
  console.log(
    `✓ Kelly drift recorded for ${row.date}: closedTrades=${row.closedTrades}, ` +
      `measuredP=${row.measuredP ?? "null"}, measuredB=${row.measuredB ?? "null"}, ` +
      `halfKellyPct=${row.halfKellyPct ?? "null"}, applied=${row.applied} ` +
      `in ${((Date.now() - started) / 1000).toFixed(1)}s`
  );
  await AppDataSource.destroy();
}

main().catch((err) => {
  console.error("✗ recordKellyDrift failed:", err);
  process.exit(1);
});
