/**
 * V8 R1 — one-off/maintenance runner for the SAME code path the 08:45 cron
 * executes after the morning scan: build the cross-sectional rank and upsert
 * today's rank_snapshots rows. Safe to re-run (unique (date, ticker) upsert).
 *
 *   npx ts-node scripts/persistRankSnapshot.ts
 */

import "reflect-metadata";
import * as dotenv from "dotenv";
dotenv.config();

import { AppDataSource } from "../src/config/database";
import { rankService } from "../src/services/RankService";

async function main(): Promise<void> {
  await AppDataSource.initialize();
  console.log("DB connected — building rank universe (151 tickers)...");
  const started = Date.now();
  const result = await rankService.persistTodaySnapshot();
  console.log(
    `✓ Rank snapshot persisted: ${result.rowsPersisted} tickers for ${result.date} ` +
      `in ${((Date.now() - started) / 1000).toFixed(1)}s`
  );
  await AppDataSource.destroy();
}

main().catch((err) => {
  console.error("✗ persistRankSnapshot failed:", err);
  process.exit(1);
});
