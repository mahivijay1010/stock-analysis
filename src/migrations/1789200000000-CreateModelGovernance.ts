import { MigrationInterface, QueryRunner } from "typeorm";

/** Part R — model governance registry + append-only transition trail. */
export class CreateModelGovernance1789200000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS model_governance (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      model_key varchar(80) NOT NULL UNIQUE,
      scope varchar(40) NOT NULL,
      state varchar(12) NOT NULL,
      evidence_run_id uuid,
      reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE TABLE IF NOT EXISTS model_governance_transitions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      model_key varchar(80) NOT NULL,
      from_state varchar(12) NOT NULL,
      to_state varchar(12) NOT NULL,
      reason text NOT NULL,
      evidence_run_id uuid,
      created_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_mgt_key ON model_governance_transitions (model_key, created_at)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS model_governance_transitions`);
    await q.query(`DROP TABLE IF EXISTS model_governance`);
  }
}
