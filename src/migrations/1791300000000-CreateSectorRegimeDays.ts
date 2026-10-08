import { MigrationInterface, QueryRunner } from "typeorm";

/** Sector Intelligence (roadmap §6, M2): one point-in-time row per sector per India session. Upsertable like india_market_days. */
export class CreateSectorRegimeDays1791300000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS sector_regime_days (
      sector varchar(24) NOT NULL,
      india_session_date date NOT NULL,
      state varchar(12) NOT NULL,
      score numeric(6,2) NOT NULL,
      components jsonb NOT NULL,
      computed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (sector, india_session_date))`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_sector_regime_date ON sector_regime_days (india_session_date DESC)`);
  }
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS sector_regime_days`);
  }
}
