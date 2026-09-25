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
import { buildSelectivityReport, SelectivityReport } from "./selectivity";
import { decisionOutcomeService, LaneCReport } from "./DecisionOutcomeService";

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

/** Optional ledger filters. Filtering changes which ROWS are returned — never
 *  the totals, which always come from the full table so a filtered view can't
 *  shrink the denominator a reader judges the system by. */
export interface PredictionFilter {
  grade?: "WRONG" | "CORRECT" | "PENDING";
  ticker?: string;
  /** Filter by the recommendation the system gave at issuance. NOT_AVOID keeps
   *  everything except AVOID rows (the "hide what it told me to skip" view). */
  recommendation?: "BUY" | "HOLD" | "AVOID" | "NOT_AVOID";
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
  /** Echo of the applied filter + how many rows matched it (full-table count). */
  filter: PredictionFilter | null;
  filteredCount: number | null;
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

/**
 * Whether the learning loop is actually RUNNING.
 *
 * Every table in this file can be empty for two very different reasons: the
 * system is new, or the jobs that fill them silently stopped months ago.
 * Those look identical on every other screen, so the pipeline's own heartbeat
 * is reported explicitly rather than inferred from row counts.
 */
export interface PipelineJob {
  jobName: string;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  runs: number;
  /** Correct no-ops on a not-my-day check (see CronService istWeekday()). */
  skipped: number;
  failures: number;
}

export interface PipelineHealth {
  /** True when no scheduled job has EVER recorded an execution. */
  neverRun: boolean;
  jobs: PipelineJob[];
  note: string;
}

export interface EvidenceBundle {
  summary: EvidenceSummary;
  pipeline: PipelineHealth;
  predictions: PredictionLedger;
  /** Accuracy-vs-abstention trade measured on the graded ledger. */
  selectivity: SelectivityReport;
  calibrators: CalibratorRow[];
  governance: GovernanceRow[];
  experiments: ExperimentRow[];
  /** Lane C — the TradeGate's OWN graded track record (decision_outcome_ledger).
   *  Everything above grades the legacy quant engine; this grades the gate. */
  laneC: LaneCReport;
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
  async predictions(limit = 200, filter?: PredictionFilter): Promise<PredictionLedger> {
    const capped = Math.max(1, Math.min(1000, Math.floor(limit)));

    // Filters are parameterized, never interpolated. grade maps onto the
    // tri-state prediction_correct column; ticker matches with or without the
    // exchange suffix so "HUDCO" finds "HUDCO.NS".
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.grade === "WRONG") where.push("prediction_correct IS FALSE");
    else if (filter?.grade === "CORRECT") where.push("prediction_correct IS TRUE");
    else if (filter?.grade === "PENDING") where.push("prediction_correct IS NULL");
    if (filter?.ticker && filter.ticker.trim()) {
      params.push(`${filter.ticker.trim().toUpperCase().replace(/\.NS$/, "")}%`);
      where.push(`UPPER(ticker) LIKE $${params.length}`);
    }
    if (filter?.recommendation === "NOT_AVOID") {
      where.push(`recommendation_given IS DISTINCT FROM 'AVOID'`);
    } else if (filter?.recommendation) {
      params.push(filter.recommendation);
      where.push(`recommendation_given = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    params.push(capped);
    const rows: Record<string, unknown>[] = await AppDataSource.query(
      `SELECT id, ticker, prediction_date, target_date, horizon_days, model_version,
              predicted_direction, predicted_probability, confidence,
              expected_return, actual_return, actual_direction, prediction_correct,
              outcome_date, recommendation_given
         FROM prediction_logs
        ${whereSql}
        ORDER BY
          CASE
            WHEN prediction_correct IS FALSE THEN 0   -- wrong calls surface first
            WHEN prediction_correct IS TRUE  THEN 1
            ELSE 2                                     -- ungraded last, never dropped
          END,
          prediction_date DESC, created_at DESC
        LIMIT $${params.length}`,
      params
    );

    // Full-table count of rows matching the filter (page-independent).
    const filteredCount = where.length
      ? Number(
          (
            await AppDataSource.query(
              `SELECT COUNT(*) AS n FROM prediction_logs ${whereSql}`,
              params.slice(0, params.length - 1)
            )
          )[0]?.n ?? 0
        )
      : null;

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
      filter: filter && (filter.grade || filter.ticker || filter.recommendation) ? filter : null,
      filteredCount,
    };
  }

  /**
   * Accuracy-vs-selectivity over the graded ledger: what hit rate the system
   * would have IF it only spoke above each confidence threshold. This is the
   * honest form of "make it more accurate" — abstention is the only lever that
   * raises accuracy without lying, and this measures exactly what it buys.
   */
  async selectivity(): Promise<SelectivityReport> {
    const rows: Array<{ probability: string; correct: boolean; horizon_days: number | null }> =
      await AppDataSource.query(
        `SELECT predicted_probability AS probability, prediction_correct AS correct, horizon_days
           FROM prediction_logs
          WHERE prediction_correct IS NOT NULL AND predicted_probability IS NOT NULL`
      );
    return buildSelectivityReport(
      rows.map((r) => ({ probability: Number(r.probability), correct: r.correct === true, horizonDays: r.horizon_days }))
    );
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

  /**
   * The learning loop's heartbeat, read from cron_execution_logs.
   *
   * `neverRun` is the single most important field on this whole surface: if it
   * is true, every empty table below is empty because nothing has executed —
   * not because the system has honestly found nothing. Those two states are
   * indistinguishable from row counts alone, which is why this is reported
   * separately rather than inferred.
   */
  async pipeline(): Promise<PipelineHealth> {
    const rows: Record<string, unknown>[] = await AppDataSource.query(
      // 'skipped' is a nominally-daily job correctly declining to act on a
      // day that isn't its actual schedule (see CronService's istWeekday()
      // guard on the two weekly jobs) — it must NOT count as a failure, or
      // the banner would show 6 false alarms a week for jobs behaving exactly
      // as designed.
      `SELECT job_name,
              MAX(execution_start) AS last_run_at,
              COUNT(*) AS runs,
              COUNT(*) FILTER (WHERE status = 'skipped') AS skipped,
              COUNT(*) FILTER (WHERE status NOT IN ('success', 'skipped')) AS failures
         FROM cron_execution_logs
        GROUP BY job_name
        ORDER BY MAX(execution_start) DESC`
    );

    const jobs: PipelineJob[] = [];
    for (const r of rows) {
      const [last]: Record<string, unknown>[] = await AppDataSource.query(
        `SELECT status, execution_duration_ms, error_summary
           FROM cron_execution_logs
          WHERE job_name = $1
          ORDER BY execution_start DESC
          LIMIT 1`,
        [r.job_name]
      );
      jobs.push({
        jobName: String(r.job_name),
        lastRunAt: r.last_run_at ? iso(r.last_run_at) : null,
        lastStatus: last?.status ? String(last.status) : null,
        lastDurationMs: num(last?.execution_duration_ms),
        lastError: last?.error_summary ? String(last.error_summary) : null,
        runs: Number(r.runs ?? 0),
        skipped: Number(r.skipped ?? 0),
        failures: Number(r.failures ?? 0),
      });
    }

    const neverRun = jobs.length === 0;
    return {
      neverRun,
      jobs,
      note: neverRun
        ? "No scheduled job has ever recorded an execution. The prediction, grading and calibration tables below are empty because nothing has run — not because the system examined the data and found nothing. Until the daily jobs execute, this system is not learning."
        : "Scheduled jobs write one row per attempt, failures included. A job whose last run failed has stopped contributing to the learning loop even though earlier rows remain.",
    };
  }

  /** Everything the tab needs, in one round trip. */
  async bundle(predictionLimit = 200): Promise<EvidenceBundle> {
    const [predictions, selectivity, calibrators, governance, experiments, pipeline, laneC] = await Promise.all([
      this.predictions(predictionLimit),
      this.selectivity(),
      this.calibrators(),
      this.governance(),
      this.experiments(),
      this.pipeline(),
      decisionOutcomeService.laneCReport(),
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
        headline: this.headline(predictions, calibrators.length - promoted, notLive, pipeline),
      },
      pipeline,
      predictions,
      selectivity,
      calibrators,
      governance,
      experiments,
      laneC,
    };
  }

  /**
   * One sentence, chosen to be the LEAST flattering true statement available.
   *
   * The failure mode this guards against is a summary line that technically
   * holds while leaving a reader more confident than the evidence warrants.
   */
  private headline(p: PredictionLedger, rejected: number, notLive: number, pipeline: PipelineHealth): string {
    // A dead pipeline outranks every other statement: if nothing is running,
    // no reading of the tables below is meaningful.
    if (pipeline.neverRun) {
      return "No scheduled job has ever run, so nothing below is being updated. The system is not currently learning from its mistakes — it is only holding what was written by hand.";
    }
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
