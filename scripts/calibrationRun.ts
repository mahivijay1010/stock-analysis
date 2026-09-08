/**
 * OFFLINE RESEARCH: calibration + ensemble study (completion Phases 7+8).
 *
 * Reruns the walk-forward harness, then:
 *  1. per model×horizon: fits Platt/isotonic/beta on the EARLIER slice of the
 *     validation predictions, selects on the LATER held-out slice, and — for
 *     promoted calibrators only — reports the final effect on the untouched
 *     TEST segment;
 *  2. builds the global ensemble from VALIDATION evidence (eligibility +
 *     inverse-Brier-excess weights) and evaluates it on TEST;
 *  3. persists everything: an ExperimentRun + append-only calibrators rows
 *     (including rejections — negative results are results).
 *
 * Usage: npx ts-node --transpile-only scripts/calibrationRun.ts [--with-python]
 */

import { createHash } from "crypto";
import { AppDataSource } from "../src/config/database";
import { CalibratorRecord, ExperimentRun } from "../src/entities";
import { NSE_UNIVERSE } from "../src/data/nseUniverse";
import { runWalkForward, H_TD, PredRecord } from "../src/services/research/harness";
import { tsBaselineModels, tsStatisticalModels, ModelOutput } from "../src/services/research/models";
import { pythonWorkerAvailable, pythonWorkerModels } from "../src/services/research/pythonProvider";
import { applyCalibrator, CalPoint, selectCalibrator } from "../src/services/research/calibration";
import { buildEnsemble, combineOutputs } from "../src/services/research/ensemble";
import { round4 } from "../src/services/research/metrics";

const flat = (r: number): 0 | 1 => (r > 0 ? 1 : 0);

function brierOf(preds: Array<{ p: number; y: 0 | 1 }>): number | null {
  if (preds.length === 0) return null;
  return round4(preds.reduce((a, x) => a + (x.p - x.y) ** 2, 0) / preds.length);
}

async function main(): Promise<void> {
  const withPython = process.argv.includes("--with-python");
  await AppDataSource.initialize();
  const started = new Date();

  let external = undefined;
  if (withPython && (await pythonWorkerAvailable())) external = pythonWorkerModels();

  const result = await runWalkForward({
    tickers: NSE_UNIVERSE.slice(0, 40).map((u) => u.ticker),
    horizons: [1, 7, 30],
    models: [...tsBaselineModels(), ...tsStatisticalModels()],
    externalModels: external,
    includeChampion: true,
    log: (m) => console.log("  •", m),
  });

  const calibrationRows: Array<Record<string, unknown>> = [];
  const ensembleRows: Array<Record<string, unknown>> = [];
  const repo = AppDataSource.getRepository(CalibratorRecord);

  for (const h of result.horizons) {
    const td = H_TD[h] ?? 1;

    // ── calibration per model ────────────────────────────────────────────
    for (const [key, valPreds] of Object.entries(result.validationPredictions)) {
      const [model, hs] = key.split("|");
      if (Number(hs) !== h) continue;
      const points: CalPoint[] = valPreds
        .filter((p) => p.output.rawDirectionProbability != null)
        .map((p) => ({ prob: p.output.rawDirectionProbability as number, outcome: flat(p.target), date: p.date }));
      if (points.length === 0) continue;

      const report = selectCalibrator(points, td);

      // Final honest check on the untouched TEST segment (promoted only).
      let testBefore: number | null = null;
      let testAfter: number | null = null;
      const testPreds = (result.testPredictions[key] ?? []).filter((p) => p.output.rawDirectionProbability != null);
      if (testPreds.length > 0) {
        testBefore = brierOf(testPreds.map((p) => ({ p: p.output.rawDirectionProbability as number, y: flat(p.target) })));
        if (report.calibrator) {
          testAfter = brierOf(
            testPreds.map((p) => ({ p: applyCalibrator(report.calibrator!, p.output.rawDirectionProbability as number), y: flat(p.target) }))
          );
        }
      }

      calibrationRows.push({ model, horizonDays: h, ...report, calibrator: undefined, testBrierBefore: testBefore, testBrierAfter: testAfter });
      await repo.save(
        repo.create({
          modelName: model,
          horizonDays: h,
          calibratorType: report.calibratorType,
          version: report.calibrator?.version ?? null,
          params: (report.calibrator?.params as Record<string, unknown>) ?? null,
          trainingStart: report.trainingStart || null,
          trainingEnd: report.trainingEnd || null,
          effectiveSamples: report.effectiveSamples,
          brierBefore: report.brierBefore.toFixed(4),
          brierAfter: report.brierAfter?.toFixed(4) ?? null,
          eceBefore: report.eceBefore.toFixed(4),
          eceAfter: report.eceAfter?.toFixed(4) ?? null,
          promoted: report.calibratorType != null,
          verdict:
            report.verdict +
            (testBefore != null && testAfter != null ? ` | untouched-test Brier ${testBefore} → ${testAfter}` : ""),
        })
      );
    }

    // ── ensemble (validation-built, test-evaluated) ──────────────────────
    const valByModel: Record<string, PredRecord[]> = {};
    for (const [key, preds] of Object.entries(result.validationPredictions)) {
      const [model, hs] = key.split("|");
      if (Number(hs) === h) valByModel[model] = preds;
    }
    const spec = buildEnsemble(valByModel, h, td);

    // Evaluate on test: join member outputs per (ticker,date).
    const testByModel: Record<string, Map<string, PredRecord>> = {};
    for (const m of spec.members) {
      const preds = result.testPredictions[`${m.model}|${h}`] ?? [];
      testByModel[m.model] = new Map(preds.map((p) => [`${p.ticker}|${p.date}`, p]));
    }
    const anyMember = spec.members[0]?.model;
    const rows = anyMember ? [...(result.testPredictions[`${anyMember}|${h}`] ?? [])] : [];
    const combined: Array<{ p: number; y: 0 | 1 }> = [];
    let hits = 0;
    for (const r of rows) {
      const key2 = `${r.ticker}|${r.date}`;
      const outputs: Record<string, ModelOutput | undefined> = {};
      for (const m of spec.members) outputs[m.model] = testByModel[m.model].get(key2)?.output;
      const o = combineOutputs(spec, outputs, r.date);
      if (o?.rawDirectionProbability != null) {
        combined.push({ p: o.rawDirectionProbability, y: flat(r.target) });
        if (o.rawDirectionProbability > 0.5 === r.target > 0) hits++;
      }
    }
    ensembleRows.push({
      horizonDays: h,
      members: spec.members,
      excluded: spec.excluded,
      testBrier: brierOf(combined),
      testBrierSkill: combined.length ? round4((0.25 - (brierOf(combined) as number)) / 0.25) : null,
      testHitRatePct: combined.length ? round4((hits / combined.length) * 100) : null,
      testSamples: combined.length,
    });
  }

  const runRepo = AppDataSource.getRepository(ExperimentRun);
  const run = await runRepo.save(
    runRepo.create({
      name: "calibration-ensemble-study",
      kind: "challenger",
      modelVersion: "multi",
      config: { withPython: !!external, calibrators: ["platt", "isotonic", "beta"], discipline: "fit on early-val, select on late-val, report untouched-test" },
      splits: { counts: result.splitCounts, skipped: result.skipped },
      datasetManifest: { tickers: result.tickers, source: "stock_history adjusted — OFFLINE RESEARCH" },
      datasetHash: createHash("sha256").update(JSON.stringify(result.splitCounts)).digest("hex"),
      metrics: { calibration: calibrationRows, ensemble: ensembleRows },
      baselines: { note: "raw (uncalibrated) probabilities are the calibration baseline; constant-50 the ensemble baseline" },
      segmentsUsed: ["validation(fit)", "validation(select)", "test(report)"],
      usedFinalTest: true,
      status: "completed",
      startedAt: started,
      finishedAt: new Date(),
    })
  );

  console.log(`\nExperimentRun ${run.id} persisted.`);
  console.log("\n== calibration verdicts ==");
  for (const c of calibrationRows) {
    console.log(
      `${String(c.model).padEnd(24)} ${c.horizonDays}d ${String(c.calibratorType ?? "NONE").padEnd(9)} ` +
        `val ${c.brierBefore}→${c.brierAfter ?? "—"} | test ${c.testBrierBefore ?? "—"}→${c.testBrierAfter ?? "—"} | ${String(c.verdict).slice(0, 90)}`
    );
  }
  console.log("\n== ensemble (validation-built, test-evaluated) ==");
  for (const e of ensembleRows) {
    console.log(
      `${e.horizonDays}d members=[${(e.members as Array<{ model: string; weight: number }>).map((m) => `${m.model}:${m.weight}`).join(", ")}] ` +
        `test brier ${e.testBrier} (skill ${e.testBrierSkill}) hit ${e.testHitRatePct}% n=${e.testSamples}`
    );
    for (const x of e.excluded as Array<{ model: string; reason: string }>) console.log(`   excluded ${x.model}: ${x.reason}`);
  }
  await AppDataSource.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
