import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * Model Registry Entity
 *
 * Tracks ML model versions, performance metrics, and deployment status
 * Enables model versioning, A/B testing, and rollback capabilities
 */
@Entity("model_registry")
@Index(["modelName", "version"])
@Index(["isProduction"])
@Index(["createdAt"])
export class ModelRegistry {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "model_name", type: "varchar", length: 100 })
  modelName: string; // "random_forest", "gradient_boosting", "neural_network", "ensemble"

  @Column({ type: "varchar", length: 50 })
  version: string; // "v1.0.0", "v1.1.0", etc.

  @Column({ name: "model_type", type: "varchar", length: 50 })
  modelType: string; // "classification", "regression"

  // Model artifacts path (could be S3, local file system, etc.)
  @Column({ name: "artifacts_path", type: "text" })
  artifactsPath: string;

  // Performance metrics (on test set)
  @Column({ type: "jsonb" })
  performance: {
    accuracy: number;
    precision: number;
    recall: number;
    f1_score: number;
    auc_roc: number;
    confusion_matrix: number[][];
    sharpe_ratio?: number;
    sortino_ratio?: number;
    max_drawdown?: number;
  };

  // Training metadata
  @Column({ name: "training_samples", type: "integer" })
  trainingSamples: number;

  @Column({ name: "test_samples", type: "integer" })
  testSamples: number;

  @Column({ name: "training_date_range", type: "jsonb" })
  trainingDateRange: {
    start: string;
    end: string;
  };

  @Column({ name: "feature_count", type: "integer" })
  featureCount: number;

  @Column({ name: "hyperparameters", type: "jsonb" })
  hyperparameters: Record<string, any>;

  // Feature importance
  @Column({ name: "feature_importance", type: "jsonb", nullable: true })
  featureImportance?: Array<{ name: string; importance: number }>;

  // Deployment status
  @Column({ name: "is_production", type: "boolean", default: false })
  isProduction: boolean;

  @Column({ name: "deployment_date", type: "timestamptz", nullable: true })
  deploymentDate?: Date;

  @Column({ name: "deprecated_date", type: "timestamptz", nullable: true })
  deprecatedDate?: Date;

  // Model lineage
  @Column({ name: "parent_model_id", type: "uuid", nullable: true })
  parentModelId?: string; // For tracking model evolution

  @Column({ type: "text", nullable: true })
  notes?: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
