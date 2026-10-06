import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * nse_securities.instrument_type — NSE lists ETFs (and a few other
 * non-company instruments) in the EQ series, so EQUITY_L alone cannot tell a
 * company from a gold ETF. The wide screen is for companies; ETFs are tagged
 * from NSE's own ETF list (eq_etfseclist.csv) and excluded.
 */
export class AddInstrumentType1790500000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE nse_securities ADD COLUMN IF NOT EXISTS instrument_type varchar(12) NOT NULL DEFAULT 'STOCK'`);
    await q.query(`ALTER TABLE nse_securities DROP CONSTRAINT IF EXISTS chk_ns_type`);
    await q.query(`ALTER TABLE nse_securities ADD CONSTRAINT chk_ns_type CHECK (instrument_type IN ('STOCK','ETF','OTHER'))`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE nse_securities DROP COLUMN IF EXISTS instrument_type`);
  }
}
