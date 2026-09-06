import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index, ManyToOne, JoinColumn } from "typeorm";
import { Instrument } from "./Instrument";

/**
 * InstrumentAlias (Phase B2, spec §11 Instrument/Alias) — effective-dated
 * alternate symbols/names for an instrument (renames like ZOMATO→ETERNAL).
 *
 * A rename is identity-continuous; a demerger is NOT (spec §6). Aliases are
 * only created where continuity is economically correct. The TATAMOTORS→
 * TMCV/TMPV demerger lineage is deliberately NOT an alias (one symbol cannot
 * map to two successors) — it needs the Phase C CorporateAction machinery.
 *
 * effective_from/effective_to are nullable: exact rename dates are recorded
 * only when verified from an authoritative source, never invented.
 */
@Entity("instrument_aliases")
export class InstrumentAlias {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "instrument_id", type: "uuid" })
  instrumentId: string;

  @ManyToOne(() => Instrument, { onDelete: "CASCADE" })
  @JoinColumn({ name: "instrument_id" })
  instrument?: Instrument;

  /** The alias symbol/name being resolved (e.g. "ZOMATO.NS"). */
  @Index({ unique: true })
  @Column({ type: "varchar", length: 60 })
  alias: string;

  /** Date this alias became valid (null = unknown/unverified start). */
  @Column({ name: "effective_from", type: "date", nullable: true })
  effectiveFrom?: string | null;

  /** Date this alias stopped being the live symbol (null = still current or unknown). */
  @Column({ name: "effective_to", type: "date", nullable: true })
  effectiveTo?: string | null;

  @Column({ type: "text", nullable: true })
  note?: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
