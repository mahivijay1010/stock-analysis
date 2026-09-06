import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { Account } from "./Account";
import { Instrument } from "./Instrument";

export type LedgerTransactionType =
  | "BUY"
  | "SELL"
  | "DIVIDEND"
  | "SPLIT"
  | "BONUS"
  | "CHARGE_ADJUST";

/**
 * LedgerTransaction (Phase B2, spec §3/§4/§11) — the immutable product ledger.
 *
 * Rows are NEVER updated or deleted; corrections are separate reversal rows
 * linked via `corrects_id` (UNIQUE — a transaction can be corrected once).
 * Positions are DERIVED by replaying this ledger (plan §2: derive-only, no
 * editable aggregate). All money columns are NUMERIC and are read as strings,
 * then handled by the decimal.js money module — never parseFloat.
 *
 * Field semantics by type (documented contract, enforced by LedgerService):
 *  - BUY/SELL:  qty = share count (integral for ordinary trades),
 *               price = per-share execution price (₹),
 *               gross_amount = qty × price (exact at scale 4),
 *               charges = separately recorded transaction charges (₹).
 *  - DIVIDEND:  gross_amount = total cash received (₹); qty/price optionally
 *               record shares × per-share amount. NOT netted into cost basis.
 *  - SPLIT:     qty = ratio numerator, price = ratio denominator
 *               (2-for-1 split → qty=2, price=1). Total basis unchanged.
 *  - BONUS:     qty:price = bonus ratio (qty new shares per price held).
 *               Total basis unchanged.
 *  - CHARGE_ADJUST: gross_amount = signed charge adjustment (₹), tracked
 *               separately; never rewrites lot basis.
 *
 * `is_estimated_price` marks a price the user explicitly confirmed as a
 * closing-price substitute for an unknown execution price (spec §3).
 */
@Entity("ledger_transactions")
@Index("IDX_ledger_account_instrument_date", ["accountId", "instrumentId", "tradeDate"])
export class LedgerTransaction {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "account_id", type: "uuid" })
  accountId: string;

  @ManyToOne(() => Account, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "account_id" })
  account?: Account;

  @Column({ name: "instrument_id", type: "uuid" })
  instrumentId: string;

  @ManyToOne(() => Instrument, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "instrument_id" })
  instrument?: Instrument;

  @Column({ type: "varchar", length: 14 })
  type: LedgerTransactionType;

  /** Executed date (IST product date). Backdating allowed; future dates rejected. */
  @Column({ name: "trade_date", type: "date" })
  tradeDate: string;

  /** NUMERIC → string; integral share policy enforced in the service layer. */
  @Column({ type: "numeric", precision: 18, scale: 4, nullable: true })
  qty?: string | null;

  @Column({ type: "numeric", precision: 14, scale: 4, nullable: true })
  price?: string | null;

  @Column({ name: "gross_amount", type: "numeric", precision: 16, scale: 4, nullable: true })
  grossAmount?: string | null;

  @Column({ type: "numeric", precision: 14, scale: 4, default: 0 })
  charges: string;

  @Column({ name: "is_estimated_price", type: "boolean", default: false })
  isEstimatedPrice: boolean;

  @Column({ type: "text", nullable: true })
  note?: string | null;

  /** Set on a REVERSAL row: the id of the immutable original it voids. */
  @Column({ name: "corrects_id", type: "uuid", nullable: true, unique: true })
  correctsId?: string | null;

  /** Client idempotency key (imports/replays); UNIQUE where present. */
  @Column({ name: "idempotency_key", type: "varchar", length: 120, nullable: true, unique: true })
  idempotencyKey?: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
