import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Money Desk / capital-allocation layer. Four append-only tables:
 *  - capital_plans: one immutable row per generated plan (request or daily snapshot)
 *  - capital_allocations: the ALLOCATE/WATCH/HOLD/REDUCE/EXIT/CASH lines of a plan
 *  - capital_decision_outcomes: graded forward outcomes (one per allocation × grader)
 *  - daily_capital_decision_snapshots: the exact state the desk believed at session start
 * All four carry the shared reject_live_history_mutation() trigger: UPDATE/DELETE is
 * refused unless stocksense.allow_snapshot_mutation='on' in an explicit admin txn.
 * A new recommendation is always a NEW row; history is never regenerated.
 */
export class CreateCapitalDesk1790900000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS capital_plans (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id uuid NOT NULL,
      kind varchar(12) NOT NULL DEFAULT 'REQUEST',
      as_of timestamptz NOT NULL,
      plan_date date NOT NULL,
      capital_available_inr numeric(16,2) NOT NULL,
      capital_invested_inr numeric(16,2) NOT NULL,
      cash_reserve_inr numeric(16,2) NOT NULL,
      recommended_deployment_inr numeric(16,2) NOT NULL,
      risk_budget_inr numeric(16,2) NOT NULL,
      risk_profile varchar(14) NOT NULL,
      horizon varchar(8) NOT NULL,
      max_positions int NOT NULL,
      market_regime varchar(16) NOT NULL,
      decision_policy_version varchar(40) NOT NULL,
      model_version varchar(60) NOT NULL,
      feature_cutoff_at timestamptz,
      freshness jsonb NOT NULL,
      summary text NOT NULL,
      result jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_capital_plans_account_date ON capital_plans (account_id, plan_date DESC)`);

    await q.query(`CREATE TABLE IF NOT EXISTS capital_allocations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      capital_plan_id uuid NOT NULL REFERENCES capital_plans(id),
      account_id uuid NOT NULL,
      plan_date date NOT NULL,
      ticker varchar(20) NOT NULL,
      action varchar(10) NOT NULL,
      recommended_amount_inr numeric(16,2),
      recommended_qty int,
      max_amount_inr numeric(16,2),
      pct_of_capital numeric(8,2),
      entry_price numeric(14,4),
      entry_zone_low numeric(14,4),
      entry_zone_high numeric(14,4),
      entry_type varchar(30),
      stop_price numeric(14,4),
      target1 numeric(14,4),
      target2 numeric(14,4),
      target3 numeric(14,4),
      expected_holding_sessions int,
      risk_amount_inr numeric(16,2),
      reward_risk numeric(8,3),
      ev_after_costs_pct numeric(8,3),
      evidence_score numeric(6,1),
      evidence_tier varchar(2),
      setup_type varchar(40),
      decision_status varchar(24) NOT NULL,
      reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
      risk_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
      invalidation_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
      detail jsonb,
      model_version varchar(60) NOT NULL,
      decision_snapshot_id uuid,
      created_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_capital_alloc_plan ON capital_allocations (capital_plan_id)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_capital_alloc_ticker_date ON capital_allocations (ticker, plan_date DESC)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_capital_alloc_account_date ON capital_allocations (account_id, plan_date DESC)`);

    await q.query(`CREATE TABLE IF NOT EXISTS capital_decision_outcomes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      capital_allocation_id uuid NOT NULL REFERENCES capital_allocations(id),
      grader_version varchar(30) NOT NULL,
      outcome varchar(14) NOT NULL,
      entry_triggered boolean NOT NULL DEFAULT false,
      entry_price numeric(14,4),
      entry_at date,
      exit_triggered boolean NOT NULL DEFAULT false,
      exit_price numeric(14,4),
      exit_at date,
      realized_pnl_inr numeric(16,2),
      realized_return_pct numeric(10,4),
      realized_net_r numeric(10,4),
      conservative_net_r numeric(10,4),
      mfe_r numeric(10,4),
      mae_r numeric(10,4),
      holding_sessions int NOT NULL DEFAULT 0,
      benchmark_return_pct numeric(10,4),
      excess_return_pct numeric(10,4),
      ambiguous boolean NOT NULL DEFAULT false,
      feature_cutoff_at timestamptz,
      decision_time timestamptz NOT NULL,
      outcome_maturity_time timestamptz,
      flags jsonb NOT NULL DEFAULT '[]'::jsonb,
      graded_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_capital_outcome_grader ON capital_decision_outcomes (capital_allocation_id, grader_version)`);

    await q.query(`CREATE TABLE IF NOT EXISTS daily_capital_decision_snapshots (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id uuid NOT NULL,
      snapshot_date date NOT NULL,
      capital_plan_id uuid NOT NULL REFERENCES capital_plans(id),
      risk_profile varchar(14) NOT NULL,
      market_regime varchar(16) NOT NULL,
      model_versions jsonb NOT NULL,
      feature_cutoff_at timestamptz,
      freshness jsonb NOT NULL,
      state jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_capital_snapshot ON daily_capital_decision_snapshots (account_id, snapshot_date)`);

    // Shared append-only guard (defined by 1790100000000; re-declared idempotently here).
    await q.query(`CREATE OR REPLACE FUNCTION reject_live_history_mutation() RETURNS trigger AS $func$
      BEGIN
        IF current_setting('stocksense.allow_snapshot_mutation', true) IS DISTINCT FROM 'on' THEN
          RAISE EXCEPTION '% is append-only: % blocked. Prospective evidence is immutable; SET stocksense.allow_snapshot_mutation = ''on'' in an explicit admin transaction to override.', TG_TABLE_NAME, TG_OP;
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END;
      $func$ LANGUAGE plpgsql`);
    for (const t of ["capital_plans", "capital_allocations", "capital_decision_outcomes", "daily_capital_decision_snapshots"]) {
      await q.query(`DROP TRIGGER IF EXISTS trg_${t}_immutable ON ${t}`);
      await q.query(`CREATE TRIGGER trg_${t}_immutable BEFORE UPDATE OR DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION reject_live_history_mutation()`);
    }
    // experiment_runs was append-only by convention only; make it so (Model Lab history).
    await q.query(`DROP TRIGGER IF EXISTS trg_experiment_runs_immutable ON experiment_runs`);
    await q.query(`CREATE TRIGGER trg_experiment_runs_immutable BEFORE UPDATE OR DELETE ON experiment_runs FOR EACH ROW EXECUTE FUNCTION reject_live_history_mutation()`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS trg_experiment_runs_immutable ON experiment_runs`);
    for (const t of ["daily_capital_decision_snapshots", "capital_decision_outcomes", "capital_allocations", "capital_plans"]) {
      await q.query(`DROP TRIGGER IF EXISTS trg_${t}_immutable ON ${t}`);
      await q.query(`DROP TABLE IF EXISTS ${t}`);
    }
  }
}
