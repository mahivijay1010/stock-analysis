import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
} from "typeorm";
import { Analysis } from "./Analysis";
import { StockHistory } from "./StockHistory";
import { StockMetrics } from "./StockMetrics";

/**
 * Stock Entity
 * Represents a stock/company in the database
 * Stores basic information about stocks that users analyze
 * Enhanced with tracking fields and relationships to history and metrics
 */
@Entity("stocks")
@Index(["ticker"])
@Index(["isActive", "trackingEnabled"])
export class Stock {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "varchar", length: 255 })
  name: string;

  @Column({ type: "varchar", length: 20, unique: true })
  ticker: string; // Increased to 20 to handle suffixes like ".NS", ".BSE"

  @Column({ name: "exchange", type: "varchar", length: 50, nullable: true })
  exchange?: string; // NASDAQ, NYSE, etc.

  @Column({ name: "sector", type: "varchar", length: 100, nullable: true })
  sector?: string; // Technology, Healthcare, etc.

  @Column({ name: "industry", type: "varchar", length: 100, nullable: true })
  industry?: string; // Software, Pharmaceuticals, etc.

  @Column({ name: "is_active", type: "boolean", default: true })
  isActive: boolean;

  @Column({ name: "tracking_enabled", type: "boolean", default: true })
  trackingEnabled: boolean;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;

  // Relationships
  @OneToMany(() => Analysis, (analysis) => analysis.stock)
  analyses: Analysis[];

  @OneToMany(() => StockHistory, (history) => history.stock)
  history: StockHistory[];

  @OneToMany(() => StockMetrics, (metrics) => metrics.stock)
  metrics: StockMetrics[];
}
