import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from "typeorm";
import { Stock } from "./Stock";

/**
 * Stock Metrics Entity
 *
 * Stores calculated technical indicators and performance metrics
 * Automatically updated after each data fetch
 * Supports advanced analytics and investment decision-making
 */
@Entity("stock_metrics")
@Index(["stockId", "calculationTimestamp"])
@Index(["rsi14"])
@Index(["trendDirection"])
export class StockMetrics {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "stock_id", type: "uuid" })
  stockId: string;

  @ManyToOne(() => Stock, (stock) => stock.metrics, { onDelete: "CASCADE" })
  @JoinColumn({ name: "stock_id" })
  stock: Stock;

  // Moving Averages
  @Column({ name: "sma_20", type: "decimal", precision: 12, scale: 4, nullable: true })
  sma20?: number;

  @Column({ name: "sma_50", type: "decimal", precision: 12, scale: 4, nullable: true })
  sma50?: number;

  @Column({ name: "sma_200", type: "decimal", precision: 12, scale: 4, nullable: true })
  sma200?: number;

  @Column({ name: "ema_12", type: "decimal", precision: 12, scale: 4, nullable: true })
  ema12?: number;

  @Column({ name: "ema_26", type: "decimal", precision: 12, scale: 4, nullable: true })
  ema26?: number;

  // Momentum Indicators
  @Column({ name: "rsi_14", type: "decimal", precision: 8, scale: 4, nullable: true })
  rsi14?: number;

  @Column({ name: "macd", type: "decimal", precision: 12, scale: 4, nullable: true })
  macd?: number;

  @Column({ name: "macd_signal", type: "decimal", precision: 12, scale: 4, nullable: true })
  macdSignal?: number;

  @Column({ name: "macd_histogram", type: "decimal", precision: 12, scale: 4, nullable: true })
  macdHistogram?: number;

  // Volatility Indicators
  @Column({ name: "volatility_30d", type: "decimal", precision: 8, scale: 4, nullable: true })
  volatility30d?: number;

  @Column({ name: "bollinger_upper", type: "decimal", precision: 12, scale: 4, nullable: true })
  bollingerUpper?: number;

  @Column({ name: "bollinger_middle", type: "decimal", precision: 12, scale: 4, nullable: true })
  bollingerMiddle?: number;

  @Column({ name: "bollinger_lower", type: "decimal", precision: 12, scale: 4, nullable: true })
  bollingerLower?: number;

  // Volume Indicators
  @Column({ name: "volume_sma_20", type: "bigint", nullable: true })
  volumeSma20?: number;

  @Column({ name: "volume_momentum", type: "decimal", precision: 8, scale: 4, nullable: true })
  volumeMomentum?: number;

  @Column({ name: "price_volume_ratio", type: "decimal", precision: 12, scale: 4, nullable: true })
  priceVolumeRatio?: number;

  // Performance Metrics
  @Column({ name: "daily_return", type: "decimal", precision: 8, scale: 4, nullable: true })
  dailyReturn?: number;

  @Column({ name: "cumulative_return", type: "decimal", precision: 10, scale: 4, nullable: true })
  cumulativeReturn?: number;

  @Column({ name: "sharpe_ratio", type: "decimal", precision: 8, scale: 4, nullable: true })
  sharpeRatio?: number;

  // Trend Indicators
  @Column({ name: "trend_direction", type: "varchar", length: 20, nullable: true })
  trendDirection?: string; // 'uptrend', 'downtrend', 'sideways'

  @Column({ name: "trend_strength", type: "decimal", precision: 5, scale: 2, nullable: true })
  trendStrength?: number; // 0-100 scale

  // Metadata
  @CreateDateColumn({ name: "calculation_timestamp" })
  calculationTimestamp: Date;

  @Column({ name: "data_quality_score", type: "decimal", precision: 5, scale: 2, nullable: true })
  dataQualityScore?: number; // 0-100 data completeness
}
