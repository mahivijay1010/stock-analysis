import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * Training Sample Entity
 *
 * Stores labeled training samples for machine learning models
 * Each sample represents a stock at a specific date with calculated features and target label
 */
@Entity("training_samples")
@Index(["ticker", "date"])
@Index(["targetDirection"])
@Index(["date"])
export class TrainingSample {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "varchar", length: 20 })
  ticker: string;

  @Column({ type: "date" })
  date: Date;

  // Features (stored as JSON for flexibility with 50+ features)
  @Column({ type: "jsonb" })
  features: Record<string, number>;

  // Target labels
  @Column({ name: "target_return", type: "decimal", precision: 10, scale: 4 })
  targetReturn: number; // 30-day forward return

  @Column({ name: "target_direction", type: "smallint" })
  targetDirection: number; // 1 = UP, 0 = DOWN

  @Column({ name: "target_volatility", type: "decimal", precision: 10, scale: 4 })
  targetVolatility: number; // Actual 30-day volatility

  // Metadata
  @Column({ name: "feature_quality", type: "decimal", precision: 5, scale: 2 })
  featureQuality: number; // Data quality score 0-100

  @Column({ name: "market_regime", type: "varchar", length: 20 })
  marketRegime: string; // uptrend, downtrend, sideways

  @Column({ name: "sector", type: "varchar", length: 50, nullable: true })
  sector?: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @Column({ name: "train_set", type: "boolean", default: false })
  trainSet: boolean; // true = training set, false = test set

  @Column({ name: "validation_set", type: "boolean", default: false })
  validationSet: boolean; // true = validation set (for hyperparameter tuning)
}
