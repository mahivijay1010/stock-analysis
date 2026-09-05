/**
 * refreshBacktests — re-backtest the whole NSE universe from DB-cached bars
 * (testDays 60), upsert ModelPerformance so every row carries the V6
 * calibration fields (brierScore + probBuckets) AND the V7 model-pool stats
 * (per-model + blended-ensemble walk-forward briers), then print:
 *   1. the V6 aggregate brier/calibration table,
 *   2. the V7 per-model aggregate brier table per horizon, including the
 *      out-of-sample BLENDED ensemble vs the V6 engine baseline (honest delta).
 *
 * Run: npx ts-node scripts/refreshBacktests.ts
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
import { NSE_UNIVERSE } from "../src/data/nseUniverse";
import { Horizon, ModelHorizonStat } from "../src/types";
import { MODEL_NAMES } from "../src/services/quant/models";

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

interface MAgg {
  samples: number;
  brierSum: number; // Σ brier × samples
  hitSum: number; // Σ hitRate fraction × samples
}

function bump(map: Map<Horizon, MAgg>, h: Horizon, s: ModelHorizonStat | undefined): void {
  if (!s || !(s.samples > 0)) return;
  const a = map.get(h) ?? { samples: 0, brierSum: 0, hitSum: 0 };
  a.samples += s.samples;
  a.brierSum += s.brier * s.samples;
  a.hitSum += (s.hitRatePct / 100) * s.samples;
  map.set(h, a);
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

  // V7: per-model + blended aggregates across the universe.
  const modelAgg = new Map<string, Map<Horizon, MAgg>>();
  for (const name of MODEL_NAMES) modelAgg.set(name, new Map());
  const blendAgg = new Map<Horizon, MAgg>();

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
      // V7: quant backtest + 6-model pool walk-forward, merged into one row.
      const result = await stockService.backtestWithModelPool(ticker, bars, TEST_DAYS);
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
        // V7 model-pool aggregates.
        if (h.models) {
          for (const name of MODEL_NAMES) {
            bump(modelAgg.get(name)!, h.horizonDays, h.models[name]);
          }
        }
        bump(blendAgg, h.horizonDays, h.ensemble);
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

  // ── V7: per-model aggregate brier table (+ blended vs V6 engine delta) ─────
  console.log("\n══════════════════════════════════════════════════════════════════════════════════════════════════════");
  console.log(
    ` MODEL POOL AGGREGATE BRIER  (walk-forward, testDays=${TEST_DAYS}, ${refreshed.length} tickers, coin-flip = ${COIN_FLIP_BRIER})`
  );
  console.log("══════════════════════════════════════════════════════════════════════════════════════════════════════");
  const cols = [...MODEL_NAMES.map((n) => n as string), "BLENDED", "V6 engine", "Δ(blend−V6)"];
  console.log(
    " Horizon |" + cols.map((c) => ` ${c.padStart(13)} |`).join("")
  );
  console.log(
    " --------|" + cols.map(() => "---------------|").join("")
  );
  for (const h of HORIZONS) {
    const cells: string[] = [];
    for (const name of MODEL_NAMES) {
      const a = modelAgg.get(name)!.get(h);
      cells.push(a && a.samples > 0 ? (a.brierSum / a.samples).toFixed(4) : "-");
    }
    const b = blendAgg.get(h);
    const blendBrier = b && b.samples > 0 ? b.brierSum / b.samples : null;
    cells.push(blendBrier !== null ? blendBrier.toFixed(4) : "-");
    const e = agg.get(h)!;
    const engineBrier = e.brierSamples > 0 ? e.brier / e.brierSamples : null;
    cells.push(engineBrier !== null ? engineBrier.toFixed(4) : "-");
    cells.push(
      blendBrier !== null && engineBrier !== null
        ? (blendBrier - engineBrier >= 0 ? "+" : "") + (blendBrier - engineBrier).toFixed(4)
        : "-"
    );
    console.log(
      `  ${String(h).padStart(3)}d   |` + cells.map((c) => ` ${c.padStart(13)} |`).join("")
    );
  }
  console.log("══════════════════════════════════════════════════════════════════════════════════════════════════════");
  console.log(
    " BLENDED = out-of-sample online inverse-Brier ensemble measured inside the same walk-forward.\n" +
    " Δ(blend−V6): negative = the blended ensemble beat the V6 single model; reported honestly even when ≈ 0.\n" +
    " Historical news/regime context is not archived, so sentiment/macro models ran on price/index terms only."
  );

  // ── V7: per-model hit-rate table (same aggregation) ───────────────────────
  console.log("\n Horizon hit rates (%, sample-weighted):");
  console.log(
    " Horizon |" + [...MODEL_NAMES.map((n) => n as string), "BLENDED"].map((c) => ` ${c.padStart(13)} |`).join("")
  );
  for (const h of HORIZONS) {
    const cells: string[] = [];
    for (const name of MODEL_NAMES) {
      const a = modelAgg.get(name)!.get(h);
      cells.push(a && a.samples > 0 ? ((a.hitSum / a.samples) * 100).toFixed(2) : "-");
    }
    const b = blendAgg.get(h);
    cells.push(b && b.samples > 0 ? ((b.hitSum / b.samples) * 100).toFixed(2) : "-");
    console.log(
      `  ${String(h).padStart(3)}d   |` + cells.map((c) => ` ${c.padStart(13)} |`).join("")
    );
  }

  console.log(`\nRefreshed + ModelPerformance upserted: ${refreshed.length}/${NSE_UNIVERSE.length}`);
  console.log(`Failures (${failed.length}): ${failed.length ? failed.join(", ") : "none"}`);

  await AppDataSource.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error("refreshBacktests failed:", err);
  process.exit(1);
});
