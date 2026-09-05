import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * Prediction Log Entity
 *
 * Logs every horizon prediction made by the quant engine so the verification
 * cron can later fill in the actual outcome and measure real accuracy.
 * One row per (ticker, predictionDate, horizonDays).
 *
 * Legacy ML columns (modelPredictions, featureVector, ...) are kept nullable
 * so existing rows survive; the quant engine does not write them.
 */
@Entity("prediction_logs")
@Index(["ticker", "predictionDate"])
@Index(["modelVersion"])
@Index(["predictionDate"])
@Index(["createdAt"])
export class PredictionLog {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "varchar", length: 20 })
  ticker: string;

  @Column({ name: "prediction_date", type: "date" })
  predictionDate: Date; // Date of the last bar the prediction was based on (YYYY-MM-DD)

  @Column({ name: "model_version", type: "varchar", length: 50 })
  modelVersion: string; // e.g. "quant-v1"

  // Prediction details
  @Column({ name: "predicted_direction", type: "varchar", length: 20 })
  predictedDirection: string; // "UP", "DOWN", "UNCERTAIN"

  @Column({ name: "predicted_probability", type: "decimal", precision: 5, scale: 4 })
  predictedProbability: number; // directionProb 0.0 to 1.0

  @Column({ type: "decimal", precision: 5, scale: 4 })
  confidence: number; // 0.0 to 1.0 (directionProb)

  @Column({ name: "expected_return", type: "decimal", precision: 10, scale: 4 })
  expectedReturn: number; // Expected return percentage over the horizon

  @Column({ name: "expected_volatility", type: "decimal", precision: 10, scale: 4, nullable: true })
  expectedVolatility?: number; // Annualized volatility percentage at prediction time

  // ── Quant horizon fields (rebuild) — nullable so old rows survive ──
  @Column({ name: "horizon_days", type: "int", nullable: true })
  horizonDays?: number; // 1 | 3 | 7 | 15 | 30 (calendar days)

  @Column({ name: "target_date", type: "date", nullable: true })
  targetDate?: Date; // predictionDate + horizonDays calendar days (informational)

  @Column({ name: "base_price", type: "decimal", precision: 12, scale: 4, nullable: true })
  basePrice?: number; // close of the bar the prediction was made on

  @Column({ name: "expected_price", type: "decimal", precision: 12, scale: 4, nullable: true })
  expectedPrice?: number;

  @Column({ name: "low80_pct", type: "decimal", precision: 10, scale: 4, nullable: true })
  low80Pct?: number; // lower edge of the 80% return band, in pct

  @Column({ name: "high80_pct", type: "decimal", precision: 10, scale: 4, nullable: true })
  high80Pct?: number; // upper edge of the 80% return band, in pct

  @Column({ type: "decimal", precision: 6, scale: 2, nullable: true })
  score?: number; // composite quant score 0..100 at prediction time

  // ── Legacy ML columns (nullable, unused by the quant engine) ──
  @Column({ name: "models_agreement", type: "decimal", precision: 5, scale: 2, nullable: true })
  modelsAgreement?: number;

  @Column({ name: "prediction_uncertainty", type: "varchar", length: 20, nullable: true })
  predictionUncertainty?: string; // "low", "medium", "high" (mapped from riskLevel)

  @Column({ name: "model_predictions", type: "jsonb", nullable: true })
  modelPredictions?: {
    random_forest?: number;
    gradient_boosting?: number;
    neural_network?: number;
  };

  @Column({ name: "feature_vector", type: "jsonb", nullable: true })
  featureVector?: number[];

  @Column({ name: "feature_quality", type: "decimal", precision: 5, scale: 2, nullable: true })
  featureQuality?: number;

  // Actual outcome (filled by the verification cron once the horizon matures)
  @Column({ name: "actual_return", type: "decimal", precision: 10, scale: 4, nullable: true })
  actualReturn?: number;

  @Column({ name: "actual_direction", type: "varchar", length: 20, nullable: true })
  actualDirection?: string; // "UP", "DOWN"

  @Column({ name: "prediction_correct", type: "boolean", nullable: true })
  predictionCorrect?: boolean; // true if predicted direction matches actual

  @Column({ name: "outcome_date", type: "date", nullable: true })
  outcomeDate?: Date; // trading date of the bar used as the actual outcome

  // Recommendation context
  @Column({ name: "recommendation_given", type: "varchar", length: 50, nullable: true })
  recommendationGiven?: string; // "BUY" | "HOLD" | "AVOID"

  @Column({ name: "fundamental_score", type: "decimal", precision: 5, scale: 2, nullable: true })
  fundamentalScore?: number;

  @Column({ name: "risk_warnings", type: "jsonb", nullable: true })
  riskWarnings?: string[];

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
