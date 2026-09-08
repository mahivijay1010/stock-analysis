/** Cycle 1: standing of the NEW mandatory baselines (EWMA, HAR-RV, ARX) vs the existing set. OFFLINE RESEARCH. */
import { createHash } from "crypto";
import { AppDataSource } from "../src/config/database";
import { ExperimentRun } from "../src/entities";
import { NSE_UNIVERSE } from "../src/data/nseUniverse";
import { runWalkForward } from "../src/services/research/harness";
import { tsBaselineModels, tsStatisticalModels } from "../src/services/research/models";

async function main() {
  await AppDataSource.initialize();
  const started = new Date();
  const result = await runWalkForward({
    tickers: NSE_UNIVERSE.slice(0, 40).map((u) => u.ticker),
    horizons: [1, 7, 30],
    models: [...tsBaselineModels(), ...tsStatisticalModels()],
    includeChampion: false,
    log: (m) => console.log("  •", m),
  });
  const repo = AppDataSource.getRepository(ExperimentRun);
  const run = await repo.save(repo.create({
    name: "baseline-completion-study", kind: "challenger", modelVersion: "features-v2",
    config: { newBaselines: ["stat-ewma", "stat-har-rv", "stat-arx"], note: "Part F mandatory baseline completion" },
    splits: { counts: result.splitCounts, skipped: result.skipped },
    datasetManifest: { tickers: result.tickers, source: "stock_history adjusted — OFFLINE RESEARCH" },
    datasetHash: createHash("sha256").update(JSON.stringify(result.splitCounts)).digest("hex"),
    metrics: { models: result.metrics }, baselines: {}, segmentsUsed: ["test"], usedFinalTest: true,
    status: "completed", startedAt: started, finishedAt: new Date(),
  }));
  console.log(`run ${run.id}`);
  for (const m of result.metrics as Array<Record<string, any>>) {
    if (!["stat-ewma", "stat-har-rv", "stat-arx", "baseline-zero-return", "stat-ar1"].includes(m.model)) continue;
    console.log(`${String(m.model).padEnd(22)} h=${m.horizonDays} brier=${m.direction?.brier} bss=${m.direction?.brierSkillVsConstant50} mae=${m.returns?.maePct} cov80=${m.distribution?.coverage80Pct} crps=${m.distribution?.crps}`);
  }
  await AppDataSource.destroy();
}
main().catch((e) => { console.error(e); process.exit(1); });
