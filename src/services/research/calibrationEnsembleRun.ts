/**
 * Calibration + ensemble refresh (Phases 7+8) — the CONTINUOUS-LEARNING loop.
 *
 * This is the honest version of "learns from its wrong predictions": it does
 * NOT retrain the deterministic quant engine's weights (engine.ts's 8-signal
 * vector stays fixed code — reweighting it online would reopen exactly the
 * in-sample-overfitting problem docs/system-trust-review.md's batch 2 fixed
 * for the short-term setup study). What it DOES do, on a schedule, as new
 * independent samples accumulate from resolved predictions:
 *
 *  1. Re-run the purged/embargoed walk-forward harness (research/harness.ts)
 *     over the latest bars.
 *  2. Per model×horizon, fit Platt/isotonic/beta calibrators on an EARLY
 *     slice of validation predictions, SELECT the best on a LATER held-out
 *     validation slice, and report the final effect on the UNTOUCHED test
 *     segment (research/calibration.ts's selectCalibrator — this discipline
 *     already existed and is unchanged here).
 *  3. Build the global ensemble from validation evidence and evaluate it on
 *     test (research/ensemble.ts — unchanged).
 *  4. Persist an ExperimentRun (append-only) and CalibratorRecord rows
 *     (including REJECTIONS — a calibrator that fails to beat the raw
 *     probability out-of-sample is recorded as rejected, not silently
 *     dropped) via research/calibratorRegistry's promotion contract: only a
 *     calibrator that beats baselines on truly held-out data is ever read by
 *     the product (calibratorRegistry.ts's getLatestPromotedCalibrator).
 *
 * Extracted from scripts/calibrationRun.ts (the original offline-only
 * script, kept as a thin CLI wrapper around this function) so the SAME logic
 * can be scheduled by CronService — previously this only ever ran when a
 * developer invoked the script by hand, so newly-resolved predictions never
 * fed back into anything without a person remembering to run it.
 *
 * PURE with respect to what it changes: this function only ever WRITES new
 * append-only rows (ExperimentRun, CalibratorRecord). It never mutates
 * PredictionLog, ModelPerformance, or the deterministic engine's constants.
 * A calibrator only takes effect once selectCalibrator has verified it beats
 * baselines on data it was never fit or selected on — CronService merely
 * automates WHEN that check runs, not what it is allowed to conclude.
 */

import { createHash } from "crypto";
import { AppDataSource } from "../../config/database";
import { CalibratorRecord, ExperimentRun } from "../../entities";
import { NSE_UNIVERSE } from "../../data/nseUniverse";
import { runWalkForward, H_TD, PredRecord } from "./harness";
import { tsBaselineModels, tsStatisticalModels, ModelOutput } from "./models";
import { pythonWorkerAvailable, pythonWorkerModels } from "./pythonProvider";
import { applyCalibrator, CalPoint, selectCalibrator } from "./calibration";
import { buildEnsemble, combineOutputs } from "./ensemble";
import { round4 } from "./metrics";

const flat = (r: number): 0 | 1 => (r > 0 ? 1 : 0);

function brierOf(preds: Array<{ p: number; y: 0 | 1 }>): number | null {
  if (preds.length === 0) return null;
  return round4(preds.reduce((a, x) => a + (x.p - x.y) ** 2, 0) / preds.length);
}

export interface CalibrationEnsembleRunOptions {
  /** Universe subset to run the harness over. Defaults to the first 40 NSE_UNIVERSE tickers (same default as the offline script). */
  tickers?: string[];
  horizons?: number[];
  withPython?: boolean;
  log?: (msg: string) => void;
}

export interface CalibrationEnsembleRunResult {
  experimentRunId: string;
  calibratorsFit: number;
  calibratorsPromoted: number;
  calibrationVerdicts: string[];
  ensembleVerdicts: string[];
  skipped: string[];
}

/**
 * Runs the full calibration + ensemble refresh and persists results.
 * Idempotent in the sense that re-running it produces a NEW ExperimentRun
 * and new CalibratorRecord rows (both append-only, per the codebase's
 * ground rules) rather than mutating prior ones — repeated runs are safe,
 * and the promotion registry (calibratorRegistry.ts) always reads the
 * LATEST promoted row per model×horizon, so a later run's verdict naturally
 * supersedes an earlier one without deleting the history.
 */
export async function runCalibrationEnsembleRefresh(
  opts: CalibrationEnsembleRunOptions = {}
): Promise<CalibrationEnsembleRunResult> {
  const log = opts.log ?? (() => undefined);
  const started = new Date();

  let external: ReturnType<typeof pythonWorkerModels> | undefined;
  if (opts.withPython && (await pythonWorkerAvailable())) external = pythonWorkerModels();

  const result = await runWalkForward({
    tickers: opts.tickers ?? NSE_UNIVERSE.slice(0, 40).map((u) => u.ticker),
    horizons: opts.horizons ?? [1, 7, 30],
    models: [...tsBaselineModels(), ...tsStatisticalModels()],
    externalModels: external,
    includeChampion: true,
    log,
  });

  const calibrationRows: Array<Record<string, unknown>> = [];
  const ensembleRows: Array<Record<string, unknown>> = [];
  const repo = AppDataSource.getRepository(CalibratorRecord);
  let calibratorsFit = 0;
  let calibratorsPromoted = 0;
  const calibrationVerdicts: string[] = [];
  const ensembleVerdicts: string[] = [];

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

      calibratorsFit++;
      const report = selectCalibrator(points, td);
      if (report.calibratorType != null) calibratorsPromoted++;

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

      const verdict =
        report.verdict + (testBefore != null && testAfter != null ? ` | untouched-test Brier ${testBefore} → ${testAfter}` : "");
      calibrationRows.push({ model, horizonDays: h, ...report, calibrator: undefined, testBrierBefore: testBefore, testBrierAfter: testAfter });
      calibrationVerdicts.push(`${model} ${h}d: ${verdict}`);

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
          verdict,
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
    const testBrier = brierOf(combined);
    ensembleRows.push({
      horizonDays: h,
      members: spec.members,
      excluded: spec.excluded,
      testBrier,
      testBrierSkill: combined.length && testBrier != null ? round4((0.25 - testBrier) / 0.25) : null,
      testHitRatePct: combined.length ? round4((hits / combined.length) * 100) : null,
      testSamples: combined.length,
    });
    ensembleVerdicts.push(
      `${h}d members=[${spec.members.map((m) => `${m.model}:${m.weight}`).join(", ")}] test brier ${testBrier} n=${combined.length}`
    );
  }

  const runRepo = AppDataSource.getRepository(ExperimentRun);
  const run = await runRepo.save(
    runRepo.create({
      name: "calibration-ensemble-study",
      kind: "challenger",
      modelVersion: "multi",
      config: {
        withPython: !!external,
        calibrators: ["platt", "isotonic", "beta"],
        discipline: "fit on early-val, select on late-val, report untouched-test",
      },
      splits: { counts: result.splitCounts, skipped: result.skipped },
      datasetManifest: { tickers: result.tickers, source: "stock_history adjusted — scheduled continuous-learning refresh" },
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

  return {
    experimentRunId: run.id,
    calibratorsFit,
    calibratorsPromoted,
    calibrationVerdicts,
    ensembleVerdicts,
    skipped: result.skipped,
  };
}
