import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Realtime V1 append-only live history (reviewer priorities 2/3):
 *  - live_prediction_revisions: one immutable revision per checkpoint.
 *  - live_decision_events: one immutable row per state transition.
 * Both carry a BEFORE UPDATE OR DELETE trigger rejecting mutation (an
 * administrative GUC override mirrors decision_snapshots) — this prospective
 * dataset is the evidence that decides realtime authority and must not be edited.
 */
export class CreateLiveHistory1789700000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS live_prediction_revisions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ticker varchar(20) NOT NULL,
      evaluated_at timestamptz NOT NULL,
      previous_revision_id uuid,
      market_snapshot_id uuid,
      decision_snapshot_id uuid,
      context_hash varchar(64) NOT NULL,
      delta_hash varchar(64),
      assessment varchar(25) NOT NULL,
      setup_state varchar(30) NOT NULL,
      expected_r numeric(10,4),
      expected_r_lower_bound numeric(10,4),
      entry_quality varchar(10) NOT NULL,
      risk_state varchar(12) NOT NULL,
      data_quality varchar(12) NOT NULL,
      data_mode varchar(20) NOT NULL,
      gate varchar(25) NOT NULL,
      opportunity_rank int,
      actionable_rank int,
      model_version varchar(40) NOT NULL,
      feature_version varchar(40) NOT NULL,
      policy_version varchar(40) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_lpr_ticker_evat ON live_prediction_revisions (ticker, evaluated_at DESC)`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_live_revision
      ON live_prediction_revisions (ticker, evaluated_at, model_version, feature_version, policy_version)`);

    await q.query(`CREATE TABLE IF NOT EXISTS live_decision_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ticker varchar(20) NOT NULL,
      occurred_at timestamptz NOT NULL,
      from_state varchar(30) NOT NULL,
      to_state varchar(30) NOT NULL,
      trigger varchar(40) NOT NULL,
      evidence_ids jsonb,
      prediction_revision_id uuid,
      decision_snapshot_id uuid,
      created_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_lde_ticker_occat ON live_decision_events (ticker, occurred_at DESC)`);

    // Shared append-only trigger function (same override GUC as decision_snapshots).
    await q.query(`
      CREATE OR REPLACE FUNCTION reject_live_history_mutation() RETURNS trigger AS $func$
      BEGIN
        IF current_setting('stocksense.allow_snapshot_mutation', true) IS DISTINCT FROM 'on' THEN
          RAISE EXCEPTION '% is append-only: % blocked. Prospective evidence is immutable; SET stocksense.allow_snapshot_mutation = ''on'' in an explicit admin transaction to override.', TG_TABLE_NAME, TG_OP;
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END;
      $func$ LANGUAGE plpgsql`);
    for (const t of ["live_prediction_revisions", "live_decision_events"]) {
      await q.query(`DROP TRIGGER IF EXISTS trg_${t}_immutable ON ${t}`);
      await q.query(`CREATE TRIGGER trg_${t}_immutable BEFORE UPDATE OR DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION reject_live_history_mutation()`);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS trg_live_decision_events_immutable ON live_decision_events`);
    await q.query(`DROP TRIGGER IF EXISTS trg_live_prediction_revisions_immutable ON live_prediction_revisions`);
    await q.query(`DROP FUNCTION IF EXISTS reject_live_history_mutation()`);
    await q.query(`DROP TABLE IF EXISTS live_decision_events`);
    await q.query(`DROP TABLE IF EXISTS live_prediction_revisions`);
  }
}
