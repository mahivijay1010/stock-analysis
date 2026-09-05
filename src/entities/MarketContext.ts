import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * MarketContext Entity
 * Stores broader market context data (indices, VIX, economic indicators)
 * Used for ML feature engineering and market regime analysis
 */
@Entity("market_context")
export class MarketContext {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "date" })
  @Index({ unique: true })
  date!: Date;

  // Indian Market Indices
  @Column({ type: "decimal", precision: 12, scale: 2, nullable: true })
  nifty50Price?: number;

  @Column({ type: "decimal", precision: 10, scale: 4, nullable: true })
  nifty50Change?: number; // Daily % change

  @Column({ type: "decimal", precision: 12, scale: 2, nullable: true })
  sensexPrice?: number;

  @Column({ type: "decimal", precision: 10, scale: 4, nullable: true })
  sensexChange?: number;

  @Column({ type: "decimal", precision: 12, scale: 2, nullable: true })
  bankNiftyPrice?: number;

  @Column({ type: "decimal", precision: 10, scale: 4, nullable: true })
  bankNiftyChange?: number;

  // Volatility Indices
  @Column({ type: "decimal", precision: 10, scale: 2, nullable: true })
  indiaVix?: number; // India VIX (volatility index)

  @Column({ type: "varchar", length: 20, default: "medium" })
  volatilityRegime!: string; // 'low', 'medium', 'high'

  // Global Market Indicators
  @Column({ type: "decimal", precision: 12, scale: 2, nullable: true })
  sp500Price?: number;

  @Column({ type: "decimal", precision: 10, scale: 4, nullable: true })
  sp500Change?: number;

  @Column({ type: "decimal", precision: 10, scale: 2, nullable: true })
  vixPrice?: number; // US VIX

  // Currency & Commodities
  @Column({ type: "decimal", precision: 10, scale: 4, nullable: true })
  usdInrRate?: number; // USD/INR exchange rate

  @Column({ type: "decimal", precision: 12, scale: 2, nullable: true })
  goldPrice?: number; // Gold price in INR

  @Column({ type: "decimal", precision: 12, scale: 2, nullable: true })
  crudeOilPrice?: number; // Crude oil price (Brent)

  // Market Breadth
  @Column({ type: "integer", nullable: true })
  nifty50AdvancingStocks?: number; // Number of stocks above their 50-day MA

  @Column({ type: "integer", nullable: true })
  nifty50DecliningStocks?: number;

  @Column({ type: "decimal", precision: 5, scale: 2, nullable: true })
  advanceDeclineRatio?: number;

  @Column({ type: "decimal", precision: 5, scale: 2, nullable: true })
  nifty50Above200DMA?: number; // % of NIFTY 50 stocks above 200-day MA

  // Trading Activity
  @Column({ type: "bigint", nullable: true })
  nseVolume?: number; // Total NSE volume

  @Column({ type: "bigint", nullable: true })
  bseVolume?: number; // Total BSE volume

  @Column({ type: "decimal", precision: 10, scale: 2, nullable: true })
  fiiNetBuying?: number; // FII net buying in crores

  @Column({ type: "decimal", precision: 10, scale: 2, nullable: true })
  diiNetBuying?: number; // DII net buying in crores

  // Economic Indicators (less frequent updates)
  @Column({ type: "decimal", precision: 5, scale: 2, nullable: true })
  inflationRate?: number; // CPI inflation (monthly)

  @Column({ type: "decimal", precision: 5, scale: 2, nullable: true })
  repoRate?: number; // RBI repo rate

  @Column({ type: "decimal", precision: 5, scale: 2, nullable: true })
  gdpGrowthRate?: number; // GDP growth (quarterly)

  @Column({ type: "decimal", precision: 10, scale: 2, nullable: true })
  bond10YearYield?: number; // 10-year government bond yield

  // Market Regime Classification
  @Column({ type: "varchar", length: 20, default: "neutral" })
  marketRegime!: string; // 'bullish', 'bearish', 'neutral', 'correction'

  @Column({ type: "varchar", length: 20, default: "sideways" })
  trendRegime!: string; // 'uptrend', 'downtrend', 'sideways'

  @Column({ type: "decimal", precision: 5, scale: 2, default: 50 })
  marketSentiment!: number; // 0-100 composite market sentiment

  // Metadata
  @Column({ type: "varchar", length: 100, default: "multi-source" })
  dataSource!: string;

  @Column({ type: "decimal", precision: 5, scale: 2, default: 100 })
  dataQuality!: number; // 0-100 percentage of fields populated

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
