import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * Money Desk ledger — immutable capital decisions (see migration 1790900000000).
 * Numeric columns are typed as strings (Postgres numeric → string) like the
 * other ledgers; convert at the edge, never store floats as money.
 */
@Entity("capital_plans")
@Index(["accountId", "planDate"])
export class CapitalPlan {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column({ name: "account_id", type: "uuid" }) accountId!: string;
  @Column({ name: "kind", type: "varchar", length: 12, default: "REQUEST" }) kind!: "REQUEST" | "SNAPSHOT";
  @Column({ name: "as_of", type: "timestamptz" }) asOf!: Date;
  @Column({ name: "plan_date", type: "date" }) planDate!: string;
  @Column({ name: "capital_available_inr", type: "numeric", precision: 16, scale: 2 }) capitalAvailableInr!: string;
  @Column({ name: "capital_invested_inr", type: "numeric", precision: 16, scale: 2 }) capitalInvestedInr!: string;
  @Column({ name: "cash_reserve_inr", type: "numeric", precision: 16, scale: 2 }) cashReserveInr!: string;
  @Column({ name: "recommended_deployment_inr", type: "numeric", precision: 16, scale: 2 }) recommendedDeploymentInr!: string;
  @Column({ name: "risk_budget_inr", type: "numeric", precision: 16, scale: 2 }) riskBudgetInr!: string;
  @Column({ name: "risk_profile", type: "varchar", length: 14 }) riskProfile!: string;
  @Column({ name: "horizon", type: "varchar", length: 8 }) horizon!: string;
  @Column({ name: "max_positions", type: "int" }) maxPositions!: number;
  @Column({ name: "market_regime", type: "varchar", length: 16 }) marketRegime!: string;
  @Column({ name: "decision_policy_version", type: "varchar", length: 40 }) decisionPolicyVersion!: string;
  @Column({ name: "model_version", type: "varchar", length: 60 }) modelVersion!: string;
  @Column({ name: "feature_cutoff_at", type: "timestamptz", nullable: true }) featureCutoffAt!: Date | null;
  @Column({ name: "freshness", type: "jsonb" }) freshness!: Record<string, unknown>;
  @Column({ name: "summary", type: "text" }) summary!: string;
  @Column({ name: "result", type: "jsonb" }) result!: Record<string, unknown>;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt!: Date;
}

@Entity("capital_allocations")
@Index(["capitalPlanId"])
@Index(["ticker", "planDate"])
export class CapitalAllocation {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column({ name: "capital_plan_id", type: "uuid" }) capitalPlanId!: string;
  @Column({ name: "account_id", type: "uuid" }) accountId!: string;
  @Column({ name: "plan_date", type: "date" }) planDate!: string;
  @Column({ name: "ticker", type: "varchar", length: 20 }) ticker!: string;
  @Column({ name: "action", type: "varchar", length: 10 }) action!: string;
  @Column({ name: "recommended_amount_inr", type: "numeric", precision: 16, scale: 2, nullable: true }) recommendedAmountInr!: string | null;
  @Column({ name: "recommended_qty", type: "int", nullable: true }) recommendedQty!: number | null;
  @Column({ name: "max_amount_inr", type: "numeric", precision: 16, scale: 2, nullable: true }) maxAmountInr!: string | null;
  @Column({ name: "pct_of_capital", type: "numeric", precision: 8, scale: 2, nullable: true }) pctOfCapital!: string | null;
  @Column({ name: "entry_price", type: "numeric", precision: 14, scale: 4, nullable: true }) entryPrice!: string | null;
  @Column({ name: "entry_zone_low", type: "numeric", precision: 14, scale: 4, nullable: true }) entryZoneLow!: string | null;
  @Column({ name: "entry_zone_high", type: "numeric", precision: 14, scale: 4, nullable: true }) entryZoneHigh!: string | null;
  @Column({ name: "entry_type", type: "varchar", length: 30, nullable: true }) entryType!: string | null;
  @Column({ name: "stop_price", type: "numeric", precision: 14, scale: 4, nullable: true }) stopPrice!: string | null;
  @Column({ name: "target1", type: "numeric", precision: 14, scale: 4, nullable: true }) target1!: string | null;
  @Column({ name: "target2", type: "numeric", precision: 14, scale: 4, nullable: true }) target2!: string | null;
  @Column({ name: "target3", type: "numeric", precision: 14, scale: 4, nullable: true }) target3!: string | null;
  @Column({ name: "expected_holding_sessions", type: "int", nullable: true }) expectedHoldingSessions!: number | null;
  @Column({ name: "risk_amount_inr", type: "numeric", precision: 16, scale: 2, nullable: true }) riskAmountInr!: string | null;
  @Column({ name: "reward_risk", type: "numeric", precision: 8, scale: 3, nullable: true }) rewardRisk!: string | null;
  @Column({ name: "ev_after_costs_pct", type: "numeric", precision: 8, scale: 3, nullable: true }) evAfterCostsPct!: string | null;
  @Column({ name: "evidence_score", type: "numeric", precision: 6, scale: 1, nullable: true }) evidenceScore!: string | null;
  @Column({ name: "evidence_tier", type: "varchar", length: 2, nullable: true }) evidenceTier!: string | null;
  @Column({ name: "setup_type", type: "varchar", length: 40, nullable: true }) setupType!: string | null;
  @Column({ name: "decision_status", type: "varchar", length: 24 }) decisionStatus!: string;
  @Column({ name: "reason_codes", type: "jsonb", default: () => "'[]'::jsonb" }) reasonCodes!: string[];
  @Column({ name: "risk_reasons", type: "jsonb", default: () => "'[]'::jsonb" }) riskReasons!: string[];
  @Column({ name: "invalidation_reasons", type: "jsonb", default: () => "'[]'::jsonb" }) invalidationReasons!: string[];
  @Column({ name: "detail", type: "jsonb", nullable: true }) detail!: Record<string, unknown> | null;
  @Column({ name: "model_version", type: "varchar", length: 60 }) modelVersion!: string;
  @Column({ name: "decision_snapshot_id", type: "uuid", nullable: true }) decisionSnapshotId!: string | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt!: Date;
}

@Entity("capital_decision_outcomes")
export class CapitalDecisionOutcome {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column({ name: "capital_allocation_id", type: "uuid" }) capitalAllocationId!: string;
  @Column({ name: "grader_version", type: "varchar", length: 30 }) graderVersion!: string;
  @Column({ name: "outcome", type: "varchar", length: 14 }) outcome!: string;
  @Column({ name: "entry_triggered", type: "boolean", default: false }) entryTriggered!: boolean;
  @Column({ name: "entry_price", type: "numeric", precision: 14, scale: 4, nullable: true }) entryPrice!: string | null;
  @Column({ name: "entry_at", type: "date", nullable: true }) entryAt!: string | null;
  @Column({ name: "exit_triggered", type: "boolean", default: false }) exitTriggered!: boolean;
  @Column({ name: "exit_price", type: "numeric", precision: 14, scale: 4, nullable: true }) exitPrice!: string | null;
  @Column({ name: "exit_at", type: "date", nullable: true }) exitAt!: string | null;
  @Column({ name: "realized_pnl_inr", type: "numeric", precision: 16, scale: 2, nullable: true }) realizedPnlInr!: string | null;
  @Column({ name: "realized_return_pct", type: "numeric", precision: 10, scale: 4, nullable: true }) realizedReturnPct!: string | null;
  @Column({ name: "realized_net_r", type: "numeric", precision: 10, scale: 4, nullable: true }) realizedNetR!: string | null;
  @Column({ name: "conservative_net_r", type: "numeric", precision: 10, scale: 4, nullable: true }) conservativeNetR!: string | null;
  @Column({ name: "mfe_r", type: "numeric", precision: 10, scale: 4, nullable: true }) mfeR!: string | null;
  @Column({ name: "mae_r", type: "numeric", precision: 10, scale: 4, nullable: true }) maeR!: string | null;
  @Column({ name: "holding_sessions", type: "int", default: 0 }) holdingSessions!: number;
  @Column({ name: "benchmark_return_pct", type: "numeric", precision: 10, scale: 4, nullable: true }) benchmarkReturnPct!: string | null;
  @Column({ name: "excess_return_pct", type: "numeric", precision: 10, scale: 4, nullable: true }) excessReturnPct!: string | null;
  @Column({ name: "ambiguous", type: "boolean", default: false }) ambiguous!: boolean;
  @Column({ name: "feature_cutoff_at", type: "timestamptz", nullable: true }) featureCutoffAt!: Date | null;
  @Column({ name: "decision_time", type: "timestamptz" }) decisionTime!: Date;
  @Column({ name: "outcome_maturity_time", type: "timestamptz", nullable: true }) outcomeMaturityTime!: Date | null;
  @Column({ name: "flags", type: "jsonb", default: () => "'[]'::jsonb" }) flags!: string[];
  @CreateDateColumn({ name: "graded_at", type: "timestamptz" }) gradedAt!: Date;
}

@Entity("daily_capital_decision_snapshots")
export class DailyCapitalDecisionSnapshot {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column({ name: "account_id", type: "uuid" }) accountId!: string;
  @Column({ name: "snapshot_date", type: "date" }) snapshotDate!: string;
  @Column({ name: "capital_plan_id", type: "uuid" }) capitalPlanId!: string;
  @Column({ name: "risk_profile", type: "varchar", length: 14 }) riskProfile!: string;
  @Column({ name: "market_regime", type: "varchar", length: 16 }) marketRegime!: string;
  @Column({ name: "model_versions", type: "jsonb" }) modelVersions!: Record<string, string>;
  @Column({ name: "feature_cutoff_at", type: "timestamptz", nullable: true }) featureCutoffAt!: Date | null;
  @Column({ name: "freshness", type: "jsonb" }) freshness!: Record<string, unknown>;
  @Column({ name: "state", type: "jsonb" }) state!: Record<string, unknown>;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt!: Date;
}
