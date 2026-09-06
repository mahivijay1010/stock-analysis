/**
 * refreshBacktests — re-backtest the whole NSE universe from DB-cached bars
 * (testDays 60), upsert ModelPerformance so every row carries the V6
 * calibration fields (brierScore + probBuckets), then print the aggregate
 * brier/calibration table.
 *
 * Run: npx ts-node scripts/refreshBacktests.ts
 *
 * This SCRIPT is a legitimate official-stats writer (job path) — the HTTP
 * GET /api/backtest/:ticker is read-only since the v2 upgrade
 * (upgrade-audit §4 #1); ad-hoc runs go through POST /api/jobs/backtest.
 * The V7 six-model pool merge was removed from production execution
 * (upgrade-spec §2 row 6) — historical per-model jsonb keys on old
 * ModelPerformance rows are preserved, no longer written.
 *
 * No seeding pass: bars are served from stock_history when fresh (a stale
 * ticker may trigger a single throttled Yahoo refresh — never a hammering).
 * Every number is measured from real bars — nothing is fabricated.
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
const COIN_FLIP_BRIER = 0.25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Agg {
  samples: number;
  hit: number; // sample-weighted direction hits
  band: number; // sample-weighted within-band count
  brier: number; // sample-weighted brier sum
  brierSamples: number; // samples that carried a brierScore
}

async function main(): Promise<void> {
  // Quiet the console: TypeORM query logging would drown the report.
  AppDataSource.setOptions({ logging: false });
  await AppDataSource.initialize();
  console.log("✓ Database connected");

  console.log(
    `\n── Re-backtesting ${NSE_UNIVERSE.length} universe tickers from DB bars ` +
      `(walk-forward, testDays=${TEST_DAYS}) ──`
  );

  const agg = new Map<Horizon, Agg>();
  for (const h of HORIZONS) {
    agg.set(h, { samples: 0, hit: 0, band: 0, brier: 0, brierSamples: 0 });
  }

  const refreshed: string[] = [];
  const failed: string[] = [];

  for (let i = 0; i < NSE_UNIVERSE.length; i++) {
    const ticker = NSE_UNIVERSE[i].ticker;
    try {
      const { bars, source } = await marketDataService.getDailyBarsWithSource(ticker, "2y");
      if (bars.length < 122) {
        failed.push(ticker);
        console.log(
          `  [${i + 1}/${NSE_UNIVERSE.length}] ${ticker} — SKIPPED (${bars.length} bars < 122)`
        );
        continue;
      }
      const result = backtestBars(ticker, bars, { testDays: TEST_DAYS });
      const totalSamples = result.horizons.reduce((s, h) => s + h.samples, 0);
      if (totalSamples === 0) {
        failed.push(ticker);
        console.log(
          `  [${i + 1}/${NSE_UNIVERSE.length}] ${ticker} — SKIPPED (no matured samples)`
        );
        continue;
      }
      await stockService.upsertModelPerformance(ticker, result, bars);
      refreshed.push(ticker);

      for (const h of result.horizons) {
        const a = agg.get(h.horizonDays)!;
        a.samples += h.samples;
        a.hit += (h.directionHitRatePct / 100) * h.samples;
        a.band += (h.withinBandPct / 100) * h.samples;
        if (h.brierScore !== undefined && h.samples > 0) {
          a.brier += h.brierScore * h.samples;
          a.brierSamples += h.samples;
        }
      }

      const h7 = result.horizons.find((h) => h.horizonDays === 7);
      console.log(
        `  [${i + 1}/${NSE_UNIVERSE.length}] ${ticker} — ${totalSamples} samples` +
          (h7?.brierScore !== undefined
            ? `, 7d brier ${h7.brierScore.toFixed(4)}, 7d hit ${h7.directionHitRatePct.toFixed(1)}%`
            : "") +
          (source !== "db-fresh" ? ` [bars: ${source}]` : "")
      );
      // Throttle only when an actual Yahoo fetch happened (stale ticker).
      if (source === "yahoo") await sleep(350);
    } catch (err) {
      failed.push(ticker);
      console.log(
        `  [${i + 1}/${NSE_UNIVERSE.length}] ${ticker} — FAILED: ${(err as Error).message}`
      );
    }
  }

  // ── Aggregate brier table ───────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════════════════════════════");
  console.log(
    ` AGGREGATE BRIER / CALIBRATION  (testDays=${TEST_DAYS}, ${refreshed.length} tickers, coin-flip = ${COIN_FLIP_BRIER})`
  );
  console.log("══════════════════════════════════════════════════════════════════════════");
  console.log(" Horizon | Samples | Brier score | Skill vs coin-flip | Direction hit % | Within 80% band %");
  console.log(" --------|---------|-------------|--------------------|-----------------|------------------");
  for (const h of HORIZONS) {
    const a = agg.get(h)!;
    if (a.brierSamples === 0) {
      console.log(
        `  ${String(h).padStart(3)}d   |       0 |           - |                  - |               - |                 -`
      );
      continue;
    }
    const brier = a.brier / a.brierSamples;
    const skillPct = ((COIN_FLIP_BRIER - brier) / COIN_FLIP_BRIER) * 100;
    const hitPct = ((a.hit / a.samples) * 100).toFixed(2);
    const bandPct = ((a.band / a.samples) * 100).toFixed(2);
    console.log(
      `  ${String(h).padStart(3)}d   | ${String(a.samples).padStart(7)} | ${brier.toFixed(4).padStart(11)} | ${(skillPct.toFixed(2) + "%").padStart(18)} | ${hitPct.padStart(15)} | ${bandPct.padStart(17)}`
    );
  }
  console.log("══════════════════════════════════════════════════════════════════════════");

  console.log(`\nRefreshed + ModelPerformance upserted: ${refreshed.length}/${NSE_UNIVERSE.length}`);
  console.log(`Failures (${failed.length}): ${failed.length ? failed.join(", ") : "none"}`);

  await AppDataSource.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error("refreshBacktests failed:", err);
  process.exit(1);
});
