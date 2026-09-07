/**
 * Experiment runner (risk-spec Rule 4; remediation plan S4).
 *
 * Evaluates the CHAMPION (quant-v1 directionProb, logged BEFORE outcomes) and
 * the required naive baselines on VERIFIED live PredictionLog rows — genuine
 * out-of-sample data: every prediction was persisted by the morning cron
 * before its outcome existed. Baselines are fitted on a chronological TRAIN
 * prefix of dates only; everything is evaluated on the disjoint later EVAL
 * segment (no random splits, spec Rule 5).
 *
 * Results persist as append-only ExperimentRun rows (the registry every
 * promotion decision must cite). Nothing here changes production behavior —
 * it MEASURES it.
 */

import { createHash } from "crypto";
import { AppDataSource } from "../../config/database";
import { ExperimentRun } from "../../entities";
import { directionBaselines, lastPriceErrors } from "./baselines";
import { dateBlockBootstrap } from "./splits";
import { mulberry32 } from "../quant/montecarlo";
import { effectiveSamples } from "../decision/policy";

export const EXPERIMENT_RUNNER_VERSION = "live-baseline-eval-v1";
const CHAMPION_MODEL_VERSION = "quant-v1";
const TRAIN_FRACTION = 0.6;
const HORIZON_TD: Record<number, number> = { 1: 1, 3: 2, 7: 5, 15: 10, 30: 21 };

interface VerifiedRow {
  ticker: string;
  prediction_date: string;
  horizon_days: number;
  predicted_probability: string; // directionProb at logging time
  expected_return: string; // predicted %
  actual_return: string; // realized %
}

const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
const round2 = (x: number): number => Math.round(x * 100) / 100;

function brier(probs: number[], outcomes: Array<0 | 1>): number {
  let s = 0;
  for (let i = 0; i < probs.length; i++) s += (probs[i] - outcomes[i]) ** 2;
  return s / probs.length;
}

function logLoss(probs: number[], outcomes: Array<0 | 1>): number {
  let s = 0;
  for (let i = 0; i < probs.length; i++) {
    const p = Math.min(1 - 1e-6, Math.max(1e-6, probs[i]));
    s += outcomes[i] === 1 ? -Math.log(p) : -Math.log(1 - p);
  }
  return s / probs.length;
}

export interface HorizonEvaluation {
  horizonDays: number;
  trainRows: number;
  evalRows: number;
  evalEffectiveSamples: number;
  champion: {
    brier: number;
    brierSkillVsConstant50: number; // (0.25 − brier) / 0.25
    logLoss: number;
    directionHitRatePct: number;
    /** Date-block bootstrap 80% CI on the hit rate (overlap-aware). */
    hitRateCi80: [number, number];
    maePct: number; // |predicted − actual| return error
  };
  baselines: {
    constant50Brier: number; // definitionally 0.25
    trainBaseRateP: number;
    baseRateBrier: number;
    alwaysUpHitRatePct: number;
    majorityHitRatePct: number;
    zeroReturnMaePct: number; // "no-change" forecast error — the bar for MAE
  };
  verdict: string;
}

/**
 * Run the live-baseline evaluation and persist an ExperimentRun.
 * Returns the saved run (with metrics) or a completed-with-error run row.
 */
export async function runLiveBaselineExperiment(): Promise<ExperimentRun> {
  const startedAt = new Date();
  const repo = AppDataSource.getRepository(ExperimentRun);

  const rows: VerifiedRow[] = await AppDataSource.query(
    `SELECT ticker, prediction_date::text AS prediction_date, horizon_days,
            predicted_probability::text AS predicted_probability,
            expected_return::text AS expected_return,
            actual_return::text AS actual_return
       FROM prediction_logs
      WHERE model_version = $1 AND actual_return IS NOT NULL AND horizon_days IS NOT NULL
      ORDER BY prediction_date ASC, ticker ASC`,
    [CHAMPION_MODEL_VERSION]
  );

  const datasetHash = createHash("sha256")
    .update(rows.map((r) => `${r.ticker}|${r.prediction_date}|${r.horizon_days}|${r.actual_return}`).join("\n"))
    .digest("hex");

  const byHorizon = new Map<number, VerifiedRow[]>();
  for (const r of rows) {
    const list = byHorizon.get(r.horizon_days) ?? [];
    list.push(r);
    byHorizon.set(r.horizon_days, list);
  }

  const evaluations: HorizonEvaluation[] = [];
  const skipped: string[] = [];

  for (const [h, list] of [...byHorizon.entries()].sort((a, b) => a[0] - b[0])) {
    // Date-grouped chronological split (never random, never row-level).
    const dates = [...new Set(list.map((r) => r.prediction_date))].sort();
    if (dates.length < 10) {
      skipped.push(`${h}d: only ${dates.length} distinct dates — too few for a train/eval split`);
      continue;
    }
    const cut = dates[Math.floor(dates.length * TRAIN_FRACTION) - 1];
    const train = list.filter((r) => r.prediction_date <= cut);
    const evalRows = list.filter((r) => r.prediction_date > cut);
    if (train.length < 20 || evalRows.length < 20) {
      skipped.push(`${h}d: train=${train.length}/eval=${evalRows.length} rows — under the 20-row floor`);
      continue;
    }

    // Flat-day rule (stated): actual > 0 counts as UP, matching the live
    // verifier's Brier convention (backtest uses >; live uses ≥ for direction
    // labels — a documented mismatch in the audit; here we use > consistently).
    const outcome = (r: VerifiedRow): 0 | 1 => (Number(r.actual_return) > 0 ? 1 : 0);
    const trainUps = train.map(outcome);
    const evalUps = evalRows.map(outcome);
    const probs = evalRows.map((r) => Number(r.predicted_probability));
    const championHits = evalRows.filter(
      (r) => (Number(r.predicted_probability) > 0.5) === (Number(r.actual_return) > 0)
    ).length;
    const hitRatePct = (championHits / evalRows.length) * 100;

    const b = directionBaselines(trainUps, evalUps);
    const championBrier = brier(probs, evalUps);

    // Overlap-aware uncertainty: bootstrap DATES in contiguous blocks.
    const evalDates = [...new Set(evalRows.map((r) => r.prediction_date))].sort();
    const byDate = new Map<string, VerifiedRow[]>();
    for (const r of evalRows) {
      const l = byDate.get(r.prediction_date) ?? [];
      l.push(r);
      byDate.set(r.prediction_date, l);
    }
    const blockLen = Math.min(Math.max(1, HORIZON_TD[h] ?? 1), Math.max(1, evalDates.length - 1));
    const draws = dateBlockBootstrap(evalDates, blockLen, 500, mulberry32(20260907));
    const hitRates = draws
      .map((sample) => {
        let hits = 0;
        let n = 0;
        for (const d of sample) {
          for (const r of byDate.get(d) ?? []) {
            n++;
            if ((Number(r.predicted_probability) > 0.5) === (Number(r.actual_return) > 0)) hits++;
          }
        }
        return n > 0 ? (hits / n) * 100 : NaN;
      })
      .filter((x) => Number.isFinite(x))
      .sort((a, b2) => a - b2);
    const ci80: [number, number] = [
      round2(hitRates[Math.floor(hitRates.length * 0.1)] ?? NaN),
      round2(hitRates[Math.floor(hitRates.length * 0.9)] ?? NaN),
    ];

    const championMae =
      evalRows.reduce((s, r) => s + Math.abs(Number(r.expected_return) - Number(r.actual_return)), 0) /
      evalRows.length;
    const zeroMae = lastPriceErrors(
      evalRows.map((r) => ({ anchor: 100, actual: 100 * (1 + Number(r.actual_return) / 100) }))
    ).maePct;

    const brierSkill = (0.25 - championBrier) / 0.25;
    const effN = effectiveSamples(evalRows.length, Math.max(1, HORIZON_TD[h] ?? 1));

    evaluations.push({
      horizonDays: h,
      trainRows: train.length,
      evalRows: evalRows.length,
      evalEffectiveSamples: effN,
      champion: {
        brier: round4(championBrier),
        brierSkillVsConstant50: round4(brierSkill),
        logLoss: round4(logLoss(probs, evalUps)),
        directionHitRatePct: round2(hitRatePct),
        hitRateCi80: ci80,
        maePct: round4(championMae),
      },
      baselines: {
        constant50Brier: 0.25,
        trainBaseRateP: b.trainBaseRateP,
        baseRateBrier: b.baseRateBrier,
        alwaysUpHitRatePct: b.alwaysUpHitRatePct,
        majorityHitRatePct: b.majorityHitRatePct,
        zeroReturnMaePct: round4(zeroMae),
      },
      verdict:
        brierSkill > 0 && championBrier < b.baseRateBrier && championMae < zeroMae
          ? "champion beats constant-50, base-rate and zero-return on this segment — still requires effective-sample and stability review before any promotion"
          : "NO VALIDATED EDGE: the champion does not beat the naive baselines out of sample",
    });
  }

  const run = repo.create({
    name: "live-baseline-eval",
    kind: "champion-eval",
    modelVersion: CHAMPION_MODEL_VERSION,
    config: {
      runner: EXPERIMENT_RUNNER_VERSION,
      trainFraction: TRAIN_FRACTION,
      flatDayRule: "actual > 0 counts as UP",
      bootstrapSeed: 20260907,
      bootstrapDraws: 500,
    },
    splits: {
      method: "date-grouped chronological (no random splits)",
      perHorizon: evaluations.map((e) => ({ horizonDays: e.horizonDays, trainRows: e.trainRows, evalRows: e.evalRows })),
      skipped,
    },
    datasetManifest: {
      source: "prediction_logs (verified live rows — logged before outcomes)",
      totalRows: rows.length,
      firstDate: rows[0]?.prediction_date ?? null,
      lastDate: rows[rows.length - 1]?.prediction_date ?? null,
    },
    datasetHash,
    metrics: { evaluations },
    baselines: {
      note: "constant-50, train-only base rate, always-up/majority direction, zero-return MAE (spec Rule 4)",
    },
    segmentsUsed: ["live-verified-train", "live-verified-eval"],
    usedFinalTest: false,
    status: "completed",
    startedAt,
    finishedAt: new Date(),
  });
  return repo.save(run);
}

/** Latest experiment runs, newest first (read-only). */
export async function latestExperiments(limit = 5): Promise<ExperimentRun[]> {
  return AppDataSource.getRepository(ExperimentRun).find({
    order: { createdAt: "DESC" },
    take: Math.min(20, Math.max(1, limit)),
  });
}
