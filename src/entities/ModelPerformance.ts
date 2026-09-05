import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * Model Performance Entity
 *
 * Stores the latest walk-forward backtest summary per ticker (keyed by
 * `ticker` + modelVersion "quant-v1"). The `horizons` jsonb column holds the
 * full BacktestHorizonStats[] used by /api/accuracy.
 *
 * Legacy ML columns are kept nullable so pre-rebuild rows survive.
 */
@Entity("model_performance")
@Index(["modelVersion", "periodStart"])
@Index(["periodStart"])
@Index(["ticker"])
// One summary row per (ticker, model_version) — enables atomic ON CONFLICT
// upserts and prevents duplicate rows under concurrent backtests.
@Index(["ticker", "modelVersion"], { unique: true })
export class ModelPerformance {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "model_version", type: "varchar", length: 50 })
  modelVersion: string; // "quant-v1"

  // ── Quant backtest summary (rebuild) — nullable so old rows survive ──
  @Column({ type: "varchar", length: 20, nullable: true })
  ticker?: string;

  @Column({ name: "test_days", type: "int", nullable: true })
  testDays?: number;

  @Column({ name: "ran_at", type: "timestamptz", nullable: true })
  ranAt?: Date;

  /** BacktestHorizonStats[] — per-horizon samples/hit-rate/error/band stats. */
  @Column({ type: "jsonb", nullable: true })
  horizons?: Array<{
    horizonDays: number;
    samples: number;
    directionHitRatePct: number;
    avgAbsErrorPct: number;
    avgPredictedPct: number;
    avgActualPct: number;
    withinBandPct: number;
    // V6 calibration (absent on rows written before the calibration release)
    brierScore?: number;
    probBuckets?: Array<{
      pLow: number;
      pHigh: number;
      n: number;
      meanPredicted: number;
      observedUpFreq: number;
    }>;
    // V7 model pool (absent on rows written before the A.C.E. release)
    models?: Record<string, { brier: number; hitRatePct: number; samples: number }>;
    ensemble?: { brier: number; hitRatePct: number; samples: number };
  }>;

  @Column({ name: "period_start", type: "date" })
  periodStart: Date;

  @Column({ name: "period_end", type: "date" })
  periodEnd: Date;

  @Column({ name: "aggregation_level", type: "varchar", length: 20 })
  aggregationLevel: string; // "backtest"

  // Performance metrics
  @Column({ name: "total_predictions", type: "integer" })
  totalPredictions: number;

  @Column({ name: "correct_predictions", type: "integer" })
  correctPredictions: number;

  @Column({ type: "decimal", precision: 5, scale: 4 })
  accuracy: number; // overall direction hit rate, 0..1

  // ── Legacy ML metrics (nullable, unused by the quant engine) ──
  @Column({ type: "decimal", precision: 5, scale: 4, nullable: true })
  precision?: number;

  @Column({ type: "decimal", precision: 5, scale: 4, nullable: true })
  recall?: number;

  @Column({ name: "f1_score", type: "decimal", precision: 5, scale: 4, nullable: true })
  f1Score?: number;

  @Column({ name: "average_return", type: "decimal", precision: 10, scale: 4, nullable: true })
  averageReturn?: number;

  @Column({ name: "sharpe_ratio", type: "decimal", precision: 10, scale: 4, nullable: true })
  sharpeRatio?: number;

  @Column({ name: "sortino_ratio", type: "decimal", precision: 10, scale: 4, nullable: true })
  sortinoRatio?: number;

  @Column({ name: "max_drawdown", type: "decimal", precision: 10, scale: 4, nullable: true })
  maxDrawdown?: number;

  @Column({ name: "win_rate", type: "decimal", precision: 5, scale: 4, nullable: true })
  winRate?: number;

  @Column({ name: "avg_confidence", type: "decimal", precision: 5, scale: 4, nullable: true })
  avgConfidence?: number;

  @Column({
    name: "high_confidence_accuracy",
    type: "decimal",
    precision: 5,
    scale: 4,
    nullable: true,
  })
  highConfidenceAccuracy?: number;

  @Column({
    name: "low_confidence_accuracy",
    type: "decimal",
    precision: 5,
    scale: 4,
    nullable: true,
  })
  lowConfidenceAccuracy?: number;

  @Column({ name: "feature_drift_score", type: "decimal", precision: 5, scale: 4, nullable: true })
  featureDriftScore?: number;

  @Column({
    name: "prediction_drift_score",
    type: "decimal",
    precision: 5,
    scale: 4,
    nullable: true,
  })
  predictionDriftScore?: number;

  // Alert flags
  @Column({ name: "accuracy_below_threshold", type: "boolean", default: false })
  accuracyBelowThreshold: boolean;

  @Column({ name: "significant_drift_detected", type: "boolean", default: false })
  significantDriftDetected: boolean;

  @Column({ name: "retraining_recommended", type: "boolean", default: false })
  retrainingRecommended: boolean;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
