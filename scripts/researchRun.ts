/**
 * OFFLINE RESEARCH RUN (completion directive, Phases 5/16) — walk-forward
 * evaluation of the old champion vs baselines vs challengers on real stored
 * history. Persists an append-only ExperimentRun; touches NO live records.
 *
 * Usage: npx ts-node --transpile-only scripts/researchRun.ts [--with-python] [--tickers N]
 */

import { createHash } from "crypto";
import { AppDataSource } from "../src/config/database";
import { ExperimentRun } from "../src/entities";
import { NSE_UNIVERSE } from "../src/data/nseUniverse";
import { runWalkForward, HARNESS_VERSION } from "../src/services/research/harness";
import { tsBaselineModels, tsStatisticalModels } from "../src/services/research/models";
import { pythonWorkerModels, pythonWorkerAvailable } from "../src/services/research/pythonProvider";

async function main(): Promise<void> {
  const withPython = process.argv.includes("--with-python");
  const nArg = process.argv.indexOf("--tickers");
  const nTickers = nArg > 0 ? Number(process.argv[nArg + 1]) : 40;

  await AppDataSource.initialize();
  const started = new Date();
  const tickers = NSE_UNIVERSE.slice(0, nTickers).map((u) => u.ticker);

  let external = undefined;
  if (withPython) {
    const up = await pythonWorkerAvailable();
    if (!up) {
      console.log("Python worker not reachable on :5102 — running WITHOUT ML challengers (stated, not hidden).");
    } else {
      external = pythonWorkerModels();
      console.log(`Python worker up — including ${external.map((m) => m.name).join(", ")}`);
    }
  }

  const result = await runWalkForward({
    tickers,
    horizons: [1, 7, 30],
    models: [...tsBaselineModels(), ...tsStatisticalModels()],
    externalModels: external,
    includeChampion: true,
    log: (m) => console.log("  •", m),
  });

  const datasetHash = createHash("sha256")
    .update(JSON.stringify({ tickers: result.tickers, horizons: result.horizons, splits: result.splitCounts }))
    .digest("hex");

  const repo = AppDataSource.getRepository(ExperimentRun);
  const run = await repo.save(
    repo.create({
      name: "walk-forward-research",
      kind: "champion-eval",
      modelVersion: "multi",
      config: { harness: HARNESS_VERSION, tickers: result.tickers.length, horizons: result.horizons, withPython: !!external },
      splits: { counts: result.splitCounts, skipped: result.skipped, method: "date-grouped chronological, purged+embargoed" },
      datasetManifest: {
        source: "stock_history (adjusted closes) — OFFLINE RESEARCH, no live records touched",
        tickers: result.tickers,
      },
      datasetHash,
      metrics: { models: result.metrics },
      baselines: { note: "constant-50 / zero-return / historical-mean / base-rate / momentum evaluated as models on identical splits" },
      segmentsUsed: ["train", "validation", "calibration", "test"],
      usedFinalTest: true, // the test segment is consumed by THIS comparison — recorded honestly
      status: "completed",
      startedAt: started,
      finishedAt: new Date(),
    })
  );
  console.log(`\nExperimentRun ${run.id} persisted (${result.metrics.length} model×horizon rows).`);

  // Compact console table.
  for (const h of result.horizons) {
    console.log(`\n== ${h}d (test) ==`);
    for (const m of result.metrics.filter((x) => x.horizonDays === h)) {
      console.log(
        `${m.model.padEnd(24)} hit ${String(m.direction.hitRatePct ?? "—").padStart(6)}%` +
          ` brier ${String(m.direction.brier ?? "—").padStart(7)}` +
          ` bss ${String(m.direction.brierSkillVsConstant50 ?? "—").padStart(7)}` +
          ` mae ${String(m.returns.maePct ?? "—").padStart(6)}%` +
          ` cov80 ${String(m.distribution.coverage80Pct ?? "—").padStart(6)}%` +
          ` crps ${String(m.distribution.crpsApprox ?? "—").padStart(6)}` +
          ` n=${m.rawSamples}/eff${m.effectiveSamples}/no${m.nonOverlappingSamples}`
      );
    }
  }
  await AppDataSource.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
