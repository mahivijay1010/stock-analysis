import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * trade_labels — triple-barrier supervised labels (the model training-data
 * foundation). Append-mostly: one row per (ticker, anchor, horizon, version);
 * a re-run under a new label version is a distinct experiment.
 */
export class CreateTradeLabels1790700000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS trade_labels (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ticker varchar(20) NOT NULL,
      anchor_date date NOT NULL,
      horizon_sessions int NOT NULL,
      entry_price numeric(14,4) NOT NULL,
      atr numeric(14,4) NOT NULL,
      upper_mult numeric(6,2) NOT NULL,
      lower_mult numeric(6,2) NOT NULL,
      upper_barrier numeric(14,4) NOT NULL,
      lower_barrier numeric(14,4) NOT NULL,
      label varchar(15) NOT NULL,
      realized_r numeric(12,4),
      conservative_r numeric(12,4),
      mfe_r numeric(12,4),
      mae_r numeric(12,4),
      holding_days int NOT NULL DEFAULT 0,
      ambiguous boolean NOT NULL DEFAULT false,
      feature_hash varchar(64),
      label_version varchar(40) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_trade_labels_ticker_anchor ON trade_labels (ticker, anchor_date DESC)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_trade_labels_label ON trade_labels (label)`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_trade_label_identity ON trade_labels (ticker, anchor_date, horizon_sessions, label_version)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS trade_labels`);
  }
}
