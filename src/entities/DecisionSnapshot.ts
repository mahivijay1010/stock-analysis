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
 * DecisionSnapshot (Phase C, spec §9) — one published, IMMUTABLE decision from
 * the canonical DecisionService. Every UI surface reads the SAME snapshot for
 * a given (instrument, asOf), so identical context can never render different
 * advice on different screens (acceptance 13.14). Not touched by the 365-day
 * Analysis cleanup.
 */
@Entity("decision_snapshots")
export class DecisionSnapshot {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "instrument_id", type: "uuid" })
  instrumentId: string;

  @ManyToOne(() => Instrument, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "instrument_id" })
  instrument?: Instrument;

  @Column({ type: "varchar", length: 20 })
  ticker: string;

  @Column({ name: "decision_status", type: "varchar", length: 25 })
  decisionStatus: "BUY_CANDIDATE" | "WAIT" | "AVOID_NEW_ENTRY" | "INSUFFICIENT_EVIDENCE";

  @Column({ name: "evidence_status", type: "varchar", length: 15 })
  evidenceStatus: "VALIDATED" | "PARTIAL" | "INSUFFICIENT";

  @Column({ name: "risk_level", type: "varchar", length: 10 })
  riskLevel: "low" | "medium" | "high" | "unknown";

  /** Product horizon label (spec §9): short ≤30d — the only validated view today. */
  @Column({ name: "intended_horizon", type: "varchar", length: 10 })
  intendedHorizon: "short" | "medium" | "long";

  @Column({ type: "jsonb" })
  reasons: string[];

  @Column({ type: "jsonb" })
  risks: string[];

  /** Separate holdings guidance — never a sell instruction (spec §9). */
  @Column({ name: "holdings_review_note", type: "text" })
  holdingsReviewNote: string;

  /**
   * Risk-character holding-horizon assessment (horizon-policy-v1): label
   * short/moderate/long + measured basis + reasons. Null on snapshots
   * published before the feature or when evidence was insufficient.
   */
  @Column({ name: "horizon_suitability", type: "jsonb", nullable: true })
  horizonSuitability?: Record<string, unknown> | null;

  /**
   * Risk-spec Rule 1 (T1): the separated ScoreCard (setup/entry/risk/data
   * quality/forecast confidence …). Null on pre-T1 snapshots.
   */
  @Column({ name: "score_card", type: "jsonb", nullable: true })
  scoreCard?: Record<string, unknown> | null;

  /** Rule 8: expected value after costs from the stored issuance. Null pre-T1. */
  @Column({ name: "expected_value", type: "jsonb", nullable: true })
  expectedValue?: Record<string, unknown> | null;

  /** Rule 14: the SEPARATE existing-position decision (HOLD/REVIEW/INSUFFICIENT_DATA). */
  @Column({ name: "existing_holder_action", type: "varchar", length: 20, nullable: true })
  existingHolderAction?: "HOLD" | "REVIEW" | "INSUFFICIENT_DATA" | null;

  @Column({ name: "holder_reasons", type: "jsonb", nullable: true })
  holderReasons?: string[] | null;

  /** Rule 17 "What would change the decision?": unmet gates with thresholds. */
  @Column({ name: "unmet_gates", type: "jsonb", nullable: true })
  unmetGates?: Array<{ gate: string; current: string; required: string }> | null;

  /** Inputs the policy saw: issuance ref, measured stats, freshness. Audit trail. */
  @Column({ type: "jsonb" })
  inputs: Record<string, unknown>;

  @Index()
  @Column({ name: "as_of", type: "timestamptz" })
  asOf: Date;

  /** Entry opinions expire (spec §9) — end of the next expected session. */
  @Column({ name: "valid_until", type: "timestamptz" })
  validUntil: Date;

  @Column({ name: "model_version", type: "varchar", length: 40 })
  modelVersion: string;

  @Column({ name: "decision_policy_version", type: "varchar", length: 40 })
  decisionPolicyVersion: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
