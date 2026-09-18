/**
 * LearningJournalService — pre-registered expectations and the lessons drawn
 * from them.
 *
 * The rest of the system records what happened. This records what we said
 * WOULD happen, before it happened, together with the condition that would
 * prove us wrong. That ordering is the entire value: a lesson written after
 * the outcome is known can always be made to fit, so only a claim registered
 * in advance, with a fixed falsification criterion, can actually train
 * anything over time.
 *
 * Invariants enforced here (and, for the ones that matter most, again in the
 * database — see 1789800000000-CreateLearningJournal):
 *
 *  - An expectation must be falsifiable. A claim with no stated way to be
 *    wrong is refused at registration, not silently accepted and later graded
 *    generously.
 *  - An expectation must resolve in the FUTURE. Registering something already
 *    decidable is backdating, and is refused.
 *  - Resolution is write-once. The claim is immutable; only the outcome may be
 *    appended, and only once.
 *  - Nothing may be graded before its resolve_after instant. Grading early
 *    means grading on incomplete information.
 *  - Accuracy over the journal is WITHHELD below a minimum resolved count, on
 *    the same reasoning as the prediction ledger: a rate over a handful of
 *    claims is noise dressed as a track record.
 */

import { AppDataSource } from "../../config/database";

export const LEARNING_JOURNAL_VERSION = "learning-journal-v1";

/** Matches MIN_GRADED_FOR_RATE in EvidenceService so the two cannot disagree. */
export const MIN_RESOLVED_FOR_RATE = 10;

export type ExpectationStatus = "OPEN" | "CORRECT" | "WRONG" | "PARTIAL" | "UNRESOLVABLE";
export type ExpectationSource = "MODEL" | "CRON" | "OPERATOR" | "STUDY";
export type LessonAction = "NONE" | "THRESHOLD" | "FEATURE" | "GOVERNANCE" | "DATA_FIX" | "CODE_FIX" | "STUDY_QUEUED";

export interface RegisterExpectationInput {
  scope: string;
  subject: string;
  claim: string;
  falsifiableIf: string;
  resolveAfter: Date | string;
  source: ExpectationSource;
  metric?: string | null;
  predictedValue?: number | null;
  predictedLow?: number | null;
  predictedHigh?: number | null;
  confidence?: number | null;
  modelVersion?: string | null;
  policyVersion?: string | null;
  context?: Record<string, unknown> | null;
}

export interface ExpectationRow {
  id: string;
  scope: string;
  subject: string;
  claim: string;
  falsifiableIf: string;
  metric: string | null;
  predictedValue: number | null;
  predictedLow: number | null;
  predictedHigh: number | null;
  confidence: number | null;
  registeredAt: string;
  resolveAfter: string;
  source: ExpectationSource;
  modelVersion: string | null;
  policyVersion: string | null;
  status: ExpectationStatus;
  actualValue: number | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
  /** True once resolve_after has passed while the row is still OPEN. */
  overdue: boolean;
}

export interface LessonRow {
  id: string;
  expectationId: string | null;
  modelKey: string | null;
  category: string;
  observation: string;
  lesson: string;
  actionTaken: LessonAction;
  actionDetail: string | null;
  confirmedByRunId: string | null;
  createdAt: string;
}

export interface JournalSummary {
  version: string;
  open: number;
  overdue: number;
  resolved: number;
  correct: number;
  wrong: number;
  /** Null until enough claims have resolved for a rate to mean anything. */
  accuracyPct: number | null;
  sampleWarning: string | null;
  lessons: number;
  lessonsThatChangedSomething: number;
  headline: string;
}

export interface JournalBundle {
  summary: JournalSummary;
  expectations: ExpectationRow[];
  lessons: LessonRow[];
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function mapExpectation(r: Record<string, unknown>, now: number): ExpectationRow {
  const status = String(r.status) as ExpectationStatus;
  const resolveAfter = iso(r.resolve_after);
  return {
    id: String(r.id),
    scope: String(r.scope),
    subject: String(r.subject),
    claim: String(r.claim),
    falsifiableIf: String(r.falsifiable_if),
    metric: r.metric ? String(r.metric) : null,
    predictedValue: num(r.predicted_value),
    predictedLow: num(r.predicted_low),
    predictedHigh: num(r.predicted_high),
    confidence: num(r.confidence),
    registeredAt: iso(r.registered_at),
    resolveAfter,
    source: String(r.source) as ExpectationSource,
    modelVersion: r.model_version ? String(r.model_version) : null,
    policyVersion: r.policy_version ? String(r.policy_version) : null,
    status,
    actualValue: num(r.actual_value),
    resolutionNote: r.resolution_note ? String(r.resolution_note) : null,
    resolvedAt: r.resolved_at ? iso(r.resolved_at) : null,
    overdue: status === "OPEN" && Date.parse(resolveAfter) < now,
  };
}

export class LearningJournalService {
  /**
   * Register a claim. Refuses anything that could not later be shown wrong.
   *
   * The two refusals below are the guardrails that keep this from decaying
   * into a diary of vague optimism.
   */
  async register(input: RegisterExpectationInput): Promise<ExpectationRow> {
    const claim = input.claim?.trim();
    const falsifiableIf = input.falsifiableIf?.trim();

    if (!claim) throw new Error("An expectation needs a claim.");
    if (!falsifiableIf) {
      throw new Error(
        "REFUSED: an expectation must state what would prove it WRONG. A claim with no falsification criterion cannot be graded honestly."
      );
    }

    const resolveAfter = input.resolveAfter instanceof Date ? input.resolveAfter : new Date(input.resolveAfter);
    if (Number.isNaN(resolveAfter.getTime())) throw new Error("resolveAfter is not a valid date.");
    if (resolveAfter.getTime() <= Date.now()) {
      throw new Error(
        "REFUSED: resolveAfter must be in the FUTURE. Registering a claim that is already decidable is backdating, not prediction."
      );
    }

    const [row]: Record<string, unknown>[] = await AppDataSource.query(
      `INSERT INTO learning_expectations
         (scope, subject, claim, falsifiable_if, metric, predicted_value, predicted_low,
          predicted_high, confidence, resolve_after, source, model_version, policy_version, context)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        input.scope,
        input.subject,
        claim,
        falsifiableIf,
        input.metric ?? null,
        input.predictedValue ?? null,
        input.predictedLow ?? null,
        input.predictedHigh ?? null,
        input.confidence ?? null,
        resolveAfter,
        input.source,
        input.modelVersion ?? null,
        input.policyVersion ?? null,
        input.context ? JSON.stringify(input.context) : null,
      ]
    );
    return mapExpectation(row, Date.now());
  }

  /**
   * Record what actually happened. Write-once; the database enforces it too.
   *
   * Grading before `resolve_after` is refused: the outcome is not yet known,
   * and a claim graded early is graded on partial information.
   */
  async resolve(
    id: string,
    outcome: { status: Exclude<ExpectationStatus, "OPEN">; actualValue?: number | null; note: string }
  ): Promise<ExpectationRow> {
    const note = outcome.note?.trim();
    if (!note) throw new Error("A resolution must say what actually happened.");

    const [existing]: Record<string, unknown>[] = await AppDataSource.query(
      `SELECT id, status, resolve_after FROM learning_expectations WHERE id = $1`,
      [id]
    );
    if (!existing) throw new Error(`No expectation ${id}.`);
    if (String(existing.status) !== "OPEN") {
      throw new Error(`REFUSED: ${id} was already resolved as ${existing.status}. A grading may not be revised.`);
    }
    if (Date.parse(iso(existing.resolve_after)) > Date.now()) {
      throw new Error(
        `REFUSED: ${id} cannot be graded until ${iso(existing.resolve_after)} — the outcome is not yet known.`
      );
    }

    const [row]: Record<string, unknown>[] = await AppDataSource.query(
      `UPDATE learning_expectations
          SET status = $2, actual_value = $3, resolution_note = $4, resolved_at = now()
        WHERE id = $1 AND status = 'OPEN'
        RETURNING *`,
      [id, outcome.status, outcome.actualValue ?? null, note]
    );
    if (!row) throw new Error(`Could not resolve ${id} — it was graded concurrently.`);
    return mapExpectation(row, Date.now());
  }

  /** Expectations that are due for grading right now. */
  async dueForResolution(limit = 100): Promise<ExpectationRow[]> {
    const rows: Record<string, unknown>[] = await AppDataSource.query(
      `SELECT * FROM learning_expectations
        WHERE status = 'OPEN' AND resolve_after <= now()
        ORDER BY resolve_after ASC
        LIMIT $1`,
      [Math.max(1, Math.min(500, Math.floor(limit)))]
    );
    const now = Date.now();
    return rows.map((r) => mapExpectation(r, now));
  }

  /** Write a lesson. `actionTaken: 'NONE'` is a valid, honest outcome. */
  async recordLesson(input: {
    expectationId?: string | null;
    predictionLogId?: string | null;
    experimentRunId?: string | null;
    modelKey?: string | null;
    category: string;
    observation: string;
    lesson: string;
    actionTaken: LessonAction;
    actionDetail?: string | null;
  }): Promise<LessonRow> {
    if (!input.observation?.trim() || !input.lesson?.trim()) {
      throw new Error("A lesson needs both what was observed and what it implies.");
    }
    const [row]: Record<string, unknown>[] = await AppDataSource.query(
      `INSERT INTO learning_lessons
         (expectation_id, prediction_log_id, experiment_run_id, model_key,
          category, observation, lesson, action_taken, action_detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        input.expectationId ?? null,
        input.predictionLogId ?? null,
        input.experimentRunId ?? null,
        input.modelKey ?? null,
        input.category,
        input.observation.trim(),
        input.lesson.trim(),
        input.actionTaken,
        input.actionDetail ?? null,
      ]
    );
    return {
      id: String(row.id),
      expectationId: row.expectation_id ? String(row.expectation_id) : null,
      modelKey: row.model_key ? String(row.model_key) : null,
      category: String(row.category),
      observation: String(row.observation),
      lesson: String(row.lesson),
      actionTaken: String(row.action_taken) as LessonAction,
      actionDetail: row.action_detail ? String(row.action_detail) : null,
      confirmedByRunId: row.confirmed_by_run_id ? String(row.confirmed_by_run_id) : null,
      createdAt: iso(row.created_at),
    };
  }

  async bundle(limit = 200): Promise<JournalBundle> {
    const capped = Math.max(1, Math.min(1000, Math.floor(limit)));
    const now = Date.now();

    const [expRows, lessonRows]: Record<string, unknown>[][] = await Promise.all([
      AppDataSource.query(
        // Wrong first, then still-open (the live commitments), then the rest —
        // the same ordering principle as the prediction ledger.
        `SELECT * FROM learning_expectations
          ORDER BY CASE status WHEN 'WRONG' THEN 0 WHEN 'OPEN' THEN 1 ELSE 2 END,
                   registered_at DESC
          LIMIT $1`,
        [capped]
      ),
      AppDataSource.query(`SELECT * FROM learning_lessons ORDER BY created_at DESC LIMIT $1`, [capped]),
    ]);

    const [counts]: Record<string, string>[] = await AppDataSource.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'OPEN') AS open,
              COUNT(*) FILTER (WHERE status = 'OPEN' AND resolve_after <= now()) AS overdue,
              COUNT(*) FILTER (WHERE status IN ('CORRECT','WRONG','PARTIAL')) AS resolved,
              COUNT(*) FILTER (WHERE status = 'CORRECT') AS correct,
              COUNT(*) FILTER (WHERE status = 'WRONG') AS wrong
         FROM learning_expectations`
    );
    const [lessonCounts]: Record<string, string>[] = await AppDataSource.query(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE action_taken <> 'NONE') AS acted
         FROM learning_lessons`
    );

    const open = Number(counts?.open ?? 0);
    const overdue = Number(counts?.overdue ?? 0);
    const resolved = Number(counts?.resolved ?? 0);
    const correct = Number(counts?.correct ?? 0);
    const wrong = Number(counts?.wrong ?? 0);
    const lessons = Number(lessonCounts?.total ?? 0);
    const acted = Number(lessonCounts?.acted ?? 0);
    const enough = resolved >= MIN_RESOLVED_FOR_RATE;

    return {
      summary: {
        version: LEARNING_JOURNAL_VERSION,
        open,
        overdue,
        resolved,
        correct,
        wrong,
        accuracyPct: enough ? Math.round((correct / resolved) * 1000) / 10 : null,
        sampleWarning: enough
          ? null
          : `${resolved} expectation${resolved === 1 ? " has" : "s have"} resolved so far. A journal accuracy needs at least ` +
            `${MIN_RESOLVED_FOR_RATE} before it means anything, so none is shown.`,
        lessons,
        lessonsThatChangedSomething: acted,
        headline: this.headline(open, overdue, resolved, wrong, lessons, acted),
      },
      expectations: expRows.map((r) => mapExpectation(r, now)),
      lessons: lessonRows.map((r) => ({
        id: String(r.id),
        expectationId: r.expectation_id ? String(r.expectation_id) : null,
        modelKey: r.model_key ? String(r.model_key) : null,
        category: String(r.category),
        observation: String(r.observation),
        lesson: String(r.lesson),
        actionTaken: String(r.action_taken) as LessonAction,
        actionDetail: r.action_detail ? String(r.action_detail) : null,
        confirmedByRunId: r.confirmed_by_run_id ? String(r.confirmed_by_run_id) : null,
        createdAt: iso(r.created_at),
      })),
    };
  }

  private headline(
    open: number,
    overdue: number,
    resolved: number,
    wrong: number,
    lessons: number,
    acted: number
  ): string {
    if (open === 0 && resolved === 0) {
      return "No expectation has been registered yet. Until the system commits to a claim BEFORE the outcome, there is nothing here that can train it.";
    }
    if (overdue > 0) {
      return `${overdue} expectation${overdue === 1 ? " is" : "s are"} past their resolution date and ungraded. An unresolved claim teaches nothing — grade them before registering more.`;
    }
    if (resolved === 0) {
      return `${open} expectation${open === 1 ? "" : "s"} registered and still open. Nothing has resolved yet, so the journal has produced no evidence so far.`;
    }
    return `${wrong} of ${resolved} resolved expectations were wrong. ${lessons} lesson${lessons === 1 ? "" : "s"} recorded, of which ${acted} actually changed something.`;
  }
}

export const learningJournalService = new LearningJournalService();
