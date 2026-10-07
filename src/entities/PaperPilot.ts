import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * The paper-trading pilot: one account that runs the FULL decision flow on fake
 * money so the apparatus is finally exercised against reality — timing, fills,
 * slippage, gaps, position management — and generates the prospective track
 * record every safety layer is starving for. Separate from the admin paper desk
 * and from the shadow ledgers: this is a managed PORTFOLIO with capital.
 */
@Entity("paper_pilot_accounts")
export class PaperPilotAccount {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Column({ type: "varchar", length: 40, unique: true }) name: string;
  @Column({ name: "starting_capital_inr", type: "numeric", precision: 16, scale: 2 }) startingCapitalInr: string;
  @Column({ name: "cash_inr", type: "numeric", precision: 16, scale: 2 }) cashInr: string;
  @Column({ name: "last_cycle_date", type: "date", nullable: true }) lastCycleDate?: string | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}

@Entity("paper_pilot_positions")
@Index(["accountId", "status"])
export class PaperPilotPosition {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Column({ name: "account_id", type: "uuid" }) accountId: string;
  @Column({ type: "varchar", length: 20 }) ticker: string;
  @Column({ type: "varchar", length: 40, nullable: true }) sector?: string | null;
  @Column({ type: "varchar", length: 12 }) status: string; // OPEN | CLOSED

  @Column({ type: "int" }) qty: number;
  @Column({ name: "intended_entry", type: "numeric", precision: 14, scale: 2 }) intendedEntry: string;
  @Column({ name: "entry_price", type: "numeric", precision: 14, scale: 2 }) entryPrice: string;
  @Column({ name: "entry_date", type: "date" }) entryDate: string;
  @Column({ name: "slippage_bps", type: "int", default: 0 }) slippageBps: number;
  @Column({ type: "numeric", precision: 14, scale: 2 }) stop: string;
  @Column({ type: "numeric", precision: 14, scale: 2 }) target: string;
  @Column({ name: "risk_inr", type: "numeric", precision: 14, scale: 2 }) riskInr: string;
  @Column({ name: "conviction_score", type: "numeric", precision: 6, scale: 1, nullable: true }) convictionScore?: string | null;

  @Column({ name: "exit_price", type: "numeric", precision: 14, scale: 2, nullable: true }) exitPrice?: string | null;
  @Column({ name: "exit_date", type: "date", nullable: true }) exitDate?: string | null;
  @Column({ name: "exit_reason", type: "varchar", length: 30, nullable: true }) exitReason?: string | null;
  @Column({ name: "realized_pnl_inr", type: "numeric", precision: 16, scale: 2, nullable: true }) realizedPnlInr?: string | null;
  @Column({ name: "realized_r", type: "numeric", precision: 10, scale: 4, nullable: true }) realizedR?: string | null;

  @Column({ type: "jsonb", nullable: true }) sizing?: Record<string, unknown> | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}

@Entity("paper_pilot_equity")
@Index(["accountId", "asOfDate"])
export class PaperPilotEquity {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Column({ name: "account_id", type: "uuid" }) accountId: string;
  @Column({ name: "as_of_date", type: "date" }) asOfDate: string;
  @Column({ name: "equity_inr", type: "numeric", precision: 16, scale: 2 }) equityInr: string;
  @Column({ name: "cash_inr", type: "numeric", precision: 16, scale: 2 }) cashInr: string;
  @Column({ name: "deployed_inr", type: "numeric", precision: 16, scale: 2 }) deployedInr: string;
  @Column({ name: "open_positions", type: "int" }) openPositions: number;
  @Column({ name: "unrealized_pnl_inr", type: "numeric", precision: 16, scale: 2 }) unrealizedPnlInr: string;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}
