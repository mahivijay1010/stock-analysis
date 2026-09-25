import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index, ManyToOne, JoinColumn } from "typeorm";
import { DecisionSnapshot } from "./DecisionSnapshot";

/**
 * decision_outcome_ledger — Lane C's graded track record, one APPEND-ONLY row
 * per (published DecisionSnapshot, grader version). This is the table the
 * Evidence tab was missing: prediction_logs grades the legacy quant engine,
 * while the gate that actually decides live recommendations had no ledger.
 * A regrade under a new grader version writes a NEW row; nothing is ever
 * edited (DB trigger enforced, same admin GUC as decision_snapshots).
 */
@Entity("decision_outcome_ledger")
export class DecisionOutcomeLedger {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "snapshot_id", type: "uuid" })
  snapshotId: string;

  @ManyToOne(() => DecisionSnapshot, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "snapshot_id" })
  snapshot?: DecisionSnapshot;

  @Column({ name: "instrument_id", type: "uuid" })
  instrumentId: string;

  @Index()
  @Column({ type: "varchar", length: 20 })
  ticker: string;

  @Column({ name: "decision_status", type: "varchar", length: 25 })
  decisionStatus: "BUY_CANDIDATE" | "WAIT" | "AVOID_NEW_ENTRY" | "INSUFFICIENT_EVIDENCE";

  /** Snapshot publication instant (for latest-per-day dedupe in aggregates). */
  @Column({ name: "as_of", type: "timestamptz" })
  asOf: Date;

  /** IST date of the anchor bar the decision was graded against. */
  @Column({ name: "as_of_date", type: "date" })
  asOfDate: string;

  @Column({ name: "horizon_days", type: "int" })
  horizonDays: number;

  @Column({ name: "grader_version", type: "varchar", length: 40 })
  graderVersion: string;

  @Column({ name: "outcome_status", type: "varchar", length: 20 })
  outcomeStatus: "GRADED" | "TRUNCATED" | "ENTRY_UNAVAILABLE" | "DATA_INVALID";

  @Column({ name: "entry_date", type: "date", nullable: true })
  entryDate: string | null;

  @Column({ name: "terminal_date", type: "date", nullable: true })
  terminalDate: string | null;

  @Column({ name: "sessions_observed", type: "int" })
  sessionsObserved: number;

  /** Anchor close → terminal close (adjusted, gross) — grades the claim. */
  @Column({ name: "claim_gross_return_pct", type: "numeric", precision: 10, scale: 4, nullable: true })
  claimGrossReturnPct: string | null;

  /** Next-session open → terminal close (adjusted) — what a trader could get. */
  @Column({ name: "tradeable_gross_return_pct", type: "numeric", precision: 10, scale: 4, nullable: true })
  tradeableGrossReturnPct: string | null;

  @Column({ name: "tradeable_net_return_pct", type: "numeric", precision: 10, scale: 4, nullable: true })
  tradeableNetReturnPct: string | null;

  @Column({ name: "cost_pct", type: "numeric", precision: 8, scale: 4, nullable: true })
  costPct: string | null;

  @Column({ name: "entry_gap_pct", type: "numeric", precision: 8, scale: 4, nullable: true })
  entryGapPct: string | null;

  /** Null for WAIT / INSUFFICIENT_EVIDENCE — an abstention has no hit. */
  @Column({ name: "direction_hit", type: "boolean", nullable: true })
  directionHit: boolean | null;

  @Column({ name: "within_band80", type: "boolean", nullable: true })
  withinBand80: boolean | null;

  @Column({ name: "ev_error_pct", type: "numeric", precision: 10, scale: 4, nullable: true })
  evErrorPct: string | null;

  /** What the snapshot claimed (evAfterCostsPct, p10/p90 return band, cost model). */
  @Column({ type: "jsonb" })
  claims: Record<string, unknown>;

  @Column({ type: "jsonb" })
  flags: string[];

  @CreateDateColumn({ name: "graded_at", type: "timestamptz" })
  gradedAt: Date;
}
