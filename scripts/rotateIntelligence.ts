/**
 * V10 B1 — one-off/maintenance runner for the SAME code path the 08:45 cron
 * executes after the rank snapshot: refresh Intelligence for the 10 universe
 * tickers with the OLDEST stored metrics (never-stored first, <24h-fresh
 * skipped, ≥5s between NSE refreshes, per-ticker failures logged and
 * skipped). Safe to re-run — each run advances coverage by ≤10 tickers.
 *
 *   npx ts-node scripts/rotateIntelligence.ts
 */

import "reflect-metadata";
import * as dotenv from "dotenv";
dotenv.config();

import { AppDataSource } from "../src/config/database";
import { CronService } from "../src/services/CronService";
import { stockService } from "../src/services/StockService";

async function main(): Promise<void> {
  await AppDataSource.initialize();
  console.log("DB connected — rotating intelligence refresh (10 stalest)...");
  const started = Date.now();
  await new CronService(stockService).rotatingIntelligenceRefresh();
  console.log(`✓ Rotation pass finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  await AppDataSource.destroy();
}

main().catch((err) => {
  console.error("✗ rotateIntelligence failed:", err);
  process.exit(1);
});
