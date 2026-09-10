import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from "typeorm";

/** Short-Term Trade Radar entities (S1/S8/S9). Scan/candidate/transition rows are append-only. */

@Entity("short_term_scan_runs")
export class ShortTermScanRun {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Column({ type: "jsonb" }) params: Record<string, unknown>;
  @Column({ name: "universe_size", type: "int" }) universeSize: number;
  @Column({ name: "passed_gates", type: "int" }) passedGates: number;
  @Column({ name: "qualified_shown", type: "int" }) qualifiedShown: number;
  @Column({ name: "model_version", type: "varchar", length: 40 }) modelVersion: string;
  @Column({ name: "feature_version", type: "varchar", length: 40 }) featureVersion: string;
  @Column({ name: "policy_version", type: "varchar", length: 40 }) policyVersion: string;
  @Column({ name: "data_provider", type: "varchar", length: 60 }) dataProvider: string;
  @Column({ name: "data_freshness", type: "varchar", length: 12 }) dataFreshness: string;
  @Column({ name: "data_timestamp", type: "timestamptz", nullable: true }) dataTimestamp?: Date | null;
  @Column({ type: "jsonb", nullable: true }) diagnostics?: Record<string, unknown> | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}

@Entity("short_term_candidates")
@Index(["ticker", "createdAt"])
export class ShortTermCandidate {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index() @Column({ name: "scan_run_id", type: "uuid" }) scanRunId: string;
  @Column({ type: "varchar", length: 20 }) ticker: string;
  @Column({ type: "varchar", length: 30 }) state: string;
  @Column({ type: "varchar", length: 30 }) action: string;
  @Column({ name: "setup_type", type: "varchar", length: 30 }) setupType: string;
  @Column({ name: "rank", type: "int", nullable: true }) rank?: number | null;
  @Column({ name: "ranking_score", type: "numeric", precision: 10, scale: 2, nullable: true }) rankingScore?: string | null;
  @Column({ name: "passed_gates", type: "boolean" }) passedGates: boolean;
  @Column({ type: "jsonb" }) payload: Record<string, unknown>; // full candidate view (plan, forecast, gates, features summary)
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}

@Entity("short_term_signal_transitions")
@Index(["ticker", "createdAt"])
export class ShortTermTransition {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Column({ type: "varchar", length: 20 }) ticker: string;
  @Column({ name: "from_state", type: "varchar", length: 30 }) fromState: string;
  @Column({ name: "to_state", type: "varchar", length: 30 }) toState: string;
  @Column({ type: "text" }) reason: string;
  @Column({ name: "scan_run_id", type: "uuid", nullable: true }) scanRunId?: string | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}

@Entity("short_term_shadow_predictions")
@Index(["ticker", "anchorDate"])
// One prospective observation per natural identity (reviewer P0 #2). Backs the
// `.orIgnore()` insert so a same-session re-scan is a no-op, not a duplicate.
// The identity spans ALL THREE version axes that change what the prediction
// MEANS — model, decision policy, and setup/feature definition — so a
// legitimate re-run under a bumped policy/setup is a distinct experiment and is
// NOT silently suppressed. (The snapshot branch will replace this composite
// with a single decision_snapshot_id anchor.)
@Unique("uq_shadow_identity", ["ticker", "anchorDate", "setupType", "horizon", "modelVersion", "policyVersion", "featureVersion"])
export class ShortTermShadowPrediction {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Column({ type: "varchar", length: 20 }) ticker: string;
  @Column({ name: "anchor_date", type: "date" }) anchorDate: string;
  @Column({ name: "setup_type", type: "varchar", length: 30 }) setupType: string;
  @Column({ type: "varchar", length: 12 }) horizon: string;
  @Column({ name: "model_version", type: "varchar", length: 40 }) modelVersion: string;
  @Column({ name: "policy_version", type: "varchar", length: 40, default: "st-policy-v1" }) policyVersion: string;
  @Column({ name: "feature_version", type: "varchar", length: 40, default: "st-features-v1" }) featureVersion: string;
  @Column({ type: "jsonb" }) plan: Record<string, unknown>;
  @Column({ type: "jsonb" }) forecast: Record<string, unknown>;
  /** Resolved outcome: TARGET_FIRST | STOP_FIRST | TIMEOUT (+ realized numbers). */
  @Column({ type: "jsonb", nullable: true }) outcome?: Record<string, unknown> | null;
  @Column({ name: "resolved_at", type: "timestamptz", nullable: true }) resolvedAt?: Date | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}

@Entity("short_term_paper_trades")
@Index(["ticker", "createdAt"])
export class ShortTermPaperTrade {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Column({ type: "varchar", length: 20 }) ticker: string;
  @Column({ type: "varchar", length: 12 }) horizon: string;
  @Column({ name: "setup_type", type: "varchar", length: 30 }) setupType: string;
  @Column({ type: "varchar", length: 20 }) status: string; // PENDING_ENTRY | OPEN | CLOSED | CANCELLED
  @Column({ type: "jsonb" }) plan: Record<string, unknown>;
  @Column({ name: "entry_price", type: "numeric", precision: 14, scale: 2, nullable: true }) entryPrice?: string | null;
  @Column({ name: "entry_date", type: "date", nullable: true }) entryDate?: string | null;
  @Column({ name: "exit_price", type: "numeric", precision: 14, scale: 2, nullable: true }) exitPrice?: string | null;
  @Column({ name: "exit_date", type: "date", nullable: true }) exitDate?: string | null;
  @Column({ name: "exit_reason", type: "varchar", length: 40, nullable: true }) exitReason?: string | null;
  @Column({ type: "jsonb", nullable: true }) metrics?: Record<string, unknown> | null; // qty, costs, slippage, MFE, MAE, return
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}

@Entity("short_term_model_performance")
export class ShortTermModelPerformance {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Column({ name: "model_name", type: "varchar", length: 60 }) modelName: string;
  @Column({ name: "model_version", type: "varchar", length: 40 }) modelVersion: string;
  @Column({ type: "varchar", length: 12 }) state: string; // SHADOW | HEALTHY | DEGRADED | SUSPENDED
  @Column({ type: "jsonb" }) metrics: Record<string, unknown>;
  @Column({ type: "text", nullable: true }) verdict?: string | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}

@Entity("short_term_alerts")
@Index(["ticker", "createdAt"])
export class ShortTermAlert {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Column({ type: "varchar", length: 20 }) ticker: string;
  @Column({ name: "alert_type", type: "varchar", length: 40 }) alertType: string;
  @Column({ type: "text" }) message: string;
  /** Dedupe key: same (ticker, alertType, dedupe_key) is emitted at most once. */
  @Index() @Column({ name: "dedupe_key", type: "varchar", length: 120 }) dedupeKey: string;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}

@Entity("short_term_user_preferences")
export class ShortTermPreference {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index({ unique: true }) @Column({ name: "account_id", type: "uuid" }) accountId: string;
  @Column({ type: "jsonb" }) prefs: Record<string, unknown>;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
  @Column({ name: "updated_at", type: "timestamptz", nullable: true }) updatedAt?: Date | null;
}
