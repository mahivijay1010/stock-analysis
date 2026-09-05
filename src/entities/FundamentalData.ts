import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * FundamentalData Entity
 * Stores fundamental financial metrics for stocks
 * Used for ML feature engineering and fundamental analysis
 */
@Entity("fundamental_data")
@Index(["ticker", "date"], { unique: true })
export class FundamentalData {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 20 })
  @Index()
  ticker!: string;

  @Column({ type: "date" })
  @Index()
  date!: Date;

  // Valuation Ratios
  @Column({ type: "decimal", precision: 10, scale: 2, nullable: true })
  peRatio?: number;

  @Column({ type: "decimal", precision: 10, scale: 2, nullable: true })
  pbRatio?: number;

  @Column({ type: "decimal", precision: 10, scale: 2, nullable: true })
  psRatio?: number;

  @Column({ type: "decimal", precision: 10, scale: 2, nullable: true })
  pegRatio?: number;

  @Column({ type: "decimal", precision: 10, scale: 2, nullable: true })
  evToEbitda?: number;

  // Profitability Metrics
  @Column({ type: "decimal", precision: 10, scale: 4, nullable: true })
  roe?: number; // Return on Equity

  @Column({ type: "decimal", precision: 10, scale: 4, nullable: true })
  roa?: number; // Return on Assets

  @Column({ type: "decimal", precision: 10, scale: 4, nullable: true })
  profitMargin?: number;

  @Column({ type: "decimal", precision: 10, scale: 4, nullable: true })
  operatingMargin?: number;

  @Column({ type: "decimal", precision: 10, scale: 4, nullable: true })
  grossMargin?: number;

  // Financial Health
  @Column({ type: "decimal", precision: 10, scale: 2, nullable: true })
  debtToEquity?: number;

  @Column({ type: "decimal", precision: 10, scale: 2, nullable: true })
  currentRatio?: number;

  @Column({ type: "decimal", precision: 10, scale: 2, nullable: true })
  quickRatio?: number;

  @Column({ type: "decimal", precision: 10, scale: 2, nullable: true })
  interestCoverage?: number;

  // Growth Metrics
  @Column({ type: "decimal", precision: 10, scale: 4, nullable: true })
  revenueGrowth?: number;

  @Column({ type: "decimal", precision: 10, scale: 4, nullable: true })
  earningsGrowth?: number;

  @Column({ type: "decimal", precision: 10, scale: 4, nullable: true })
  epsGrowth?: number;

  // Per Share Metrics
  @Column({ type: "decimal", precision: 10, scale: 2, nullable: true })
  eps?: number; // Earnings Per Share

  @Column({ type: "decimal", precision: 10, scale: 2, nullable: true })
  bookValue?: number;

  @Column({ type: "decimal", precision: 10, scale: 2, nullable: true })
  dividendYield?: number;

  // Market Data
  @Column({ type: "bigint", nullable: true })
  marketCap?: number;

  @Column({ type: "bigint", nullable: true })
  revenue?: number;

  @Column({ type: "bigint", nullable: true })
  netIncome?: number;

  @Column({ type: "bigint", nullable: true })
  totalDebt?: number;

  @Column({ type: "bigint", nullable: true })
  totalEquity?: number;

  @Column({ type: "bigint", nullable: true })
  totalAssets?: number;

  // Cash Flow
  @Column({ type: "bigint", nullable: true })
  operatingCashFlow?: number;

  @Column({ type: "bigint", nullable: true })
  freeCashFlow?: number;

  // Metadata
  @Column({ type: "varchar", length: 50, nullable: true })
  sector?: string;

  @Column({ type: "varchar", length: 100, nullable: true })
  industry?: string;

  @Column({ type: "varchar", length: 50, default: "yahoo" })
  dataSource!: string;

  @Column({ type: "decimal", precision: 5, scale: 2, default: 100 })
  dataQuality!: number; // 0-100 percentage of fields populated

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
