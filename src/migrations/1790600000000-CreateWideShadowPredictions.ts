import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * wide_shadow_predictions — the sub-₹100 lane's own prospective ledger and AI
 * dossier store. NOT append-only in the trigger sense: a row is written once
 * (prediction) and its `outcome` is filled in exactly once at maturity, and
 * its `ai_dossier` once when scouted — same lifecycle as
 * short_term_shadow_predictions. The composite unique key makes a same-session
 * re-scan a no-op while a re-run under a bumped version is a distinct experiment.
 */
export class CreateWideShadowPredictions1790600000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS wide_shadow_predictions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ticker varchar(20) NOT NULL,
      symbol varchar(20) NOT NULL,
      anchor_date date NOT NULL,
      setup_type varchar(30) NOT NULL,
      horizon varchar(12) NOT NULL,
      model_version varchar(40) NOT NULL,
      policy_version varchar(40) NOT NULL,
      feature_version varchar(40) NOT NULL,
      deterministic_decision varchar(12) NOT NULL,
      final_decision varchar(12) NOT NULL,
      gates_passed boolean NOT NULL DEFAULT false,
      plan jsonb NOT NULL,
      screen_evidence jsonb,
      ai_dossier jsonb,
      outcome jsonb,
      resolved_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_wide_shadow_ticker_anchor ON wide_shadow_predictions (ticker, anchor_date DESC)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_wide_shadow_unresolved ON wide_shadow_predictions (resolved_at) WHERE outcome IS NULL`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_wide_shadow_identity
      ON wide_shadow_predictions (ticker, anchor_date, setup_type, horizon, model_version, policy_version, feature_version)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS wide_shadow_predictions`);
  }
}
