import { Entity, PrimaryGeneratedColumn, PrimaryColumn, Column, CreateDateColumn, Index } from "typeorm";

@Entity("global_market_observations")
@Index(["instrument", "sessionDate"], { unique: true })
export class GlobalMarketObservation {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column({ name: "instrument", type: "varchar", length: 40 }) instrument!: string;
  @Column({ name: "asset_class", type: "varchar", length: 16 }) assetClass!: string;
  @Column({ name: "region", type: "varchar", length: 16 }) region!: string;
  @Column({ name: "session_date", type: "date" }) sessionDate!: string;
  @Column({ name: "exchange_tz", type: "varchar", length: 40 }) exchangeTz!: string;
  @Column({ name: "local_close_at", type: "timestamptz", nullable: true }) localCloseAt!: Date | null;
  @Column({ name: "utc_close_at", type: "timestamptz", nullable: true }) utcCloseAt!: Date | null;
  @Column({ name: "price", type: "numeric", precision: 18, scale: 6 }) price!: string;
  @Column({ name: "return_1d", type: "numeric", precision: 10, scale: 4, nullable: true }) return1d!: string | null;
  @Column({ name: "return_5d", type: "numeric", precision: 10, scale: 4, nullable: true }) return5d!: string | null;
  @Column({ name: "return_20d", type: "numeric", precision: 10, scale: 4, nullable: true }) return20d!: string | null;
  @Column({ name: "volatility_20", type: "numeric", precision: 10, scale: 4, nullable: true }) volatility20!: string | null;
  @Column({ name: "volume", type: "numeric", precision: 20, scale: 2, nullable: true }) volume!: string | null;
  @Column({ name: "source", type: "varchar", length: 40 }) source!: string;
  @Column({ name: "source_timestamp", type: "timestamptz", nullable: true }) sourceTimestamp!: Date | null;
  @Column({ name: "freshness", type: "varchar", length: 12, default: "UNKNOWN" }) freshness!: string;
  @Column({ name: "data_quality", type: "numeric", precision: 5, scale: 1, default: 0 }) dataQuality!: string;
  @Column({ name: "fetched_at", type: "timestamptz", default: () => "now()" }) fetchedAt!: Date;
}

@Entity("global_market_snapshots")
export class GlobalMarketSnapshot {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column({ name: "cutoff_utc", type: "timestamptz" }) cutoffUtc!: Date;
  @Column({ name: "india_session_date", type: "date" }) indiaSessionDate!: string;
  @Column({ name: "kind", type: "varchar", length: 12, default: "REQUEST" }) kind!: string;
  @Column({ name: "observations", type: "jsonb" }) observations!: Array<Record<string, unknown>>;
  @Column({ name: "coverage", type: "jsonb" }) coverage!: Record<string, unknown>;
  @Column({ name: "regime", type: "jsonb" }) regime!: Record<string, unknown>;
  @Column({ name: "transmission", type: "jsonb", nullable: true }) transmission!: Record<string, unknown> | null;
  @Column({ name: "sectors", type: "jsonb", nullable: true }) sectors!: Array<Record<string, unknown>> | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt!: Date;
}

@Entity("global_regime_days")
export class GlobalRegimeDay {
  @PrimaryColumn({ name: "india_session_date", type: "date" }) indiaSessionDate!: string;
  @Column({ name: "regime", type: "varchar", length: 12 }) regime!: string;
  @Column({ name: "score", type: "numeric", precision: 6, scale: 2 }) score!: string;
  @Column({ name: "components", type: "jsonb" }) components!: Record<string, unknown>;
  @Column({ name: "coverage", type: "jsonb" }) coverage!: Record<string, unknown>;
  @Column({ name: "feature_cutoff_utc", type: "timestamptz" }) featureCutoffUtc!: Date;
  @Column({ name: "computed_at", type: "timestamptz", default: () => "now()" }) computedAt!: Date;
}

@Entity("global_events")
export class GlobalEvent {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column({ name: "event", type: "varchar", length: 80 }) event!: string;
  @Column({ name: "region", type: "varchar", length: 16 }) region!: string;
  @Column({ name: "scheduled_at", type: "timestamptz" }) scheduledAt!: Date;
  @Column({ name: "actual_at", type: "timestamptz", nullable: true }) actualAt!: Date | null;
  @Column({ name: "importance", type: "varchar", length: 8, default: "HIGH" }) importance!: string;
  @Column({ name: "expected", type: "text", nullable: true }) expected!: string | null;
  @Column({ name: "actual", type: "text", nullable: true }) actual!: string | null;
  @Column({ name: "surprise", type: "text", nullable: true }) surprise!: string | null;
  @Column({ name: "market_reaction", type: "jsonb", nullable: true }) marketReaction!: Record<string, unknown> | null;
  @Column({ name: "source", type: "varchar", length: 120, nullable: true }) source!: string | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt!: Date;
}

@Entity("global_relationship_studies")
export class GlobalRelationshipStudy {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column({ name: "study_version", type: "varchar", length: 30 }) studyVersion!: string;
  @Column({ name: "driver", type: "varchar", length: 40 }) driver!: string;
  @Column({ name: "shock", type: "varchar", length: 120 }) shock!: string;
  @Column({ name: "target", type: "varchar", length: 40 }) target!: string;
  @Column({ name: "horizon_sessions", type: "int" }) horizonSessions!: number;
  @Column({ name: "n", type: "int" }) n!: number;
  @Column({ name: "mean_pct", type: "numeric", precision: 10, scale: 4, nullable: true }) meanPct!: string | null;
  @Column({ name: "median_pct", type: "numeric", precision: 10, scale: 4, nullable: true }) medianPct!: string | null;
  @Column({ name: "win_rate_pct", type: "numeric", precision: 6, scale: 2, nullable: true }) winRatePct!: string | null;
  @Column({ name: "wilson_lb95_pct", type: "numeric", precision: 6, scale: 2, nullable: true }) wilsonLb95Pct!: string | null;
  @Column({ name: "vol_pct", type: "numeric", precision: 10, scale: 4, nullable: true }) volPct!: string | null;
  @Column({ name: "max_drawdown_pct", type: "numeric", precision: 10, scale: 4, nullable: true }) maxDrawdownPct!: string | null;
  @Column({ name: "benchmark_mean_pct", type: "numeric", precision: 10, scale: 4, nullable: true }) benchmarkMeanPct!: string | null;
  @Column({ name: "benchmark_n", type: "int", nullable: true }) benchmarkN!: number | null;
  @Column({ name: "data_from", type: "date", nullable: true }) dataFrom!: string | null;
  @Column({ name: "data_to", type: "date", nullable: true }) dataTo!: string | null;
  @Column({ name: "displayable", type: "boolean", default: false }) displayable!: boolean;
  @Column({ name: "detail", type: "jsonb", nullable: true }) detail!: Record<string, unknown> | null;
  @Column({ name: "experiment_run_id", type: "uuid", nullable: true }) experimentRunId!: string | null;
  @Column({ name: "computed_at", type: "timestamptz", default: () => "now()" }) computedAt!: Date;
}

@Entity("india_market_days")
export class IndiaMarketDay {
  @PrimaryColumn({ name: "india_session_date", type: "date" }) indiaSessionDate!: string;
  @Column({ name: "state", type: "varchar", length: 12 }) state!: string;
  @Column({ name: "score", type: "numeric", precision: 6, scale: 2 }) score!: string;
  @Column({ name: "components", type: "jsonb" }) components!: Array<Record<string, unknown>>;
  @Column({ name: "coverage", type: "jsonb" }) coverage!: Record<string, unknown>;
  @Column({ name: "feature_cutoff_utc", type: "timestamptz" }) featureCutoffUtc!: Date;
  @Column({ name: "computed_at", type: "timestamptz", default: () => "now()" }) computedAt!: Date;
}
