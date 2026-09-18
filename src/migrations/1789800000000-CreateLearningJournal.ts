import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The learning journal: pre-registered expectations, scored after the fact.
 *
 * Everything already in the schema is RETROSPECTIVE — prediction_logs records
 * what a model output, model_governance_transitions records what was decided,
 * cron_execution_logs records what ran. None of them can answer the question
 * that actually drives improvement over time:
 *
 *     "What did we EXPECT to happen next, said out loud BEFORE it happened,
 *      and were we right?"
 *
 * Without that, every lesson is written after the outcome is known, which is
 * exactly the condition under which hindsight bias is unfalsifiable: a story
 * can always be told that fits the result. Two tables close it.
 *
 * 1. learning_expectations — a claim registered BEFORE its resolution date,
 *    with its falsification criterion fixed at write time. Append-only except
 *    for the resolution columns, which may be filled exactly once (enforced by
 *    trigger): you may record what happened, you may NEVER edit what you
 *    claimed. That asymmetry is the whole point.
 *
 * 2. learning_lessons — what was concluded and what CHANGED as a result. A
 *    lesson must name the change; a "lesson" that altered nothing is recorded
 *    as such (action_taken = 'NONE') rather than being quietly counted as
 *    learning.
 *
 * Both tables are deliberately source-agnostic: an expectation may be
 * registered by a model, by a scheduled job, or by a human operator. The
 * scoring rule is identical either way, which is what makes the record
 * comparable across sources.
 */
export class CreateLearningJournal1789800000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS learning_expectations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

      -- WHAT is being claimed, and about what.
      scope varchar(40) NOT NULL,              -- e.g. 'TICKER' | 'SETUP' | 'MODEL' | 'SYSTEM'
      subject varchar(120) NOT NULL,           -- ticker, setup key, model key, or a named question
      claim text NOT NULL,                     -- the expectation in plain language
      /* The falsification criterion, fixed BEFORE the outcome is known. An
         expectation without one cannot be graded and must not be accepted. */
      falsifiable_if text NOT NULL,

      -- Optional quantitative form, when the claim has one.
      metric varchar(60),
      predicted_value numeric(14,6),
      predicted_low numeric(14,6),
      predicted_high numeric(14,6),
      confidence numeric(5,4),                 -- stated up front; scored for calibration later

      -- WHEN it can be judged. Registered strictly before this instant.
      registered_at timestamptz NOT NULL DEFAULT now(),
      resolve_after timestamptz NOT NULL,

      -- Provenance: who/what registered it, and against which code.
      source varchar(40) NOT NULL,             -- 'MODEL' | 'CRON' | 'OPERATOR' | 'STUDY'
      model_version varchar(60),
      policy_version varchar(60),
      context jsonb,                           -- the inputs available at registration time

      -- RESOLUTION. Null until judged; writable exactly once (see trigger).
      status varchar(12) NOT NULL DEFAULT 'OPEN',   -- OPEN | CORRECT | WRONG | PARTIAL | UNRESOLVABLE
      actual_value numeric(14,6),
      resolution_note text,
      resolved_at timestamptz,

      created_at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT chk_le_status CHECK (status IN ('OPEN','CORRECT','WRONG','PARTIAL','UNRESOLVABLE')),
      CONSTRAINT chk_le_source CHECK (source IN ('MODEL','CRON','OPERATOR','STUDY')),
      /* A resolved row must carry its resolution timestamp, and an OPEN row
         must not. Prevents half-written gradings that would silently drop out
         of both the open and the scored population. */
      CONSTRAINT chk_le_resolved_consistency CHECK (
        (status = 'OPEN' AND resolved_at IS NULL) OR (status <> 'OPEN' AND resolved_at IS NOT NULL)
      ),
      CONSTRAINT chk_le_window CHECK (resolve_after > registered_at)
    )`);

    await q.query(`CREATE INDEX IF NOT EXISTS idx_le_open ON learning_expectations (resolve_after) WHERE status = 'OPEN'`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_le_subject ON learning_expectations (scope, subject, registered_at DESC)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_le_status ON learning_expectations (status, resolved_at DESC)`);

    await q.query(`CREATE TABLE IF NOT EXISTS learning_lessons (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

      -- What prompted the lesson. At least one link SHOULD be present, but a
      -- lesson drawn from a pattern across many rows may legitimately have none.
      expectation_id uuid REFERENCES learning_expectations(id),
      prediction_log_id uuid,
      experiment_run_id uuid,
      model_key varchar(80),

      category varchar(40) NOT NULL,           -- 'MISS' | 'CALIBRATION' | 'DATA' | 'COST' | 'PROCESS' | 'REGIME'
      observation text NOT NULL,               -- what was actually seen
      lesson text NOT NULL,                    -- what it implies

      /* What CHANGED. 'NONE' is a first-class, honest answer: most single
         observations should not move a system, and recording that is what
         stops the journal becoming a list of rationalisations. */
      action_taken varchar(20) NOT NULL,       -- 'NONE' | 'THRESHOLD' | 'FEATURE' | 'GOVERNANCE' | 'DATA_FIX' | 'CODE_FIX' | 'STUDY_QUEUED'
      action_detail text,
      /* Set only once the change itself has been validated — a lesson is not
         'confirmed' merely because it was written down convincingly. */
      confirmed_by_run_id uuid,

      created_at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT chk_ll_action CHECK (
        action_taken IN ('NONE','THRESHOLD','FEATURE','GOVERNANCE','DATA_FIX','CODE_FIX','STUDY_QUEUED')
      )
    )`);

    await q.query(`CREATE INDEX IF NOT EXISTS idx_ll_created ON learning_lessons (created_at DESC)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_ll_category ON learning_lessons (category, created_at DESC)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_ll_expectation ON learning_lessons (expectation_id)`);

    /*
     * The claim is immutable; only the resolution may be written, and only
     * once. Editing `claim`, `falsifiable_if`, `predicted_value`, `confidence`
     * or the timing columns after the fact would let a wrong call be quietly
     * rewritten into a right one — the precise failure this journal exists to
     * make impossible.
     */
    await q.query(`
      CREATE OR REPLACE FUNCTION reject_expectation_rewrite() RETURNS trigger AS $func$
      BEGIN
        IF current_setting('stocksense.allow_snapshot_mutation', true) = 'on' THEN
          IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;
        END IF;

        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'learning_expectations is append-only: DELETE blocked. A registered expectation may never be withdrawn.';
        END IF;

        IF NEW.claim IS DISTINCT FROM OLD.claim
           OR NEW.falsifiable_if IS DISTINCT FROM OLD.falsifiable_if
           OR NEW.scope IS DISTINCT FROM OLD.scope
           OR NEW.subject IS DISTINCT FROM OLD.subject
           OR NEW.metric IS DISTINCT FROM OLD.metric
           OR NEW.predicted_value IS DISTINCT FROM OLD.predicted_value
           OR NEW.predicted_low IS DISTINCT FROM OLD.predicted_low
           OR NEW.predicted_high IS DISTINCT FROM OLD.predicted_high
           OR NEW.confidence IS DISTINCT FROM OLD.confidence
           OR NEW.registered_at IS DISTINCT FROM OLD.registered_at
           OR NEW.resolve_after IS DISTINCT FROM OLD.resolve_after
           OR NEW.source IS DISTINCT FROM OLD.source
           OR NEW.context IS DISTINCT FROM OLD.context THEN
          RAISE EXCEPTION 'learning_expectations: the CLAIM is immutable. Only resolution columns (status, actual_value, resolution_note, resolved_at) may be written.';
        END IF;

        IF OLD.status <> 'OPEN' THEN
          RAISE EXCEPTION 'learning_expectations: % was already resolved as %. A grading may not be revised.', OLD.id, OLD.status;
        END IF;

        RETURN NEW;
      END;
      $func$ LANGUAGE plpgsql`);

    await q.query(`DROP TRIGGER IF EXISTS trg_learning_expectations_immutable ON learning_expectations`);
    await q.query(`CREATE TRIGGER trg_learning_expectations_immutable
      BEFORE UPDATE OR DELETE ON learning_expectations
      FOR EACH ROW EXECUTE FUNCTION reject_expectation_rewrite()`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS trg_learning_expectations_immutable ON learning_expectations`);
    await q.query(`DROP FUNCTION IF EXISTS reject_expectation_rewrite()`);
    await q.query(`DROP TABLE IF EXISTS learning_lessons`);
    await q.query(`DROP TABLE IF EXISTS learning_expectations`);
  }
}
