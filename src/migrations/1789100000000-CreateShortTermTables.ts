import { MigrationInterface, QueryRunner } from "typeorm";

/** Short-Term Trade Radar tables (S1/S8/S9). */
export class CreateShortTermTables1789100000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS short_term_scan_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      params jsonb NOT NULL,
      universe_size int NOT NULL,
      passed_gates int NOT NULL,
      qualified_shown int NOT NULL,
      model_version varchar(40) NOT NULL,
      feature_version varchar(40) NOT NULL,
      policy_version varchar(40) NOT NULL,
      data_provider varchar(60) NOT NULL,
      data_freshness varchar(12) NOT NULL,
      data_timestamp timestamptz,
      diagnostics jsonb,
      created_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE TABLE IF NOT EXISTS short_term_candidates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      scan_run_id uuid NOT NULL,
      ticker varchar(20) NOT NULL,
      state varchar(30) NOT NULL,
      action varchar(30) NOT NULL,
      setup_type varchar(30) NOT NULL,
      rank int,
      ranking_score numeric(10,2),
      passed_gates boolean NOT NULL,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_st_cand_scan ON short_term_candidates (scan_run_id)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_st_cand_ticker ON short_term_candidates (ticker, created_at)`);
    await q.query(`CREATE TABLE IF NOT EXISTS short_term_signal_transitions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ticker varchar(20) NOT NULL,
      from_state varchar(30) NOT NULL,
      to_state varchar(30) NOT NULL,
      reason text NOT NULL,
      scan_run_id uuid,
      created_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_st_trans_ticker ON short_term_signal_transitions (ticker, created_at)`);
    await q.query(`CREATE TABLE IF NOT EXISTS short_term_shadow_predictions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ticker varchar(20) NOT NULL,
      anchor_date date NOT NULL,
      setup_type varchar(30) NOT NULL,
      horizon varchar(12) NOT NULL,
      model_version varchar(40) NOT NULL,
      plan jsonb NOT NULL,
      forecast jsonb NOT NULL,
      outcome jsonb,
      resolved_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_st_shadow ON short_term_shadow_predictions (ticker, anchor_date, setup_type, horizon)`);
    await q.query(`CREATE TABLE IF NOT EXISTS short_term_paper_trades (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ticker varchar(20) NOT NULL,
      horizon varchar(12) NOT NULL,
      setup_type varchar(30) NOT NULL,
      status varchar(20) NOT NULL,
      plan jsonb NOT NULL,
      entry_price numeric(14,2),
      entry_date date,
      exit_price numeric(14,2),
      exit_date date,
      exit_reason varchar(40),
      metrics jsonb,
      created_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE TABLE IF NOT EXISTS short_term_model_performance (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      model_name varchar(60) NOT NULL,
      model_version varchar(40) NOT NULL,
      state varchar(12) NOT NULL,
      metrics jsonb NOT NULL,
      verdict text,
      created_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE TABLE IF NOT EXISTS short_term_alerts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ticker varchar(20) NOT NULL,
      alert_type varchar(40) NOT NULL,
      message text NOT NULL,
      dedupe_key varchar(120) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_st_alert_dedupe ON short_term_alerts (ticker, alert_type, dedupe_key)`);
    await q.query(`CREATE TABLE IF NOT EXISTS short_term_user_preferences (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id uuid NOT NULL UNIQUE,
      prefs jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const t of [
      "short_term_user_preferences",
      "short_term_alerts",
      "short_term_model_performance",
      "short_term_paper_trades",
      "short_term_shadow_predictions",
      "short_term_signal_transitions",
      "short_term_candidates",
      "short_term_scan_runs",
    ]) {
      await q.query(`DROP TABLE IF EXISTS ${t}`);
    }
  }
}
