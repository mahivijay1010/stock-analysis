import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * India Market Diagnosis (roadmap §4.5, Milestone 1): one point-in-time row per
 * India session with the diagnostic state, per-component scores and coverage.
 * Upsertable like global_regime_days — it is a recomputable classification of
 * closed sessions, not prospective evidence. The authoritative gate input
 * remains shortterm/RegimeService; this table is diagnosis and context.
 */
export class CreateIndiaMarketDays1791200000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS india_market_days (
      india_session_date date PRIMARY KEY,
      state varchar(12) NOT NULL,
      score numeric(6,2) NOT NULL,
      components jsonb NOT NULL,
      coverage jsonb NOT NULL,
      feature_cutoff_utc timestamptz NOT NULL,
      computed_at timestamptz NOT NULL DEFAULT now())`);
  }
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS india_market_days`);
  }
}
