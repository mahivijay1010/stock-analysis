import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/** A calculated/extracted/analyzed metric with its complete lineage. */
@Entity("intelligence_metrics")
@Index(["ticker", "metric", "period", "methodology"])
export class IntelligenceMetric {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 20, nullable: true })
  ticker?: string | null;

  @Column({ type: "varchar", length: 80 })
  metric!: string;

  @Column({ type: "numeric", precision: 30, scale: 8, nullable: true })
  value?: string | null;

  @Column({ name: "value_json", type: "jsonb", nullable: true })
  valueJson?: unknown;

  @Column({ type: "varchar", length: 40 })
  period!: string;

  @Column({ type: "text", nullable: true })
  formula?: string | null;

  @Column({ name: "input_values", type: "jsonb", default: {} })
  inputValues!: Record<string, unknown>;

  @Column({ type: "varchar", length: 80, default: "STANDARD" })
  methodology!: string;

  @Column({ type: "jsonb", default: [] })
  sources!: Array<Record<string, unknown>>;

  @Column({ type: "varchar", length: 24 })
  status!: string;

  @Column({ type: "varchar", length: 10 })
  confidence!: string;

  @Column({ type: "text", nullable: true })
  reason?: string | null;

  @Column({ name: "published_at", type: "timestamptz", nullable: true })
  publishedAt?: Date | null;

  @CreateDateColumn({ name: "calculated_at", type: "timestamptz" })
  calculatedAt!: Date;
}
