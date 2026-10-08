import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Stock Universe + Research Engine 2.0 (docs/universe-diagnostic-2026-10-08.md §H).
 *  security_master              the exchange-wide security master (one row per NSE symbol)
 *  security_master_changes      append-only: new listings, symbol/name/ISIN changes, (de)activations
 *  security_data_coverage       per-security coverage flags, timestamps, score
 *  universe_sync_runs           ingestion audit: source, counts, freshness, errors
 *  opportunity_scans            one row per broad-market scan with the full funnel
 *  opportunity_candidates       point-in-time features + evidence dimensions per candidate
 *  research_queue               prioritised research work list
 *  company_research_profiles    versioned structured research (FACT / INFERENCE / HYPOTHESIS kept apart)
 *  opportunity_outcomes         append-only graded outcomes for the learning dataset
 */
export class CreateUniverseEngine1791000000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS security_master (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      symbol varchar(40) NOT NULL UNIQUE,
      yahoo_ticker varchar(50) NOT NULL,
      company_name varchar(200) NOT NULL,
      isin varchar(12),
      exchange varchar(8) NOT NULL DEFAULT 'NSE',
      series varchar(4),
      instrument_type varchar(12) NOT NULL DEFAULT 'EQUITY',
      sector varchar(120),
      industry varchar(120),
      market_cap_inr numeric(20,2),
      market_cap_bucket varchar(10) NOT NULL DEFAULT 'UNKNOWN',
      market_cap_source varchar(40),
      listed_date date,
      is_active boolean NOT NULL DEFAULT true,
      is_tradable boolean NOT NULL DEFAULT false,
      liquidity_tier varchar(2) NOT NULL DEFAULT 'X',
      liquidity_median_value_inr numeric(18,2),
      liquidity_as_of date,
      last_trade_date date,
      surveillance varchar(24),
      currency varchar(3) NOT NULL DEFAULT 'INR',
      data_status varchar(12) NOT NULL DEFAULT 'NONE',
      indices text[] NOT NULL DEFAULT '{}',
      source varchar(40) NOT NULL,
      source_freshness_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_secmaster_tier ON security_master (liquidity_tier, instrument_type, is_active)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_secmaster_isin ON security_master (isin)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_secmaster_yahoo ON security_master (yahoo_ticker)`);

    await q.query(`CREATE TABLE IF NOT EXISTS security_master_changes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      symbol varchar(40) NOT NULL,
      change_type varchar(20) NOT NULL,
      old_value text,
      new_value text,
      source varchar(40) NOT NULL,
      observed_at date NOT NULL,
      sync_run_id uuid,
      created_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_secchanges_symbol ON security_master_changes (symbol, observed_at DESC)`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_secchanges_identity ON security_master_changes (symbol, change_type, observed_at, COALESCE(new_value,''))`);

    await q.query(`CREATE TABLE IF NOT EXISTS security_data_coverage (
      symbol varchar(40) PRIMARY KEY REFERENCES security_master(symbol),
      price_available boolean NOT NULL DEFAULT false,
      ohlcv_available boolean NOT NULL DEFAULT false,
      close_only boolean NOT NULL DEFAULT false,
      historical_depth_sessions int NOT NULL DEFAULT 0,
      fundamentals_available boolean NOT NULL DEFAULT false,
      financial_results_available boolean NOT NULL DEFAULT false,
      corporate_actions_available boolean NOT NULL DEFAULT false,
      announcement_available boolean NOT NULL DEFAULT false,
      news_available boolean NOT NULL DEFAULT false,
      technical_features_available boolean NOT NULL DEFAULT false,
      last_price_timestamp timestamptz,
      last_fundamental_timestamp timestamptz,
      last_news_timestamp timestamptz,
      last_event_timestamp timestamptz,
      coverage_score numeric(5,1) NOT NULL DEFAULT 0,
      detail jsonb,
      computed_at timestamptz NOT NULL DEFAULT now())`);

    await q.query(`CREATE TABLE IF NOT EXISTS universe_sync_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      job varchar(40) NOT NULL,
      source varchar(60) NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      status varchar(12) NOT NULL DEFAULT 'running',
      counts jsonb NOT NULL DEFAULT '{}'::jsonb,
      error text)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_universe_sync_job ON universe_sync_runs (job, started_at DESC)`);

    await q.query(`CREATE TABLE IF NOT EXISTS opportunity_scans (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      as_of date NOT NULL,
      universe_label varchar(30) NOT NULL DEFAULT 'BROAD_SCAN',
      started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      status varchar(12) NOT NULL DEFAULT 'running',
      config jsonb NOT NULL DEFAULT '{}'::jsonb,
      stages jsonb NOT NULL DEFAULT '[]'::jsonb,
      regime varchar(16),
      scan_run_id uuid,
      notes text)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_opp_scans_asof ON opportunity_scans (as_of DESC)`);

    await q.query(`CREATE TABLE IF NOT EXISTS opportunity_candidates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      scan_id uuid NOT NULL REFERENCES opportunity_scans(id),
      symbol varchar(40) NOT NULL,
      yahoo_ticker varchar(50) NOT NULL,
      as_of date NOT NULL,
      liquidity_tier varchar(2) NOT NULL,
      market_cap_bucket varchar(10) NOT NULL,
      sector varchar(120),
      stage_reached varchar(20) NOT NULL,
      rejected_at_stage varchar(20),
      rejection_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
      signals text[] NOT NULL DEFAULT '{}',
      features jsonb NOT NULL,
      technical_score numeric(5,1),
      fundamental_score numeric(5,1),
      event_score numeric(5,1),
      research_evidence_score numeric(5,1),
      liquidity_score numeric(5,1),
      risk_score numeric(5,1),
      model_health_score numeric(5,1),
      screen_rank int,
      setup_type varchar(40),
      action varchar(30),
      tier varchar(2),
      decision_status varchar(24),
      plan jsonb,
      short_term_candidate_id uuid,
      feature_cutoff_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_opp_cand_scan ON opportunity_candidates (scan_id, stage_reached)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_opp_cand_symbol ON opportunity_candidates (symbol, as_of DESC)`);

    await q.query(`CREATE TABLE IF NOT EXISTS research_queue (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      symbol varchar(40) NOT NULL,
      priority numeric(6,2) NOT NULL,
      reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
      source varchar(16) NOT NULL,
      status varchar(12) NOT NULL DEFAULT 'PENDING',
      queued_at timestamptz NOT NULL DEFAULT now(),
      researched_at timestamptz,
      profile_id uuid,
      error text)`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_research_queue_pending ON research_queue (symbol) WHERE status = 'PENDING'`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_research_queue_priority ON research_queue (status, priority DESC)`);

    await q.query(`CREATE TABLE IF NOT EXISTS company_research_profiles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      symbol varchar(40) NOT NULL,
      research_version varchar(30) NOT NULL,
      built_at timestamptz NOT NULL DEFAULT now(),
      data_as_of jsonb NOT NULL,
      profile jsonb NOT NULL,
      evidence_items jsonb NOT NULL DEFAULT '[]'::jsonb,
      source_references jsonb NOT NULL DEFAULT '[]'::jsonb,
      ai jsonb,
      model_version varchar(60),
      coverage_score numeric(5,1))`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_crp_symbol ON company_research_profiles (symbol, built_at DESC)`);

    await q.query(`CREATE TABLE IF NOT EXISTS opportunity_outcomes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      candidate_id uuid NOT NULL REFERENCES opportunity_candidates(id),
      grader_version varchar(30) NOT NULL,
      outcome varchar(14) NOT NULL,
      entry_at date,
      entry_price numeric(14,4),
      exit_at date,
      exit_price numeric(14,4),
      realized_return_pct numeric(10,4),
      realized_net_r numeric(10,4),
      benchmark_return_pct numeric(10,4),
      excess_return_pct numeric(10,4),
      mfe_r numeric(10,4),
      mae_r numeric(10,4),
      holding_sessions int NOT NULL DEFAULT 0,
      ambiguous boolean NOT NULL DEFAULT false,
      feature_cutoff_at timestamptz,
      decision_time timestamptz NOT NULL,
      outcome_maturity_time timestamptz,
      flags jsonb NOT NULL DEFAULT '[]'::jsonb,
      graded_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_opp_outcome_grader ON opportunity_outcomes (candidate_id, grader_version)`);

    for (const t of ["security_master_changes", "company_research_profiles", "opportunity_outcomes"]) {
      await q.query(`DROP TRIGGER IF EXISTS trg_${t}_immutable ON ${t}`);
      await q.query(`CREATE TRIGGER trg_${t}_immutable BEFORE UPDATE OR DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION reject_live_history_mutation()`);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const t of ["opportunity_outcomes", "company_research_profiles", "research_queue", "opportunity_candidates", "opportunity_scans", "universe_sync_runs", "security_data_coverage", "security_master_changes", "security_master"]) {
      await q.query(`DROP TRIGGER IF EXISTS trg_${t}_immutable ON ${t}`);
      await q.query(`DROP TABLE IF EXISTS ${t}`);
    }
  }
}
