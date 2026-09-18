/**
 * EvidenceService — the transparency ledger behind the Evidence tab.
 *
 * Every other read surface in this system answers "what does the model think
 * now?". This one answers the three questions that actually establish whether
 * the system deserves trust:
 *
 *   1. What did it predict, and what happened?          (prediction_logs)
 *   2. What did it get WRONG?                           (graded misses, listed first)
 *   3. What changed as a result?                        (calibrators + model_governance
 *                                                        + experiment_runs)
 *
 * Design rules, which are the whole point of the tab:
 *
 *  - NOTHING IS HIDDEN. Wrong predictions are returned before correct ones and
 *    are never filtered out. A miss is the product here, not an embarrassment.
 *  - UNGRADED IS ITS OWN STATE, never silently dropped and never counted as a
 *    success. A prediction whose horizon has not matured is reported as
 *    PENDING with its target date, so the denominator is always visible.
 *  - NO IMPUTATION. Every field is read straight from the append-only ledgers.
 *    Where a ledger has no value (brier_after on a rejected calibrator, an
 *    experiment with null metrics) the API returns null rather than a guess.
 *  - SMALL-SAMPLE HONESTY. Accuracy over a handful of graded rows is noise, so
 *    the summary carries `sampleWarning` whenever the graded count is below
 *    the point where a hit rate means anything.
 *
 * Read-only: this service issues SELECTs and nothing else.
 */

import { AppDataSource } from "../../config/database";

export const EVIDENCE_VERSION = "evidence-ledger-v1";

/**
 * Below this many graded outcomes, a hit rate is indistinguishable from a coin
 * flip and must not be presented as a track record. Chosen to match
 * ModelHealthService.HEALTH_THRESHOLDS.minEffectiveResolved so the two
 * surfaces cannot disagree about when evidence begins.
 */
export const MIN_GRADED_FOR_RATE = 10;

export type PredictionGrade = "WRONG" | "CORRECT" | "PENDING";

export interface PredictionLedgerRow {
  id: string;
  ticker: string;
  predictionDate: string;
  targetDate: string | null;
  horizonDays: number | null;
  modelVersion: string;
  predictedDirection: string;
  predictedProbability: number;
  confidence: number | null;
  expectedReturnPct: number | null;
  actualReturnPct: number | null;
  actualDirection: string | null;
  grade: PredictionGrade;
  /** Signed miss in percentage points: actual − expected. Null while PENDING. */
  errorPct: number | null;
  outcomeDate: string | null;
  recommendationGiven: string | null;
}

export interface PredictionLedger {
  rows: PredictionLedgerRow[];
  total: number;
  graded: number;
  wrong: number;
  correct: number;
  pending: number;
  /** Null unless there are enough graded outcomes for a rate to mean anything. */
  hitRatePct: number | null;
  /** Mean |actual − expected| over graded rows, in percentage points. */
  meanAbsErrorPct: number | null;
  sampleWarning: string | null;
}

export interface CalibratorRow {
  id: string;
  modelName: string;
  horizonDays: number;
  calibratorType: string | null;
  version: string | null;
  effectiveSamples: number;
  brierBefore: number;
  brierAfter: number | null;
  eceBefore: number;
  eceAfter: number | null;
  /** brierBefore − brierAfter: positive means the calibration improved things. */
  brierImprovement: number | null;
  promoted: boolean;
  verdict: string;
  trainingStart: string | null;
  trainingEnd: string | null;
  createdAt: string;
}

export interface GovernanceRow {
  modelKey: string;
  scope: string;
  state: string;
  reasons: string[];
  evidenceRunId: string | null;
  updatedAt: string;
}

export interface ExperimentRow {
  id: string;
  name: string;
  kind: string;
  modelVersion: string;
  status: string;
  usedFinalTest: boolean;
  metrics: Record<string, unknown> | null;
  baselines: Record<string, unknown> | null;
  notes: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface EvidenceSummary {
  version: string;
  asOf: string;
  predictionsTotal: number;
  predictionsGraded: number;
  predictionsWrong: number;
  predictionsPending: number;
  calibratorsTrained: number;
  calibratorsPromoted: number;
  calibratorsRejected: number;
  governedModels: number;
  modelsNotLive: number;
  experimentsRun: number;
  /** The single most important honest statement about the current evidence. */
  headline: string;
}

export interface EvidenceBundle {
  summary: EvidenceSummary;
  predictions: PredictionLedger;
  calibrators: CalibratorRow[];
  governance: GovernanceRow[];
  experiments: ExperimentRow[];
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function day(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function round(v: number | null, dp: number): number | null {
  if (v === null) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

export class EvidenceService {
  /**
   * The raw prediction ledger, WRONG first.
   *
   * The ordering is deliberate and is the honesty property of this endpoint: a
   * reader who looks only at the top of the list sees the failures, not a
   * flattering sample. Within each grade, newest first.
   */
  async predictions(limit = 200): Promise<PredictionLedger> {
    const capped = Math.max(1, Math.min(1000, Math.floor(limit)));

    const rows: Record<string, unknown>[] = await AppDataSource.query(
      `SELECT id, ticker, prediction_date, target_date, horizon_days, model_version,
              predicted_direction, predicted_probability, confidence,
              expected_return, actual_return, actual_direction, prediction_correct,
              outcome_date, recommendation_given
         FROM prediction_logs
        ORDER BY
          CASE
            WHEN prediction_correct IS FALSE THEN 0   -- wrong calls surface first
            WHEN prediction_correct IS TRUE  THEN 1
            ELSE 2                                     -- ungraded last, never dropped
          END,
          prediction_date DESC, created_at DESC
        LIMIT $1`,
      [capped]
    );

    // Counts come from the FULL table, not the returned page: a limit must
    // never shrink the denominator a reader judges the system by.
    const [totals]: { total: string; wrong: string; correct: string; pending: string }[] =
      await AppDataSource.query(
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE prediction_correct IS FALSE) AS wrong,
                COUNT(*) FILTER (WHERE prediction_correct IS TRUE)  AS correct,
                COUNT(*) FILTER (WHERE prediction_correct IS NULL)  AS pending
           FROM prediction_logs`
      );

    const mapped: PredictionLedgerRow[] = rows.map((r) => {
      const correct = r.prediction_correct as boolean | null;
      const expected = num(r.expected_return);
      const actual = num(r.actual_return);
      return {
        id: String(r.id),
        ticker: String(r.ticker),
        predictionDate: day(r.prediction_date)!,
        targetDate: day(r.target_date),
        horizonDays: num(r.horizon_days),
        modelVersion: String(r.model_version),
        predictedDirection: String(r.predicted_direction),
        predictedProbability: num(r.predicted_probability) ?? 0,
        confidence: num(r.confidence),
        expectedReturnPct: expected,
        actualReturnPct: actual,
        actualDirection: r.actual_direction ? String(r.actual_direction) : null,
        grade: correct === null || correct === undefined ? "PENDING" : correct ? "CORRECT" : "WRONG",
        errorPct: expected !== null && actual !== null ? round(actual - expected, 4) : null,
        outcomeDate: day(r.outcome_date),
        recommendationGiven: r.recommendation_given ? String(r.recommendation_given) : null,
      };
    });

    const total = Number(totals?.total ?? 0);
    const wrong = Number(totals?.wrong ?? 0);
    const correct = Number(totals?.correct ?? 0);
    const pending = Number(totals?.pending ?? 0);
    const graded = wrong + correct;

    const gradedErrs = mapped.filter((m) => m.errorPct !== null).map((m) => Math.abs(m.errorPct as number));
    const meanAbsErrorPct = gradedErrs.length
      ? round(gradedErrs.reduce((a, b) => a + b, 0) / gradedErrs.length, 3)
      : null;

    // A hit rate over a handful of rows is noise. Refuse to compute one rather
    // than publish a number that invites over-reading.
    const enough = graded >= MIN_GRADED_FOR_RATE;

    return {
      rows: mapped,
      total,
      graded,
      wrong,
      correct,
      pending,
      hitRatePct: enough ? round((correct / graded) * 100, 1) : null,
      meanAbsErrorPct,
      sampleWarning: enough
        ? null
        : `Only ${graded} of ${total} predictions have matured. A hit rate needs at least ` +
          `${MIN_GRADED_FOR_RATE} graded outcomes before it means anything, so none is shown. ` +
          `The individual results below are real; the aggregate is not yet evidence.`,
    };
  }

  /**
   * Calibrator training attempts — promoted AND rejected.
   *
   * Rejections are the more informative half: they are the record of the
   * system declining to ship a fit it could not justify on hold-out data.
   */
  async calibrators(limit = 200): Promise<CalibratorRow[]> {
    const capped = Math.max(1, Math.min(1000, Math.floor(limit)));
    const rows: Record<string, unknown>[] = await AppDataSource.query(
      `SELECT id, model_name, horizon_days, calibrator_type, version, effective_samples,
              brier_before, brier_after, ece_before, ece_after, promoted, verdict,
              training_start, training_end, created_at
         FROM calibrators
        ORDER BY created_at DESC, model_name ASC
        LIMIT $1`,
      [capped]
    );

    return rows.map((r) => {
      const before = num(r.brier_before) ?? 0;
      const after = num(r.brier_after);
      return {
        id: String(r.id),
        modelName: String(r.model_name),
        horizonDays: Number(r.horizon_days),
        calibratorType: r.calibrator_type ? String(r.calibrator_type) : null,
        version: r.version ? String(r.version) : null,
        effectiveSamples: Number(r.effective_samples),
        brierBefore: before,
        brierAfter: after,
        eceBefore: num(r.ece_before) ?? 0,
        eceAfter: num(r.ece_after),
        brierImprovement: after !== null ? round(before - after, 4) : null,
        promoted: !!r.promoted,
        verdict: String(r.verdict ?? ""),
        trainingStart: day(r.training_start),
        trainingEnd: day(r.training_end),
        createdAt: iso(r.created_at),
      };
    });
  }

  /**
   * Current governance state per model, with the reasons that put it there.
   *
   * `reasons` is the most valuable text in the whole tab — it is where a
   * demotion says, in prose, what evidence failed.
   */
  async governance(): Promise<GovernanceRow[]> {
    const rows: Record<string, unknown>[] = await AppDataSource.query(
      `SELECT model_key, scope, state, reasons, evidence_run_id, updated_at
         FROM model_governance
        ORDER BY
          CASE state
            WHEN 'RETIRED' THEN 0
            WHEN 'SHADOW'  THEN 1
            WHEN 'CANDIDATE' THEN 2
            ELSE 3
          END,
          updated_at DESC`
    );

    return rows.map((r) => ({
      modelKey: String(r.model_key),
      scope: String(r.scope),
      state: String(r.state),
      reasons: Array.isArray(r.reasons) ? (r.reasons as unknown[]).map((x) => String(x)) : [],
      evidenceRunId: r.evidence_run_id ? String(r.evidence_run_id) : null,
      updatedAt: iso(r.updated_at),
    }));
  }

  /** Experiment runs, newest first, including failures and their error text. */
  async experiments(limit = 50): Promise<ExperimentRow[]> {
    const capped = Math.max(1, Math.min(200, Math.floor(limit)));
    const rows: Record<string, unknown>[] = await AppDataSource.query(
      `SELECT id, name, kind, model_version, status, used_final_test,
              metrics, baselines, notes, error, started_at, finished_at
         FROM experiment_runs
        ORDER BY started_at DESC
        LIMIT $1`,
      [capped]
    );

    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      kind: String(r.kind),
      modelVersion: String(r.model_version),
      status: String(r.status),
      usedFinalTest: !!r.used_final_test,
      metrics: (r.metrics as Record<string, unknown> | null) ?? null,
      baselines: (r.baselines as Record<string, unknown> | null) ?? null,
      notes: r.notes ? String(r.notes) : null,
      error: r.error ? String(r.error) : null,
      startedAt: iso(r.started_at),
      finishedAt: r.finished_at ? iso(r.finished_at) : null,
    }));
  }

  /** Everything the tab needs, in one round trip. */
  async bundle(predictionLimit = 200): Promise<EvidenceBundle> {
    const [predictions, calibrators, governance, experiments] = await Promise.all([
      this.predictions(predictionLimit),
      this.calibrators(),
      this.governance(),
      this.experiments(),
    ]);

    const promoted = calibrators.filter((c) => c.promoted).length;
    const notLive = governance.filter((g) => g.state !== "LIVE" && g.state !== "PRODUCTION").length;

    return {
      summary: {
        version: EVIDENCE_VERSION,
        asOf: new Date().toISOString(),
        predictionsTotal: predictions.total,
        predictionsGraded: predictions.graded,
        predictionsWrong: predictions.wrong,
        predictionsPending: predictions.pending,
        calibratorsTrained: calibrators.length,
        calibratorsPromoted: promoted,
        calibratorsRejected: calibrators.length - promoted,
        governedModels: governance.length,
        modelsNotLive: notLive,
        experimentsRun: experiments.length,
        headline: this.headline(predictions, calibrators.length - promoted, notLive),
      },
      predictions,
      calibrators,
      governance,
      experiments,
    };
  }

  /**
   * One sentence, chosen to be the LEAST flattering true statement available.
   *
   * The failure mode this guards against is a summary line that technically
   * holds while leaving a reader more confident than the evidence warrants.
   */
  private headline(p: PredictionLedger, rejected: number, notLive: number): string {
    if (p.graded === 0) {
      return `No prediction has matured yet: ${p.total} logged, ${p.pending} still awaiting their target date. There is no track record to report.`;
    }
    if (p.wrong === p.graded) {
      return `Every one of the ${p.graded} matured prediction${p.graded === 1 ? "" : "s"} was WRONG. ${p.pending} more are still pending. Nothing here supports acting on a directional call.`;
    }
    if (p.hitRatePct === null) {
      return `${p.wrong} of ${p.graded} matured predictions were wrong — too few outcomes to compute a meaningful hit rate. ${rejected} calibrator fit${rejected === 1 ? "" : "s"} were rejected and ${notLive} model${notLive === 1 ? " is" : "s are"} held below LIVE on the evidence.`;
    }
    return `${p.wrong} of ${p.graded} matured predictions were wrong (${p.hitRatePct}% hit rate). ${rejected} calibrator fit${rejected === 1 ? "" : "s"} rejected; ${notLive} model${notLive === 1 ? "" : "s"} held below LIVE.`;
  }
}

export const evidenceService = new EvidenceService();
