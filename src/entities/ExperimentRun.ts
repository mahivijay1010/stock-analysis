import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * ExperimentRun (Phase D, spec §8) — one IMMUTABLE evaluation run in the
 * experiment registry. Append-only: every trial is recorded (including
 * failures); nothing is deleted to flatter a model. The untouched final-test
 * discipline is enforced by policy: runs that consumed the holdout say so via
 * usedFinalTest, and repeated retuning against it invalidates promotion.
 */
@Entity("experiment_runs")
export class ExperimentRun {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** Human-readable experiment name, e.g. "baseline-eval-2026-09". */
  @Index()
  @Column({ type: "varchar", length: 120 })
  name: string;

  /** "baseline" | "champion-eval" | "challenger" | "ablation". */
  @Column({ type: "varchar", length: 20 })
  kind: string;

  /** Model identity being evaluated (e.g. "shrunk-drift-v1", "last-price"). */
  @Column({ name: "model_version", type: "varchar", length: 60 })
  modelVersion: string;

  /** Full config: features, hyperparams, seed, flat-price rule, cost model. */
  @Column({ type: "jsonb" })
  config: Record<string, unknown>;

  /** Split definition actually used: boundaries, purge/embargo, date counts. */
  @Column({ type: "jsonb" })
  splits: Record<string, unknown>;

  /** Dataset manifest: tickers, bar spans, row counts + sha256 for reproducibility. */
  @Column({ name: "dataset_manifest", type: "jsonb" })
  datasetManifest: Record<string, unknown>;

  @Column({ name: "dataset_hash", type: "varchar", length: 64 })
  datasetHash: string;

  /** Per-horizon metrics on the segment(s) evaluated (spec §8 report set). */
  @Column({ type: "jsonb", nullable: true })
  metrics?: Record<string, unknown> | null;

  /** Baseline comparisons computed on the SAME segment (constant-50, base-rate, always-up, last-price). */
  @Column({ type: "jsonb", nullable: true })
  baselines?: Record<string, unknown> | null;

  /** Which segments were consumed: e.g. ["validation"] — test only at promotion time. */
  @Column({ name: "segments_used", type: "jsonb" })
  segmentsUsed: string[];

  /** TRUE only for a promotion-gate run; the holdout is spent by such runs. */
  @Column({ name: "used_final_test", type: "boolean", default: false })
  usedFinalTest: boolean;

  @Column({ type: "varchar", length: 12 })
  status: "completed" | "failed";

  @Column({ type: "text", nullable: true })
  error?: string | null;

  @Column({ type: "text", nullable: true })
  notes?: string | null;

  @Column({ name: "started_at", type: "timestamptz" })
  startedAt: Date;

  @Column({ name: "finished_at", type: "timestamptz", nullable: true })
  finishedAt?: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
