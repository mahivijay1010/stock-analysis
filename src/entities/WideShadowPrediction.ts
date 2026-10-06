import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index, Unique } from "typeorm";

/**
 * wide_shadow_predictions — the sub-₹100 lane's OWN prospective ledger.
 *
 * Deliberately separate from short_term_shadow_predictions: the wide screen
 * runs shadow:false precisely so penny-stock outcomes never feed the radar's
 * live-authority stats (wideScan.ts). This table gives the cheap-stock hunt a
 * measured track record WITHOUT that contamination. Graded by the same
 * simulateBracket engine as every other lane; one row per natural identity
 * (a same-day re-scan is a no-op via .orIgnore()).
 *
 * It also carries the AI scout's dossier (P1): the DeepSeek agent's grounded
 * red-flag analysis and its CAP-ONLY action. finalDecision is the deterministic
 * decision after that cap — never raised above it.
 */
@Entity("wide_shadow_predictions")
@Index(["ticker", "anchorDate"])
@Unique("uq_wide_shadow_identity", ["ticker", "anchorDate", "setupType", "horizon", "modelVersion", "policyVersion", "featureVersion"])
export class WideShadowPrediction {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Column({ type: "varchar", length: 20 }) ticker: string;
  @Column({ type: "varchar", length: 20 }) symbol: string;
  @Column({ name: "anchor_date", type: "date" }) anchorDate: string;
  @Column({ name: "setup_type", type: "varchar", length: 30 }) setupType: string;
  @Column({ type: "varchar", length: 12 }) horizon: string;
  @Column({ name: "model_version", type: "varchar", length: 40 }) modelVersion: string;
  @Column({ name: "policy_version", type: "varchar", length: 40 }) policyVersion: string;
  @Column({ name: "feature_version", type: "varchar", length: 40 }) featureVersion: string;

  /** Deterministic decision as published (BUY/WAIT/WATCH/NO TRADE). */
  @Column({ name: "deterministic_decision", type: "varchar", length: 12 }) deterministicDecision: string;
  /** Deterministic decision AFTER the AI cap — never more aggressive. */
  @Column({ name: "final_decision", type: "varchar", length: 12 }) finalDecision: string;
  @Column({ name: "gates_passed", type: "boolean", default: false }) gatesPassed: boolean;

  @Column({ type: "jsonb" }) plan: Record<string, unknown>;
  /** The exact quantitative evidence shown to the scout (citable, no fabrication). */
  @Column({ name: "screen_evidence", type: "jsonb", nullable: true }) screenEvidence?: Record<string, unknown> | null;
  /** P1 scout output: redFlags[], catalysts[], riskNarrative, capAction, confidence. Null until scouted. */
  @Column({ name: "ai_dossier", type: "jsonb", nullable: true }) aiDossier?: Record<string, unknown> | null;

  /** Resolved outcome from simulateBracket: outcome, realizedNetR, etc. Null until matured. */
  @Column({ type: "jsonb", nullable: true }) outcome?: Record<string, unknown> | null;
  @Column({ name: "resolved_at", type: "timestamptz", nullable: true }) resolvedAt?: Date | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}
