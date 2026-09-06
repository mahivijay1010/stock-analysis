import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { Instrument } from "./Instrument";

/**
 * ForecastRun (Phase C, spec §5) — one IMMUTABLE forecast issuance.
 *
 * Append-only: rows are never updated or deleted by application code.
 * "Latest outlook" is a *new* issuance (higher revision / later issuedAt);
 * the original monthly snapshot (revision 0) never moves. Observations and
 * grading live in forecast_outcomes — reality is never written back here.
 *
 * viewKind:
 *  - "next30" — rolling window: calendar dates after anchor's forecast date
 *               through +30 days inclusive (spec: exact window definition)
 *  - "month"  — calendar-month snapshot for periodKey "YYYY-MM"
 *
 * Uniqueness (partial indexes in the migration):
 *  - next30: one run per (instrument, anchorSessionDate) — same anchor + same
 *    seeded engine = identical output, so re-requests reuse the run
 *  - month:  one run per (instrument, periodKey, revision) — revision 0 is the
 *    original snapshot, refreshes append revision 1, 2, …
 */
@Entity("forecast_runs")
export class ForecastRun {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "instrument_id", type: "uuid" })
  instrumentId: string;

  @ManyToOne(() => Instrument, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "instrument_id" })
  instrument?: Instrument;

  /** Denormalized for stable display even if instrument metadata evolves. */
  @Column({ type: "varchar", length: 20 })
  ticker: string;

  @Column({ name: "view_kind", type: "varchar", length: 10 })
  viewKind: "next30" | "month";

  /** "YYYY-MM" for month runs; null for rolling runs. */
  @Column({ name: "period_key", type: "varchar", length: 7, nullable: true })
  periodKey?: string | null;

  /** 0 = original snapshot; >0 = later "latest outlook" issuances. */
  @Column({ type: "int", default: 0 })
  revision: number;

  @Column({ name: "issued_at", type: "timestamptz" })
  issuedAt: Date;

  /** Timestamp of the newest input datum used (last bar close time proxy). */
  @Column({ name: "feature_cutoff_at", type: "timestamptz" })
  featureCutoffAt: Date;

  /** Last COMPLETED session the forecast is anchored on (horizons count from here). */
  @Column({ name: "anchor_session_date", type: "date" })
  anchorSessionDate: string;

  @Column({ name: "anchor_price", type: "numeric", precision: 14, scale: 4 })
  anchorPrice: string;

  @Column({ name: "price_basis", type: "varchar", length: 12, default: "close" })
  priceBasis: string;

  @Column({ name: "model_version", type: "varchar", length: 40 })
  modelVersion: string;

  @Column({ name: "calibration_version", type: "varchar", length: 40 })
  calibrationVersion: string;

  @Column({ name: "policy_version", type: "varchar", length: 40 })
  policyVersion: string;

  /** Engine inputs: bar span/count, return-pool size, paths, seed, steps. */
  @Column({ name: "input_manifest", type: "jsonb" })
  inputManifest: Record<string, unknown>;

  /** sha256 over the manifest + every (date, close) pair used. */
  @Column({ name: "input_hash", type: "varchar", length: 64 })
  inputHash: string;

  /** Exact calendar window covered (inclusive), IST dates. */
  @Column({ name: "window_start", type: "date" })
  windowStart: string;

  @Column({ name: "window_end", type: "date" })
  windowEnd: string;

  /** Resolved expected target sessions inside the window at issuance time. */
  @Column({ name: "target_session_count", type: "int" })
  targetSessionCount: number;

  @Column({ type: "text", nullable: true })
  notes?: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
