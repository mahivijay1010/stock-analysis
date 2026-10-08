import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Global Market Intelligence (spec §26–§44):
 *  global_market_observations   one row per instrument × local session (price, returns, vol, freshness, timezone)
 *  global_market_snapshots      IMMUTABLE: every observation available at a decision cutoff + regime + transmission
 *  global_regime_days           daily regime classification (backfilled from history; append-only by date)
 *  global_events                scheduled macro events (expected / actual / surprise / reaction)
 *  global_relationship_studies  append-only empirical studies (shock → forward returns), also mirrored to experiment_runs
 */
export class CreateGlobalMarketIntelligence1791100000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS global_market_observations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      instrument varchar(40) NOT NULL,
      asset_class varchar(16) NOT NULL,
      region varchar(16) NOT NULL,
      session_date date NOT NULL,
      exchange_tz varchar(40) NOT NULL,
      local_close_at timestamptz,
      utc_close_at timestamptz,
      price numeric(18,6) NOT NULL,
      return_1d numeric(10,4),
      return_5d numeric(10,4),
      return_20d numeric(10,4),
      volatility_20 numeric(10,4),
      volume numeric(20,2),
      source varchar(40) NOT NULL,
      source_timestamp timestamptz,
      freshness varchar(12) NOT NULL DEFAULT 'UNKNOWN',
      data_quality numeric(5,1) NOT NULL DEFAULT 0,
      fetched_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_global_obs ON global_market_observations (instrument, session_date)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_global_obs_date ON global_market_observations (session_date DESC)`);

    await q.query(`CREATE TABLE IF NOT EXISTS global_market_snapshots (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      cutoff_utc timestamptz NOT NULL,
      india_session_date date NOT NULL,
      kind varchar(12) NOT NULL DEFAULT 'REQUEST',
      observations jsonb NOT NULL,
      coverage jsonb NOT NULL,
      regime jsonb NOT NULL,
      transmission jsonb,
      sectors jsonb,
      created_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_global_snap_cutoff ON global_market_snapshots (cutoff_utc DESC)`);

    await q.query(`CREATE TABLE IF NOT EXISTS global_regime_days (
      india_session_date date PRIMARY KEY,
      regime varchar(12) NOT NULL,
      score numeric(6,2) NOT NULL,
      components jsonb NOT NULL,
      coverage jsonb NOT NULL,
      feature_cutoff_utc timestamptz NOT NULL,
      computed_at timestamptz NOT NULL DEFAULT now())`);

    await q.query(`CREATE TABLE IF NOT EXISTS global_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event varchar(80) NOT NULL,
      region varchar(16) NOT NULL,
      scheduled_at timestamptz NOT NULL,
      actual_at timestamptz,
      importance varchar(8) NOT NULL DEFAULT 'HIGH',
      expected text,
      actual text,
      surprise text,
      market_reaction jsonb,
      source varchar(120),
      created_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_global_event ON global_events (event, scheduled_at)`);

    await q.query(`CREATE TABLE IF NOT EXISTS global_relationship_studies (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      study_version varchar(30) NOT NULL,
      driver varchar(40) NOT NULL,
      shock varchar(120) NOT NULL,
      target varchar(40) NOT NULL,
      horizon_sessions int NOT NULL,
      n int NOT NULL,
      mean_pct numeric(10,4),
      median_pct numeric(10,4),
      win_rate_pct numeric(6,2),
      wilson_lb95_pct numeric(6,2),
      vol_pct numeric(10,4),
      max_drawdown_pct numeric(10,4),
      benchmark_mean_pct numeric(10,4),
      benchmark_n int,
      data_from date,
      data_to date,
      displayable boolean NOT NULL DEFAULT false,
      detail jsonb,
      experiment_run_id uuid,
      computed_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_global_rel_driver ON global_relationship_studies (driver, target, horizon_sessions, computed_at DESC)`);

    for (const t of ["global_market_snapshots", "global_relationship_studies"]) {
      await q.query(`DROP TRIGGER IF EXISTS trg_${t}_immutable ON ${t}`);
      await q.query(`CREATE TRIGGER trg_${t}_immutable BEFORE UPDATE OR DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION reject_live_history_mutation()`);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const t of ["global_relationship_studies", "global_events", "global_regime_days", "global_market_snapshots", "global_market_observations"]) {
      await q.query(`DROP TRIGGER IF EXISTS trg_${t}_immutable ON ${t}`);
      await q.query(`DROP TABLE IF EXISTS ${t}`);
    }
  }
}
