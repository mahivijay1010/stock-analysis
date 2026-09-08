import { MigrationInterface, QueryRunner } from "typeorm";

/** Phase 9: point-in-time structured market events (announcedAt is the leakage key). */
export class CreateStructuredMarketEvents1788758000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS structured_market_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        ticker varchar(20) NOT NULL,
        event_type varchar(30) NOT NULL,
        event_date date NOT NULL,
        announced_at timestamptz NOT NULL,
        source varchar(80) NOT NULL,
        source_tier smallint NOT NULL,
        headline text,
        url text,
        payload jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_sme_ticker_announced ON structured_market_events (ticker, announced_at)`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_sme_dedupe ON structured_market_events (ticker, event_type, event_date, source)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS structured_market_events`);
  }
}
