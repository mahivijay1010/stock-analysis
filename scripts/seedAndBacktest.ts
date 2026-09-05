/**
 * seedAndBacktest — seed 2y of daily bars for the whole NSE universe, then
 * walk-forward backtest every seeded ticker (testDays 60), upsert
 * ModelPerformance, and print an aggregate accuracy table per horizon.
 *
 * Run: npx ts-node scripts/seedAndBacktest.ts
 *
 * Every number is measured from real Yahoo bars — nothing is fabricated.
 */

import "reflect-metadata";
import * as dotenv from "dotenv";
dotenv.config();

import { AppDataSource } from "../src/config/database";
import { marketDataService } from "../src/services/market/MarketDataService";
import { stockService } from "../src/services/StockService";
import { backtestBars } from "../src/services/quant/backtest";
import { NSE_UNIVERSE } from "../src/data/nseUniverse";
import { Horizon } from "../src/types";

const TEST_DAYS = 60;
const HORIZONS: Horizon[] = [1, 3, 7, 15, 30];

interface Agg {
  samples: number;
  hit: number; // sample-weighted direction hits
  err: number; // sample-weighted |error| sum
  band: number; // sample-weighted within-band count
}

async function main(): Promise<void> {
  // Quiet the console: TypeORM query logging would drown the report.
  AppDataSource.setOptions({ logging: false });
  await AppDataSource.initialize();
  console.log("✓ Database connected (synchronize applied entity changes if any)");

  // ── 1. Seed the universe (throttled ~350ms per Yahoo fetch) ────────────────
  console.log(`\n── Seeding ${NSE_UNIVERSE.length} universe tickers (2y daily bars) ──`);
  const startedSeed = Date.now();
  const { ok, failed } = await marketDataService.seedUniverse((done, total, ticker) => {
    if (done % 10 === 0 || done === total) {
      console.log(`  seed progress: ${done}/${total} (last: ${ticker})`);
    }
  });
  console.log(
    `✓ Seed complete in ${((Date.now() - startedSeed) / 1000).toFixed(0)}s: ` +
      `${ok.length} ok, ${failed.length} failed`
  );
  if (failed.length > 0) {
    console.log(`  FAILED TO SEED: ${failed.join(", ")}`);
  }

  // ── 2. Backtest every seeded ticker, upsert ModelPerformance ──────────────
  console.log(`\n── Backtesting ${ok.length} tickers (walk-forward, testDays=${TEST_DAYS}) ──`);
  const agg = new Map<Horizon, Agg>();
  for (const h of HORIZONS) agg.set(h, { samples: 0, hit: 0, err: 0, band: 0 });

  const backtested: string[] = [];
  const backtestFailed: string[] = [];

  for (let i = 0; i < ok.length; i++) {
    const ticker = ok[i];
    try {
      const bars = await marketDataService.getDailyBars(ticker, "2y");
      const result = backtestBars(ticker, bars, { testDays: TEST_DAYS });
      const totalSamples = result.horizons.reduce((s, h) => s + h.samples, 0);
      if (totalSamples === 0) {
        backtestFailed.push(ticker);
        console.log(`  [${i + 1}/${ok.length}] ${ticker} — SKIPPED (not enough history for any horizon)`);
        continue;
      }
      await stockService.upsertModelPerformance(ticker, result, bars);
      backtested.push(ticker);

      for (const h of result.horizons) {
        const a = agg.get(h.horizonDays)!;
        a.samples += h.samples;
        a.hit += (h.directionHitRatePct / 100) * h.samples;
        a.err += h.avgAbsErrorPct * h.samples;
        a.band += (h.withinBandPct / 100) * h.samples;
      }

      const h7 = result.horizons.find((h) => h.horizonDays === 7);
      console.log(
        `  [${i + 1}/${ok.length}] ${ticker} — ${totalSamples} samples` +
          (h7 ? `, 7d hit ${h7.directionHitRatePct.toFixed(1)}%, 7d |err| ${h7.avgAbsErrorPct.toFixed(2)}%` : "")
      );
    } catch (err) {
      backtestFailed.push(ticker);
      console.log(`  [${i + 1}/${ok.length}] ${ticker} — FAILED: ${(err as Error).message}`);
    }
  }

  // ── 3. Aggregate accuracy table ────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════════════════════");
  console.log(` AGGREGATE WALK-FORWARD ACCURACY  (testDays=${TEST_DAYS}, ${backtested.length} tickers)`);
  console.log("══════════════════════════════════════════════════════════════════");
  console.log(" Horizon | Samples | Direction hit % | Avg |error| % | Within 80% band %");
  console.log(" --------|---------|-----------------|---------------|------------------");
  for (const h of HORIZONS) {
    const a = agg.get(h)!;
    if (a.samples === 0) {
      console.log(`  ${String(h).padStart(3)}d   |       0 |               - |             - |                 -`);
      continue;
    }
    const hitPct = ((a.hit / a.samples) * 100).toFixed(2);
    const errPct = (a.err / a.samples).toFixed(2);
    const bandPct = ((a.band / a.samples) * 100).toFixed(2);
    console.log(
      `  ${String(h).padStart(3)}d   | ${String(a.samples).padStart(7)} | ${hitPct.padStart(15)} | ${errPct.padStart(13)} | ${bandPct.padStart(17)}`
    );
  }
  console.log("══════════════════════════════════════════════════════════════════");

  console.log(`\nSeeded OK: ${ok.length}/${NSE_UNIVERSE.length}`);
  console.log(`Seed failures (${failed.length}): ${failed.length ? failed.join(", ") : "none"}`);
  console.log(`Backtested + ModelPerformance upserted: ${backtested.length}`);
  console.log(`Backtest failures (${backtestFailed.length}): ${backtestFailed.length ? backtestFailed.join(", ") : "none"}`);

  await AppDataSource.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error("seedAndBacktest failed:", err);
  process.exit(1);
});
