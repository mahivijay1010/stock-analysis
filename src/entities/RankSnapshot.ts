import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * V8 R1 — daily cross-sectional rank snapshot (one row per ticker per day).
 *
 * Written after the 08:45 IST scan (and idempotently by on-demand rank
 * builds). These rows are the raw material for the MEASURED rank IC:
 * Spearman(composite, realized forward 30d return) becomes computable only
 * once snapshots mature — it is NEVER simulated from backfilled ranks.
 */
@Entity("rank_snapshots")
@Index(["date"])
@Index(["date", "ticker"], { unique: true })
export class RankSnapshot {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "date" })
  date: Date; // YYYY-MM-DD (IST) the snapshot was taken for

  @Column({ type: "varchar", length: 20 })
  ticker: string;

  @Column({ type: "double precision" })
  composite: number;

  /** Clamped z-scores + per-component data status (nullable-safe jsonb). */
  @Column({ type: "jsonb", nullable: true })
  components?: {
    momentum: number;
    quality: number;
    sentiment: number;
    status?: { momentum: string; quality: string; sentiment: string };
    qualitySource?: string | null;
  };

  @Column({ type: "double precision" })
  percentile: number;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
