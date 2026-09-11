import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Realtime V1 — provenance for scraped/polled market readings (reviewer). One
 * append-only row per source per security per cycle. rawHash + parsing_version
 * make each evaluation reproducible and let a scraper change be distinguished
 * from a real market move. Live-panel provenance only; never feeds financial_facts.
 */
export class CreateMarketSourceSnapshots1789600000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS market_source_snapshots (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ticker varchar(20) NOT NULL,
      source varchar(40) NOT NULL,
      source_url text,
      mode varchar(20) NOT NULL,
      fetched_at timestamptz NOT NULL,
      source_timestamp timestamptz,
      raw_hash varchar(64) NOT NULL,
      parsing_version varchar(40) NOT NULL,
      price numeric(14,4),
      open numeric(14,4),
      high numeric(14,4),
      low numeric(14,4),
      volume numeric(20,2),
      change_pct numeric(10,4),
      quality_status varchar(25) NOT NULL,
      freshness_status varchar(20) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_mss_ticker_fetched ON market_source_snapshots (ticker, fetched_at DESC)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_mss_raw_hash ON market_source_snapshots (raw_hash)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS market_source_snapshots`);
  }
}
