import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from "typeorm";

/**
 * V9 E3 — nightly Kelly-drift snapshot (one row per IST date, upserted by the
 * evening cron after the verify job, and manually by scripts/recordKellyDrift.ts).
 *
 * Tracks how the ADAPTED half-Kelly evolves as the desk's closed-trade history
 * grows: measured_p / measured_b are the last-30-window measurements (null
 * while unmeasurable), half_kelly_pct is computed from the APPLIED pair and
 * `applied` says which sources were live that day. Nullable-safe — nothing is
 * ever invented to fill a column.
 */
@Entity("kelly_drift")
export class KellyDrift {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** YYYY-MM-DD (IST) the snapshot was taken for — one row per day. */
  @Column({ type: "date", unique: true })
  date: string;

  @Column({ name: "closed_trades", type: "int" })
  closedTrades: number;

  @Column({ name: "measured_p", type: "double precision", nullable: true })
  measuredP?: number | null;

  @Column({ name: "measured_b", type: "double precision", nullable: true })
  measuredB?: number | null;

  @Column({ name: "half_kelly_pct", type: "double precision", nullable: true })
  halfKellyPct?: number | null;

  /** Which (p, b) sources were applied, e.g. 'measured-p+measured-b'. */
  @Column({ type: "varchar", length: 40 })
  applied: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
