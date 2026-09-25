import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * decision_outcome_ledger — Lane C (TradeGate) finally gets a graded track
 * record. Append-only via the shared reject_live_history_mutation() trigger
 * (same admin GUC override as decision_snapshots / live history): outcomes are
 * prospective evidence and must never be edited after the fact. A regrade
 * writes a new row under a new grader_version — hence the composite unique key.
 */
export class CreateDecisionOutcomeLedger1789900000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS decision_outcome_ledger (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      snapshot_id uuid NOT NULL REFERENCES decision_snapshots(id) ON DELETE RESTRICT,
      instrument_id uuid NOT NULL,
      ticker varchar(20) NOT NULL,
      decision_status varchar(25) NOT NULL,
      as_of timestamptz NOT NULL,
      as_of_date date NOT NULL,
      horizon_days int NOT NULL,
      grader_version varchar(40) NOT NULL,
      outcome_status varchar(20) NOT NULL,
      entry_date date,
      terminal_date date,
      sessions_observed int NOT NULL DEFAULT 0,
      claim_gross_return_pct numeric(10,4),
      tradeable_gross_return_pct numeric(10,4),
      tradeable_net_return_pct numeric(10,4),
      cost_pct numeric(8,4),
      entry_gap_pct numeric(8,4),
      direction_hit boolean,
      within_band80 boolean,
      ev_error_pct numeric(10,4),
      claims jsonb NOT NULL DEFAULT '{}'::jsonb,
      flags jsonb NOT NULL DEFAULT '[]'::jsonb,
      graded_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_dol_snapshot_grader
      ON decision_outcome_ledger (snapshot_id, grader_version)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_dol_ticker_asof ON decision_outcome_ledger (ticker, as_of_date DESC)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_dol_status ON decision_outcome_ledger (decision_status, outcome_status)`);

    // Reuse the shared append-only trigger function (created by the live-history
    // migration; re-created here defensively so this migration stands alone).
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
    await q.query(`DROP TRIGGER IF EXISTS trg_decision_outcome_ledger_immutable ON decision_outcome_ledger`);
    await q.query(
      `CREATE TRIGGER trg_decision_outcome_ledger_immutable BEFORE UPDATE OR DELETE ON decision_outcome_ledger FOR EACH ROW EXECUTE FUNCTION reject_live_history_mutation()`
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS trg_decision_outcome_ledger_immutable ON decision_outcome_ledger`);
    await q.query(`DROP TABLE IF EXISTS decision_outcome_ledger`);
  }
}
