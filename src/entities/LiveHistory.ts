import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from "typeorm";

/**
 * Realtime V1 append-only history (reviewer priority 2). Every 10-minute
 * evaluation writes a NEW LivePredictionRevision — nothing is ever updated in
 * place, so the full evolution of a view is preserved:
 *   09:20 #1 → 09:30 #2 → 09:40 #3 …
 * A DB trigger (see migration) rejects UPDATE/DELETE.
 *
 * This dataset is the prospective evidence that decides whether the realtime
 * engine ever earns authority over the EOD engine — it is treated as immutable.
 */
@Entity("live_prediction_revisions")
@Index(["ticker", "evaluatedAt"])
// One revision per ticker per checkpoint per version-set — a re-run is idempotent.
@Unique("uq_live_revision", ["ticker", "evaluatedAt", "modelVersion", "featureVersion", "policyVersion"])
export class LivePredictionRevision {
  @PrimaryGeneratedColumn("uuid") id: string;

  @Column({ type: "varchar", length: 20 }) ticker: string;
  @Column({ name: "evaluated_at", type: "timestamptz" }) evaluatedAt: Date;

  /** Chain to the prior revision for this ticker — the append-only lineage. */
  @Column({ name: "previous_revision_id", type: "uuid", nullable: true }) previousRevisionId?: string | null;

  /** Provenance links: the market reading and (when sealed) the decision. */
  @Column({ name: "market_snapshot_id", type: "uuid", nullable: true }) marketSnapshotId?: string | null;
  @Column({ name: "decision_snapshot_id", type: "uuid", nullable: true }) decisionSnapshotId?: string | null;

  /** Hash-pinned evidence for THIS revision (canonical hashes; immutable). */
  @Column({ name: "context_hash", type: "varchar", length: 64 }) contextHash: string;
  @Column({ name: "delta_hash", type: "varchar", length: 64, nullable: true }) deltaHash?: string | null;

  @Column({ type: "varchar", length: 25 }) assessment: string; // LiveAssessment
  @Column({ name: "setup_state", type: "varchar", length: 30 }) setupState: string;

  @Column({ name: "expected_r", type: "numeric", precision: 10, scale: 4, nullable: true }) expectedR?: string | null;
  @Column({ name: "expected_r_lower_bound", type: "numeric", precision: 10, scale: 4, nullable: true }) expectedRLowerBound?: string | null;

  @Column({ name: "entry_quality", type: "varchar", length: 10 }) entryQuality: string;
  @Column({ name: "risk_state", type: "varchar", length: 12 }) riskState: string;

  @Column({ name: "data_quality", type: "varchar", length: 12 }) dataQuality: string;
  @Column({ name: "data_mode", type: "varchar", length: 20 }) dataMode: string; // SCRAPED_SNAPSHOT | DELAYED_CANDLES | INTRADAY_CANDLES | STREAMING
  /** Deterministic gate action AFTER the mode ceiling cap. */
  @Column({ type: "varchar", length: 25 }) gate: string;

  @Column({ name: "opportunity_rank", type: "int", nullable: true }) opportunityRank?: number | null;
  @Column({ name: "actionable_rank", type: "int", nullable: true }) actionableRank?: number | null;

  @Column({ name: "model_version", type: "varchar", length: 40 }) modelVersion: string;
  @Column({ name: "feature_version", type: "varchar", length: 40 }) featureVersion: string;
  @Column({ name: "policy_version", type: "varchar", length: 40 }) policyVersion: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}

/**
 * A discrete state TRANSITION (reviewer priority 2). Distinct from a revision:
 * a revision is written every checkpoint; an event is written only when the
 * live state actually changes (WATCH → ENTRY_APPROACHING, etc.), carrying the
 * trigger and the grounded evidence ids that justified it. Append-only.
 */
@Entity("live_decision_events")
@Index(["ticker", "occurredAt"])
export class LiveDecisionEvent {
  @PrimaryGeneratedColumn("uuid") id: string;

  @Column({ type: "varchar", length: 20 }) ticker: string;
  @Column({ name: "occurred_at", type: "timestamptz" }) occurredAt: Date;

  @Column({ name: "from_state", type: "varchar", length: 30 }) fromState: string;
  @Column({ name: "to_state", type: "varchar", length: 30 }) toState: string;

  @Column({ type: "varchar", length: 40 }) trigger: string; // materiality reason code
  @Column({ name: "evidence_ids", type: "jsonb", nullable: true }) evidenceIds?: string[] | null;

  @Column({ name: "prediction_revision_id", type: "uuid", nullable: true }) predictionRevisionId?: string | null;
  @Column({ name: "decision_snapshot_id", type: "uuid", nullable: true }) decisionSnapshotId?: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}
