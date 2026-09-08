import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * CalibratorRecord (completion directive, Phase 7) — append-only registry of
 * every calibrator fit, promoted or not. A calibrator only ever reaches the
 * product when `promoted` is true (held-out Brier improved, ECE not degraded,
 * enough effective samples); the latest promoted row per (model, horizon)
 * wins. Verdicts for rejected fits are kept — negative results are results.
 */
@Entity("calibrators")
export class CalibratorRecord {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "model_name", type: "varchar", length: 60 })
  modelName: string;

  @Column({ name: "horizon_days", type: "int" })
  horizonDays: number;

  /** platt | isotonic | beta — null when nothing was credible. */
  @Column({ name: "calibrator_type", type: "varchar", length: 12, nullable: true })
  calibratorType?: string | null;

  @Column({ type: "varchar", length: 20, nullable: true })
  version?: string | null;

  @Column({ type: "jsonb", nullable: true })
  params?: Record<string, unknown> | null;

  @Column({ name: "training_start", type: "date", nullable: true })
  trainingStart?: string | null;

  @Column({ name: "training_end", type: "date", nullable: true })
  trainingEnd?: string | null;

  @Column({ name: "effective_samples", type: "int" })
  effectiveSamples: number;

  @Column({ name: "brier_before", type: "numeric", precision: 8, scale: 4 })
  brierBefore: string;

  @Column({ name: "brier_after", type: "numeric", precision: 8, scale: 4, nullable: true })
  brierAfter?: string | null;

  @Column({ name: "ece_before", type: "numeric", precision: 8, scale: 4 })
  eceBefore: string;

  @Column({ name: "ece_after", type: "numeric", precision: 8, scale: 4, nullable: true })
  eceAfter?: string | null;

  @Column({ type: "boolean", default: false })
  promoted: boolean;

  @Column({ type: "text" })
  verdict: string;

  @Column({ name: "experiment_run_id", type: "uuid", nullable: true })
  experimentRunId?: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
