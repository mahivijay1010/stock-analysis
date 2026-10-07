import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Paper-trading pilot: a managed portfolio on fake money that runs the full
 * decision flow so the apparatus is finally exercised against reality.
 */
export class CreatePaperPilot1790800000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS paper_pilot_accounts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name varchar(40) NOT NULL UNIQUE,
      starting_capital_inr numeric(16,2) NOT NULL,
      cash_inr numeric(16,2) NOT NULL,
      last_cycle_date date,
      created_at timestamptz NOT NULL DEFAULT now())`);

    await q.query(`CREATE TABLE IF NOT EXISTS paper_pilot_positions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id uuid NOT NULL,
      ticker varchar(20) NOT NULL,
      sector varchar(40),
      status varchar(12) NOT NULL,
      qty int NOT NULL,
      intended_entry numeric(14,2) NOT NULL,
      entry_price numeric(14,2) NOT NULL,
      entry_date date NOT NULL,
      slippage_bps int NOT NULL DEFAULT 0,
      stop numeric(14,2) NOT NULL,
      target numeric(14,2) NOT NULL,
      risk_inr numeric(14,2) NOT NULL,
      conviction_score numeric(6,1),
      exit_price numeric(14,2),
      exit_date date,
      exit_reason varchar(30),
      realized_pnl_inr numeric(16,2),
      realized_r numeric(10,4),
      sizing jsonb,
      created_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_paper_pos_acct_status ON paper_pilot_positions (account_id, status)`);
    // One open position per ticker per account (no pyramiding in the pilot).
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_paper_open_ticker ON paper_pilot_positions (account_id, ticker) WHERE status = 'OPEN'`);

    await q.query(`CREATE TABLE IF NOT EXISTS paper_pilot_equity (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id uuid NOT NULL,
      as_of_date date NOT NULL,
      equity_inr numeric(16,2) NOT NULL,
      cash_inr numeric(16,2) NOT NULL,
      deployed_inr numeric(16,2) NOT NULL,
      open_positions int NOT NULL,
      unrealized_pnl_inr numeric(16,2) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_paper_equity_day ON paper_pilot_equity (account_id, as_of_date)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS paper_pilot_equity`);
    await q.query(`DROP TABLE IF EXISTS paper_pilot_positions`);
    await q.query(`DROP TABLE IF EXISTS paper_pilot_accounts`);
  }
}
