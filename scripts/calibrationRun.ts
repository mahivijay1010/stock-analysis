/**
 * OFFLINE RESEARCH CLI (completion Phases 7+8): manual entry point for the
 * calibration + ensemble refresh. The actual logic lives in
 * src/services/research/calibrationEnsembleRun.ts (runCalibrationEnsembleRefresh),
 * which is ALSO scheduled weekly by CronService — this script is now a thin
 * wrapper kept for manual/on-demand runs and CI-style verification, not the
 * only way this logic executes.
 *
 * Usage: npx ts-node --transpile-only scripts/calibrationRun.ts [--with-python]
 */

import { AppDataSource } from "../src/config/database";
import { runCalibrationEnsembleRefresh } from "../src/services/research/calibrationEnsembleRun";

async function main(): Promise<void> {
  const withPython = process.argv.includes("--with-python");
  await AppDataSource.initialize();

  const result = await runCalibrationEnsembleRefresh({
    withPython,
    log: (m) => console.log("  •", m),
  });

  console.log(`\nExperimentRun ${result.experimentRunId} persisted.`);
  console.log(`calibrators fit: ${result.calibratorsFit}, promoted: ${result.calibratorsPromoted}`);
  console.log("\n== calibration verdicts ==");
  for (const v of result.calibrationVerdicts) console.log(v);
  console.log("\n== ensemble (validation-built, test-evaluated) ==");
  for (const v of result.ensembleVerdicts) console.log(v);
  if (result.skipped.length) {
    console.log(`\nskipped: ${result.skipped.length}`);
    for (const s of result.skipped) console.log(`  - ${s}`);
  }
  await AppDataSource.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
