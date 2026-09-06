import { DataSource } from "typeorm";
import {
  Stock,
  Analysis,
  StockHistory,
  StockMetrics,
  RateLimitLog,
  CronExecutionLog,
  TrainingSample,
  ModelRegistry,
  PredictionLog,
  ModelPerformance,
  User,
  Portfolio,
  Position,
  Watchlist,
  Alert,
  FundamentalData,
  SentimentData,
  MarketContext,
  PaperAccount,
  PaperTrade,
  EnsembleWeight,
  RankSnapshot,
  KellyDrift,
  IntelligenceSource,
  FinancialFact,
  IntelligenceMetric,
  IntelligenceEvidence,
  MacroObservation,
  Account,
  Instrument,
  InstrumentAlias,
  WatchlistItem,
  LedgerTransaction,
  LedgerLotAllocation,
  TradingSession,
  ForecastRun,
  ForecastPoint,
  ForecastOutcome,
} from "../entities";
import * as dotenv from "dotenv";

dotenv.config();

/**
 * TypeORM Data Source Configuration
 * Establishes connection to PostgreSQL database
 * Manages entities, migrations, and synchronization
 */
export const AppDataSource = new DataSource({
  type: "postgres",
  host: process.env.DB_HOST || "localhost",
  port: Number.parseInt(process.env.DB_PORT || "5432"),
  username: process.env.DB_USERNAME || "postgres",
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE || process.env.DB_NAME || "stock_analysis",
  // Schema changes ONLY via reviewed migrations (docs/implementation-plan.md §1).
  // synchronize must stay false unconditionally — the live DB holds user state
  // and historical records that auto-DDL previously resurrected/dropped.
  synchronize: false,
  migrationsTableName: "migrations",
  logging: process.env.NODE_ENV === "development",
  entities: [
    Stock,
    Analysis,
    StockHistory,
    StockMetrics,
    RateLimitLog,
    CronExecutionLog,
    TrainingSample,
    ModelRegistry,
    PredictionLog,
    ModelPerformance,
    User,
    Portfolio,
    Position,
    Watchlist,
    Alert,
    FundamentalData,
    SentimentData,
    MarketContext,
    PaperAccount,
    PaperTrade,
    EnsembleWeight,
    RankSnapshot,
    KellyDrift,
    IntelligenceSource,
    FinancialFact,
    IntelligenceMetric,
    IntelligenceEvidence,
    MacroObservation,
    Account,
    Instrument,
    InstrumentAlias,
    WatchlistItem,
    LedgerTransaction,
    LedgerLotAllocation,
    TradingSession,
    ForecastRun,
    ForecastPoint,
    ForecastOutcome,
  ],
  migrations: [__dirname + "/../migrations/*.{js,ts}"],
  subscribers: [],
});

/**
 * Initialize database connection
 * @returns Promise<DataSource>
 */
export const initializeDatabase = async (): Promise<DataSource> => {
  try {
    await AppDataSource.initialize();
    console.log("✓ Database connection established successfully");
    return AppDataSource;
  } catch (error) {
    console.error("✗ Error during database initialization:", error);
    throw error;
  }
};
