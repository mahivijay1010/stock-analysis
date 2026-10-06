import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Wide-universe master + per-stock knowledge base.
 *
 * nse_securities — every NSE EQ symbol (EQUITY_L.csv) with the industry label
 * NSE assigns in its index constituent files and which broad indices hold it.
 * This is the universe the sub-₹100 screen runs over: ~2,700 symbols, not the
 * 152 in NSE_UNIVERSE.
 *
 * stock_knowledge — sourced facts about a stock gathered from outside the
 * price panel (exchange surveillance status, index membership, news, filings,
 * web research). Every row carries its source URL and when it was observed,
 * so a report can cite it and a reader can check it. Rows are append-only:
 * a newer observation is a new row, never an edit — knowledge has a date.
 *
 * Nothing here is a signal. Facts inform the written report and the AI
 * critic; whether any of it predicts returns is a separate, pre-registered
 * question (docs/stock-selection-preregistration.md discipline).
 */
export class CreateWideUniverseKnowledge1790400000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS nse_securities (
      symbol varchar(40) PRIMARY KEY,
      company_name varchar(200) NOT NULL,
      isin varchar(20),
      listing_date date,
      face_value numeric(10,2),
      industry varchar(80),
      indices text[] NOT NULL DEFAULT '{}',
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);

    await q.query(`CREATE TABLE IF NOT EXISTS stock_knowledge (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      symbol varchar(40) NOT NULL,
      kind varchar(40) NOT NULL,
      fact text NOT NULL,
      detail jsonb,
      source_kind varchar(30) NOT NULL,
      source_url text,
      observed_at date NOT NULL,
      confidence varchar(10) NOT NULL DEFAULT 'MEDIUM',
      fetched_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT chk_sk_source CHECK (source_kind IN ('EXCHANGE','FILING','NEWS','WEB','MODEL')),
      CONSTRAINT chk_sk_conf CHECK (confidence IN ('HIGH','MEDIUM','LOW'))
    )`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_sk_symbol_kind ON stock_knowledge (symbol, kind, observed_at DESC)`);
    await q.query(`DROP TRIGGER IF EXISTS trg_stock_knowledge_immutable ON stock_knowledge`);
    await q.query(
      `CREATE TRIGGER trg_stock_knowledge_immutable BEFORE UPDATE OR DELETE ON stock_knowledge FOR EACH ROW EXECUTE FUNCTION reject_live_history_mutation()`
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS trg_stock_knowledge_immutable ON stock_knowledge`);
    await q.query(`DROP TABLE IF EXISTS stock_knowledge`);
    await q.query(`DROP TABLE IF EXISTS nse_securities`);
  }
}
