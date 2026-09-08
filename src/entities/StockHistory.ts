import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from "typeorm";
import { Stock } from "./Stock";

/**
 * Stock History Entity
 *
 * Stores time-series data for stock prices, volumes, and changes
 * Enables historical analysis and trend detection
 * Updated by scheduled cron jobs (twice per hour)
 */
@Entity("stock_history")
@Unique(["stockId", "tradingDate", "fetchTimestamp"])
@Index(["stockId", "tradingDate"])
@Index(["tradingDate"])
@Index(["fetchTimestamp"])
export class StockHistory {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "stock_id", type: "uuid" })
  stockId: string;

  @ManyToOne(() => Stock, (stock) => stock.history, { onDelete: "CASCADE" })
  @JoinColumn({ name: "stock_id" })
  stock: Stock;

  // Price Data
  @Column({ name: "open_price", type: "decimal", precision: 12, scale: 4 })
  openPrice: number;

  @Column({ name: "high_price", type: "decimal", precision: 12, scale: 4 })
  highPrice: number;

  @Column({ name: "low_price", type: "decimal", precision: 12, scale: 4 })
  lowPrice: number;

  @Column({ name: "close_price", type: "decimal", precision: 12, scale: 4 })
  closePrice: number;

  /** Completion Phase 1: Yahoo split/dividend-adjusted close; null pre-feature. */
  @Column({ name: "adjusted_close", type: "decimal", precision: 12, scale: 4, nullable: true })
  adjustedClose?: number | null;

  /** Split factor effective THIS ex-date (e.g. 5 for a 1:5 split); null otherwise. */
  @Column({ name: "split_factor", type: "decimal", precision: 12, scale: 6, nullable: true })
  splitFactor?: number | null;

  /** Dividend amount (₹/share) with THIS ex-date; null otherwise. */
  @Column({ name: "dividend", type: "decimal", precision: 12, scale: 4, nullable: true })
  dividend?: number | null;

  @Column({ name: "previous_close", type: "decimal", precision: 12, scale: 4, nullable: true })
  previousClose?: number;

  // Volume Data
  @Column({ name: "volume", type: "bigint" })
  volume: number;

  @Column({
    name: "volume_change_percent",
    type: "decimal",
    precision: 8,
    scale: 4,
    nullable: true,
  })
  volumeChangePercent?: number;

  // Change Metrics
  @Column({ name: "price_change", type: "decimal", precision: 12, scale: 4, nullable: true })
  priceChange?: number;

  @Column({ name: "price_change_percent", type: "decimal", precision: 8, scale: 4, nullable: true })
  priceChangePercent?: number;

  // Market Cap & Fundamentals
  @Column({ name: "market_cap", type: "bigint", nullable: true })
  marketCap?: number;

  @Column({ name: "pe_ratio", type: "decimal", precision: 10, scale: 4, nullable: true })
  peRatio?: number;

  // Metadata
  @Column({ name: "data_source", type: "varchar", length: 50, default: "alpha_vantage" })
  dataSource: string;

  @CreateDateColumn({ name: "fetch_timestamp" })
  fetchTimestamp: Date;

  @Column({ name: "trading_date", type: "date" })
  tradingDate: Date;
}
