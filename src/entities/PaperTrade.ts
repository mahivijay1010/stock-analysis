import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from "typeorm";
import { PaperAccount, NumericTransformer } from "./PaperAccount";
import type { EntryContextSnapshot } from "../types";

/**
 * PaperTrade (Module V2-D) — one lot in the admin paper-trading desk.
 *
 * BUY creates an OPEN lot. SELL closes/reduces the oldest OPEN lots (FIFO):
 * a fully sold lot flips to CLOSED with exitPrice/exitAt/realizedPnl (net of
 * fees); a partially sold lot is split — the sold part becomes a CLOSED row
 * (inheriting the lot's entry_context). All money columns are nullable-safe
 * decimals.
 *
 * V10 B4 — `entry_context` (nullable jsonb): what the system believed at BUY
 * time ({quantScore, masterScore, entryTimingScore, intelligenceQuality,
 * regime}), snapshotted ONLY from values already computed in the buy path.
 * Nullable extension of the existing table — no new table.
 */
@Entity("paper_trades")
@Index(["accountId", "status"])
@Index(["ticker", "status"])
export class PaperTrade {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "account_id", type: "uuid" })
  accountId: string;

  @ManyToOne(() => PaperAccount, { onDelete: "CASCADE" })
  @JoinColumn({ name: "account_id" })
  account?: PaperAccount;

  @Column({ type: "varchar", length: 20 })
  ticker: string;

  @Column({ type: "varchar", length: 255, nullable: true })
  name?: string | null;

  @Column({ type: "varchar", length: 4 })
  side: "BUY" | "SELL";

  @Column({ type: "int" })
  qty: number;

  @Column({
    type: "decimal",
    precision: 14,
    scale: 4,
    transformer: new NumericTransformer(),
  })
  price: number;

  @Column({
    type: "decimal",
    precision: 14,
    scale: 4,
    transformer: new NumericTransformer(),
  })
  fees: number;

  @Column({ name: "executed_at", type: "timestamptz" })
  executedAt: Date;

  @Column({ type: "varchar", length: 10 })
  status: "OPEN" | "CLOSED";

  @Column({
    name: "stop_loss",
    type: "decimal",
    precision: 14,
    scale: 4,
    nullable: true,
    transformer: new NumericTransformer(),
  })
  stopLoss?: number | null;

  @Column({
    type: "decimal",
    precision: 14,
    scale: 4,
    nullable: true,
    transformer: new NumericTransformer(),
  })
  target?: number | null;

  @Column({
    name: "exit_price",
    type: "decimal",
    precision: 14,
    scale: 4,
    nullable: true,
    transformer: new NumericTransformer(),
  })
  exitPrice?: number | null;

  @Column({ name: "exit_at", type: "timestamptz", nullable: true })
  exitAt?: Date | null;

  @Column({
    name: "realized_pnl",
    type: "decimal",
    precision: 14,
    scale: 4,
    nullable: true,
    transformer: new NumericTransformer(),
  })
  realizedPnl?: number | null;

  @Column({ type: "text", nullable: true })
  note?: string | null;

  /** V10 B4 — entry-time factor snapshot (null on pre-V10 rows and SELLs). */
  @Column({ name: "entry_context", type: "jsonb", nullable: true })
  entryContext?: EntryContextSnapshot | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
