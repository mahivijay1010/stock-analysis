import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * Instrument (Phase B2, spec §11 Instrument) — canonical instrument identity.
 *
 * The ledger and watchlist reference instruments by this canonical id, NOT by
 * a mutable ticker string (upgrade-audit §5: ticker-string identity silently
 * merges companies when a provider re-keys a symbol). `yahoo_ticker` is the
 * current Yahoo symbol; historical/alternate symbols live in
 * `instrument_aliases` (effective-dated).
 *
 * ISIN is nullable: not obtainable from the free Yahoo endpoints used today —
 * left null rather than fabricated (spec §1: no invented data).
 *
 * The legacy `stocks` table remains the bar-store registry; it is NOT the
 * identity table (plan §2).
 */
@Entity("instruments")
export class Instrument {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index({ unique: true })
  @Column({ name: "yahoo_ticker", type: "varchar", length: 20 })
  yahooTicker: string;

  @Column({ type: "varchar", length: 255 })
  name: string;

  @Column({ type: "varchar", length: 100, nullable: true })
  sector?: string | null;

  @Column({ type: "varchar", length: 12, nullable: true })
  isin?: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
