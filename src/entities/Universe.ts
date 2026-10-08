import { Entity, PrimaryGeneratedColumn, PrimaryColumn, Column, CreateDateColumn, Index } from "typeorm";

/** Exchange-wide security master. Numerics are strings (Postgres numeric). */
@Entity("security_master")
@Index(["liquidityTier", "instrumentType", "isActive"])
export class SecurityMaster {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column({ name: "symbol", type: "varchar", length: 40, unique: true }) symbol!: string;
  @Column({ name: "yahoo_ticker", type: "varchar", length: 50 }) yahooTicker!: string;
  @Column({ name: "company_name", type: "varchar", length: 200 }) companyName!: string;
  @Column({ name: "isin", type: "varchar", length: 12, nullable: true }) isin!: string | null;
  @Column({ name: "exchange", type: "varchar", length: 8, default: "NSE" }) exchange!: string;
  @Column({ name: "series", type: "varchar", length: 4, nullable: true }) series!: string | null;
  @Column({ name: "instrument_type", type: "varchar", length: 12, default: "EQUITY" }) instrumentType!: string;
  @Column({ name: "sector", type: "varchar", length: 120, nullable: true }) sector!: string | null;
  @Column({ name: "industry", type: "varchar", length: 120, nullable: true }) industry!: string | null;
  @Column({ name: "market_cap_inr", type: "numeric", precision: 20, scale: 2, nullable: true }) marketCapInr!: string | null;
  @Column({ name: "market_cap_bucket", type: "varchar", length: 10, default: "UNKNOWN" }) marketCapBucket!: string;
  @Column({ name: "market_cap_source", type: "varchar", length: 40, nullable: true }) marketCapSource!: string | null;
  @Column({ name: "listed_date", type: "date", nullable: true }) listedDate!: string | null;
  @Column({ name: "is_active", type: "boolean", default: true }) isActive!: boolean;
  @Column({ name: "is_tradable", type: "boolean", default: false }) isTradable!: boolean;
  @Column({ name: "liquidity_tier", type: "varchar", length: 2, default: "X" }) liquidityTier!: string;
  @Column({ name: "liquidity_median_value_inr", type: "numeric", precision: 18, scale: 2, nullable: true }) liquidityMedianValueInr!: string | null;
  @Column({ name: "liquidity_as_of", type: "date", nullable: true }) liquidityAsOf!: string | null;
  @Column({ name: "last_trade_date", type: "date", nullable: true }) lastTradeDate!: string | null;
  @Column({ name: "surveillance", type: "varchar", length: 24, nullable: true }) surveillance!: string | null;
  @Column({ name: "currency", type: "varchar", length: 3, default: "INR" }) currency!: string;
  @Column({ name: "data_status", type: "varchar", length: 12, default: "NONE" }) dataStatus!: string;
  @Column({ name: "indices", type: "text", array: true, default: () => "'{}'" }) indices!: string[];
  @Column({ name: "source", type: "varchar", length: 40 }) source!: string;
  @Column({ name: "source_freshness_at", type: "timestamptz", nullable: true }) sourceFreshnessAt!: Date | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt!: Date;
  @Column({ name: "updated_at", type: "timestamptz", default: () => "now()" }) updatedAt!: Date;
}

@Entity("security_master_changes")
@Index(["symbol", "observedAt"])
export class SecurityMasterChange {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column({ name: "symbol", type: "varchar", length: 40 }) symbol!: string;
  @Column({ name: "change_type", type: "varchar", length: 20 }) changeType!: string;
  @Column({ name: "old_value", type: "text", nullable: true }) oldValue!: string | null;
  @Column({ name: "new_value", type: "text", nullable: true }) newValue!: string | null;
  @Column({ name: "source", type: "varchar", length: 40 }) source!: string;
  @Column({ name: "observed_at", type: "date" }) observedAt!: string;
  @Column({ name: "sync_run_id", type: "uuid", nullable: true }) syncRunId!: string | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt!: Date;
}

@Entity("security_data_coverage")
export class SecurityDataCoverage {
  @PrimaryColumn({ name: "symbol", type: "varchar", length: 40 }) symbol!: string;
  @Column({ name: "price_available", type: "boolean", default: false }) priceAvailable!: boolean;
  @Column({ name: "ohlcv_available", type: "boolean", default: false }) ohlcvAvailable!: boolean;
  @Column({ name: "close_only", type: "boolean", default: false }) closeOnly!: boolean;
  @Column({ name: "historical_depth_sessions", type: "int", default: 0 }) historicalDepthSessions!: number;
  @Column({ name: "fundamentals_available", type: "boolean", default: false }) fundamentalsAvailable!: boolean;
  @Column({ name: "financial_results_available", type: "boolean", default: false }) financialResultsAvailable!: boolean;
  @Column({ name: "corporate_actions_available", type: "boolean", default: false }) corporateActionsAvailable!: boolean;
  @Column({ name: "announcement_available", type: "boolean", default: false }) announcementAvailable!: boolean;
  @Column({ name: "news_available", type: "boolean", default: false }) newsAvailable!: boolean;
  @Column({ name: "technical_features_available", type: "boolean", default: false }) technicalFeaturesAvailable!: boolean;
  @Column({ name: "last_price_timestamp", type: "timestamptz", nullable: true }) lastPriceTimestamp!: Date | null;
  @Column({ name: "last_fundamental_timestamp", type: "timestamptz", nullable: true }) lastFundamentalTimestamp!: Date | null;
  @Column({ name: "last_news_timestamp", type: "timestamptz", nullable: true }) lastNewsTimestamp!: Date | null;
  @Column({ name: "last_event_timestamp", type: "timestamptz", nullable: true }) lastEventTimestamp!: Date | null;
  @Column({ name: "coverage_score", type: "numeric", precision: 5, scale: 1, default: 0 }) coverageScore!: string;
  @Column({ name: "detail", type: "jsonb", nullable: true }) detail!: Record<string, unknown> | null;
  @Column({ name: "computed_at", type: "timestamptz", default: () => "now()" }) computedAt!: Date;
}

@Entity("universe_sync_runs")
export class UniverseSyncRun {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column({ name: "job", type: "varchar", length: 40 }) job!: string;
  @Column({ name: "source", type: "varchar", length: 60 }) source!: string;
  @Column({ name: "started_at", type: "timestamptz", default: () => "now()" }) startedAt!: Date;
  @Column({ name: "finished_at", type: "timestamptz", nullable: true }) finishedAt!: Date | null;
  @Column({ name: "status", type: "varchar", length: 12, default: "running" }) status!: string;
  @Column({ name: "counts", type: "jsonb", default: () => "'{}'::jsonb" }) counts!: Record<string, unknown>;
  @Column({ name: "error", type: "text", nullable: true }) error!: string | null;
}

@Entity("opportunity_scans")
export class OpportunityScan {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column({ name: "as_of", type: "date" }) asOf!: string;
  @Column({ name: "universe_label", type: "varchar", length: 30, default: "BROAD_SCAN" }) universeLabel!: string;
  @Column({ name: "started_at", type: "timestamptz", default: () => "now()" }) startedAt!: Date;
  @Column({ name: "finished_at", type: "timestamptz", nullable: true }) finishedAt!: Date | null;
  @Column({ name: "status", type: "varchar", length: 12, default: "running" }) status!: string;
  @Column({ name: "config", type: "jsonb", default: () => "'{}'::jsonb" }) config!: Record<string, unknown>;
  @Column({ name: "stages", type: "jsonb", default: () => "'[]'::jsonb" }) stages!: Array<Record<string, unknown>>;
  @Column({ name: "regime", type: "varchar", length: 16, nullable: true }) regime!: string | null;
  @Column({ name: "scan_run_id", type: "uuid", nullable: true }) scanRunId!: string | null;
  @Column({ name: "notes", type: "text", nullable: true }) notes!: string | null;
}

@Entity("opportunity_candidates")
@Index(["scanId", "stageReached"])
@Index(["symbol", "asOf"])
export class OpportunityCandidate {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column({ name: "scan_id", type: "uuid" }) scanId!: string;
  @Column({ name: "symbol", type: "varchar", length: 40 }) symbol!: string;
  @Column({ name: "yahoo_ticker", type: "varchar", length: 50 }) yahooTicker!: string;
  @Column({ name: "as_of", type: "date" }) asOf!: string;
  @Column({ name: "liquidity_tier", type: "varchar", length: 2 }) liquidityTier!: string;
  @Column({ name: "market_cap_bucket", type: "varchar", length: 10 }) marketCapBucket!: string;
  @Column({ name: "sector", type: "varchar", length: 120, nullable: true }) sector!: string | null;
  @Column({ name: "stage_reached", type: "varchar", length: 20 }) stageReached!: string;
  @Column({ name: "rejected_at_stage", type: "varchar", length: 20, nullable: true }) rejectedAtStage!: string | null;
  @Column({ name: "rejection_reasons", type: "jsonb", default: () => "'[]'::jsonb" }) rejectionReasons!: string[];
  @Column({ name: "signals", type: "text", array: true, default: () => "'{}'" }) signals!: string[];
  @Column({ name: "features", type: "jsonb" }) features!: Record<string, unknown>;
  @Column({ name: "technical_score", type: "numeric", precision: 5, scale: 1, nullable: true }) technicalScore!: string | null;
  @Column({ name: "fundamental_score", type: "numeric", precision: 5, scale: 1, nullable: true }) fundamentalScore!: string | null;
  @Column({ name: "event_score", type: "numeric", precision: 5, scale: 1, nullable: true }) eventScore!: string | null;
  @Column({ name: "research_evidence_score", type: "numeric", precision: 5, scale: 1, nullable: true }) researchEvidenceScore!: string | null;
  @Column({ name: "liquidity_score", type: "numeric", precision: 5, scale: 1, nullable: true }) liquidityScore!: string | null;
  @Column({ name: "risk_score", type: "numeric", precision: 5, scale: 1, nullable: true }) riskScore!: string | null;
  @Column({ name: "model_health_score", type: "numeric", precision: 5, scale: 1, nullable: true }) modelHealthScore!: string | null;
  @Column({ name: "screen_rank", type: "int", nullable: true }) screenRank!: number | null;
  @Column({ name: "setup_type", type: "varchar", length: 40, nullable: true }) setupType!: string | null;
  @Column({ name: "action", type: "varchar", length: 30, nullable: true }) action!: string | null;
  @Column({ name: "tier", type: "varchar", length: 2, nullable: true }) tier!: string | null;
  @Column({ name: "decision_status", type: "varchar", length: 24, nullable: true }) decisionStatus!: string | null;
  @Column({ name: "plan", type: "jsonb", nullable: true }) plan!: Record<string, unknown> | null;
  @Column({ name: "short_term_candidate_id", type: "uuid", nullable: true }) shortTermCandidateId!: string | null;
  @Column({ name: "feature_cutoff_at", type: "timestamptz", nullable: true }) featureCutoffAt!: Date | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt!: Date;
}

@Entity("research_queue")
export class ResearchQueueItem {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column({ name: "symbol", type: "varchar", length: 40 }) symbol!: string;
  @Column({ name: "priority", type: "numeric", precision: 6, scale: 2 }) priority!: string;
  @Column({ name: "reasons", type: "jsonb", default: () => "'[]'::jsonb" }) reasons!: string[];
  @Column({ name: "source", type: "varchar", length: 16 }) source!: string;
  @Column({ name: "status", type: "varchar", length: 12, default: "PENDING" }) status!: string;
  @Column({ name: "queued_at", type: "timestamptz", default: () => "now()" }) queuedAt!: Date;
  @Column({ name: "researched_at", type: "timestamptz", nullable: true }) researchedAt!: Date | null;
  @Column({ name: "profile_id", type: "uuid", nullable: true }) profileId!: string | null;
  @Column({ name: "error", type: "text", nullable: true }) error!: string | null;
}

@Entity("company_research_profiles")
@Index(["symbol", "builtAt"])
export class CompanyResearchProfile {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column({ name: "symbol", type: "varchar", length: 40 }) symbol!: string;
  @Column({ name: "research_version", type: "varchar", length: 30 }) researchVersion!: string;
  @Column({ name: "built_at", type: "timestamptz", default: () => "now()" }) builtAt!: Date;
  @Column({ name: "data_as_of", type: "jsonb" }) dataAsOf!: Record<string, unknown>;
  @Column({ name: "profile", type: "jsonb" }) profile!: Record<string, unknown>;
  @Column({ name: "evidence_items", type: "jsonb", default: () => "'[]'::jsonb" }) evidenceItems!: Array<Record<string, unknown>>;
  @Column({ name: "source_references", type: "jsonb", default: () => "'[]'::jsonb" }) sourceReferences!: Array<Record<string, unknown>>;
  @Column({ name: "ai", type: "jsonb", nullable: true }) ai!: Record<string, unknown> | null;
  @Column({ name: "model_version", type: "varchar", length: 60, nullable: true }) modelVersion!: string | null;
  @Column({ name: "coverage_score", type: "numeric", precision: 5, scale: 1, nullable: true }) coverageScore!: string | null;
}

@Entity("opportunity_outcomes")
export class OpportunityOutcome {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column({ name: "candidate_id", type: "uuid" }) candidateId!: string;
  @Column({ name: "grader_version", type: "varchar", length: 30 }) graderVersion!: string;
  @Column({ name: "outcome", type: "varchar", length: 14 }) outcome!: string;
  @Column({ name: "entry_at", type: "date", nullable: true }) entryAt!: string | null;
  @Column({ name: "entry_price", type: "numeric", precision: 14, scale: 4, nullable: true }) entryPrice!: string | null;
  @Column({ name: "exit_at", type: "date", nullable: true }) exitAt!: string | null;
  @Column({ name: "exit_price", type: "numeric", precision: 14, scale: 4, nullable: true }) exitPrice!: string | null;
  @Column({ name: "realized_return_pct", type: "numeric", precision: 10, scale: 4, nullable: true }) realizedReturnPct!: string | null;
  @Column({ name: "realized_net_r", type: "numeric", precision: 10, scale: 4, nullable: true }) realizedNetR!: string | null;
  @Column({ name: "benchmark_return_pct", type: "numeric", precision: 10, scale: 4, nullable: true }) benchmarkReturnPct!: string | null;
  @Column({ name: "excess_return_pct", type: "numeric", precision: 10, scale: 4, nullable: true }) excessReturnPct!: string | null;
  @Column({ name: "mfe_r", type: "numeric", precision: 10, scale: 4, nullable: true }) mfeR!: string | null;
  @Column({ name: "mae_r", type: "numeric", precision: 10, scale: 4, nullable: true }) maeR!: string | null;
  @Column({ name: "holding_sessions", type: "int", default: 0 }) holdingSessions!: number;
  @Column({ name: "ambiguous", type: "boolean", default: false }) ambiguous!: boolean;
  @Column({ name: "feature_cutoff_at", type: "timestamptz", nullable: true }) featureCutoffAt!: Date | null;
  @Column({ name: "decision_time", type: "timestamptz" }) decisionTime!: Date;
  @Column({ name: "outcome_maturity_time", type: "timestamptz", nullable: true }) outcomeMaturityTime!: Date | null;
  @Column({ name: "flags", type: "jsonb", default: () => "'[]'::jsonb" }) flags!: string[];
  @CreateDateColumn({ name: "graded_at", type: "timestamptz" }) gradedAt!: Date;
}
