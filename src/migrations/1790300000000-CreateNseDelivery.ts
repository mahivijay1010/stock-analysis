import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * nse_delivery — NSE "sec_bhavdata_full" daily rows (EQ series): traded and
 * DELIVERED quantity, number of trades, turnover. Source:
 * nsearchives.nseindia.com/products/content/sec_bhavdata_full_DDMMYYYY.csv.
 *
 * This is information the price panel never had: how much of a day's volume
 * was taken into delivery (vs intraday churn) and the average trade size. It
 * is point-in-time by construction — NSE publishes the file after the close
 * of trade_date, so a signal formed at that close may use it.
 *
 * Prices here are UNADJUSTED (exchange prints); returns must come from
 * stock_history.adjusted_close. Kept for every EQ symbol, not just the
 * current universe, so a small/mid-cap study stays possible later.
 */
export class CreateNseDelivery1790300000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS nse_delivery (
      symbol varchar(40) NOT NULL,
      trade_date date NOT NULL,
      series varchar(4) NOT NULL,
      close_price numeric(14,4),
      traded_qty bigint,
      turnover_lacs numeric(18,4),
      no_of_trades bigint,
      deliv_qty bigint,
      deliv_pct numeric(7,2),
      source_file varchar(60) NOT NULL,
      fetched_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (symbol, trade_date, series)
    )`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_nse_delivery_date ON nse_delivery (trade_date)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS nse_delivery`);
  }
}
