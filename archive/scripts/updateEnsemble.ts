/**
 * updateEnsemble (V7 Module A3) — one manual/cron pass of the light FTRL-style
 * online regret update: for every verified PredictionLog that matured on the
 * latest outcome date, re-run the pure 6-model pool on the AS-OF bars (zero
 * lookahead; bars are DB-cached), compute each model's hindsight brier on the
 * real outcome, and update the stored per-(ticker,horizon) weights
 * w ← w·exp(−η·brier), η = 2, renormalized.
 *
 * Run: npx ts-node scripts/updateEnsemble.ts
 * (The 18:30 IST verify cron runs the same service method automatically.)
 */

import "reflect-metadata";
import * as dotenv from "dotenv";
dotenv.config();

import { AppDataSource } from "../src/config/database";
import { ensembleService } from "../src/services/ensemble/EnsembleService";

async function main(): Promise<void> {
  AppDataSource.setOptions({ logging: false });
  await AppDataSource.initialize();
  console.log("✓ Database connected");

  const result = await ensembleService.updateFromLatestMaturedDay();
  if (!result.latestOutcomeDate) {
    console.log("No verified matured predictions found — nothing to update.");
  } else {
    console.log(
      `\n⚖️ Ensemble regret update from outcomes matured on ${result.latestOutcomeDate}:`
    );
    console.log(`   (ticker, horizon) weight rows updated: ${result.updatedPairs}`);
    console.log(`   best-model switches:                   ${result.switches}`);
    console.log(`   rows skipped (no usable as-of bars):   ${result.skipped}`);
    console.log(
      "\nWeights persist in ensemble_weights; /api/calibration now reports this run under modelDrift."
    );
  }

  await AppDataSource.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error("updateEnsemble failed:", err);
  process.exit(1);
});
