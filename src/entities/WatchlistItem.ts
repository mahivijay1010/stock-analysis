import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
  Unique,
} from "typeorm";
import { Account } from "./Account";
import { Instrument } from "./Instrument";

/**
 * WatchlistItem (Phase B2, spec §3/§11) — "I follow this stock". Requires no
 * purchase and NEVER creates P&L. Removing a watchlist item must never touch
 * holdings or ledger history (spec §13.1).
 *
 * NEW table `watchlist_items`: the dead legacy `watchlists` jsonb-blob table
 * (0 rows, unreferenced) is left untouched (plan §2 — per-item rows, not a
 * tickers[] array).
 */
@Entity("watchlist_items")
@Unique("UQ_watchlist_account_instrument", ["accountId", "instrumentId"])
export class WatchlistItem {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "account_id", type: "uuid" })
  accountId: string;

  @ManyToOne(() => Account, { onDelete: "CASCADE" })
  @JoinColumn({ name: "account_id" })
  account?: Account;

  @Column({ name: "instrument_id", type: "uuid" })
  instrumentId: string;

  @ManyToOne(() => Instrument, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "instrument_id" })
  instrument?: Instrument;

  @Column({ type: "text", nullable: true })
  notes?: string | null;

  /** Product horizon labels (spec §9): short ≤30d, medium 31–365d, long >365d. */
  @Column({ type: "varchar", length: 10 })
  horizon: "short" | "medium" | "long";

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
