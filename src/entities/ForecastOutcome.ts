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
import { ForecastPoint } from "./ForecastPoint";

/**
 * ForecastOutcome (Phase C, spec §5) — the OBSERVATION/EVALUATION side of a
 * forecast point, stored separately so the forecast itself is never rewritten
 * to match reality. Append-only with a revision counter: a later correction
 * (e.g. a re-stated close) appends revision+1; the latest revision wins for
 * display, older revisions remain as the audit trail.
 *
 * state:
 *  - "pending"      — target date not matured or data not yet available
 *  - "verified"     — real close observed; realized return + band hits graded
 *  - "no_session"   — the date turned out to be closed (holiday/closure)
 *  - "missing_data" — session happened (per calendar) but no observation
 *                     could be obtained after the grace window
 */
@Entity("forecast_outcomes")
@Unique("UQ_forecast_outcomes_point_rev", ["pointId", "revision"])
export class ForecastOutcome {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "point_id", type: "uuid" })
  pointId: string;

  @ManyToOne(() => ForecastPoint, { onDelete: "CASCADE" })
  @JoinColumn({ name: "point_id" })
  point?: ForecastPoint;

  @Column({ type: "int", default: 0 })
  revision: number;

  @Column({ type: "varchar", length: 15 })
  state: "pending" | "verified" | "no_session" | "missing_data";

  @Column({ name: "observed_close", type: "numeric", precision: 14, scale: 4, nullable: true })
  observedClose?: string | null;

  /** Actual session date the close belongs to (equals point.targetDate when verified). */
  @Column({ name: "observed_session_date", type: "date", nullable: true })
  observedSessionDate?: string | null;

  @Column({ name: "realized_return_pct", type: "numeric", precision: 9, scale: 4, nullable: true })
  realizedReturnPct?: string | null;

  /** Close inside p10–p90 (the 80% interval)? */
  @Column({ name: "inside_band_80", type: "boolean", nullable: true })
  insideBand80?: boolean | null;

  /** Close inside p05–p95 (the 90% interval)? */
  @Column({ name: "inside_band_90", type: "boolean", nullable: true })
  insideBand90?: boolean | null;

  @Column({ name: "verified_at", type: "timestamptz", nullable: true })
  verifiedAt?: Date | null;

  @Column({ type: "text", nullable: true })
  note?: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
