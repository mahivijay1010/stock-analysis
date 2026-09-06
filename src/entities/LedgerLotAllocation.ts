import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { LedgerTransaction } from "./LedgerTransaction";

/**
 * LotAllocation (Phase B2, spec §11 Transaction/LotAllocation) — the stored
 * FIFO audit trail of a SELL: which BUY lots it consumed, the exact cost
 * basis allocated out of each lot, and the realized P&L attributed to it.
 *
 * Allocations are computed ONCE inside the sell's DB transaction with the
 * decimal.js largest-remainder split (Σ allocated_cost ≡ sold basis,
 * Σ realized_pnl ≡ total realized) and are STORED, never recomputed
 * (plan §2). Ledger replay consumes these stored rows so historical FIFO
 * outcomes can never drift, even after backdated purchases.
 */
@Entity("lot_allocations")
export class LedgerLotAllocation {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "sell_txn_id", type: "uuid" })
  sellTxnId: string;

  @ManyToOne(() => LedgerTransaction, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "sell_txn_id" })
  sellTxn?: LedgerTransaction;

  @Index()
  @Column({ name: "buy_txn_id", type: "uuid" })
  buyTxnId: string;

  @ManyToOne(() => LedgerTransaction, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "buy_txn_id" })
  buyTxn?: LedgerTransaction;

  /** Shares taken from this lot (in the lot's then-current split-adjusted units). */
  @Column({ type: "numeric", precision: 18, scale: 4 })
  qty: string;

  /** Cost basis (incl. its purchase-charge share) allocated to this sale. */
  @Column({ name: "allocated_cost", type: "numeric", precision: 16, scale: 4 })
  allocatedCost: string;

  /** Net-proceeds share − allocated_cost for this lot slice. */
  @Column({ name: "realized_pnl", type: "numeric", precision: 16, scale: 4 })
  realizedPnl: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
