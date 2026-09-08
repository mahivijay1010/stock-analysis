// Shared API types.
//
// v2 product upgrade (docs/upgrade-spec.md §2, §10): the frontend has four
// primary destinations (Watchlist / Holdings / Discover / Track Record) plus
// the Stock Detail drill-down and the secondary Sandbox (old paper desk).
// Types for removed features (Sensei, allocation builder, Kelly sizing,
// execution feedback, options skew, daily plan/goals, holdings calculator,
// ensemble voting) were deleted with their endpoints. New B2 contracts
// (auth / watchlist / transactions / holdings) are read tolerantly — the
// backend slice may land in parallel, so every new field is optional and
// consumers degrade honestly on 404.

export interface Bar {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Quote {
  ticker: string;
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  dayHigh: number | null;
  dayLow: number | null;
  volume: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  currency: string;
  asOf: string; // ISO
  marketState?: string | null;
}

export type Horizon = 1 | 3 | 7 | 15 | 30;

export const HORIZONS: Horizon[] = [1, 3, 7, 15, 30];

/** Calendar-day horizon → approximate trading days (used only for chart spacing; from spec). */
export const HORIZON_TRADING_DAYS: Record<Horizon, number> = { 1: 1, 3: 2, 7: 5, 15: 10, 30: 21 };

export interface HorizonPrediction {
  horizonDays: Horizon;
  expectedReturnPct: number;
  low80Pct: number;
  high80Pct: number;
  expectedPrice: number;
  lowPrice: number;
  highPrice: number;
  directionProb: number; // 0..1
}

export type Recommendation = 'BUY' | 'HOLD' | 'AVOID';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface Signal {
  name: string;
  direction: 'bullish' | 'bearish' | 'neutral';
  weight: number;
  detail: string;
}

export interface Technicals {
  rsi14: number | null;
  macd: { line: number; signal: number; histogram: number } | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  bollinger: { upper: number; middle: number; lower: number; percentB: number } | null;
  atr14: number | null;
  annualVolatilityPct: number | null;
  week52: { high: number; low: number; positionPct: number } | null;
  volumeRatio20d: number | null;
  returns: { r5dPct: number | null; r20dPct: number | null; r60dPct: number | null };
}

export interface QuantAnalysis {
  score: number; // 0..100
  recommendation: Recommendation;
  riskLevel: RiskLevel;
  signals: Signal[];
  reasons: { positive: string[]; negative: string[] };
  technicals: Technicals;
  predictions: HorizonPrediction[];
}

export interface ProjectionCell {
  horizonDays: Horizon;
  expectedValue: number;
  lowValue: number;
  highValue: number;
  expectedProfit: number;
}

export interface ProjectionRow {
  amount: number;
  byHorizon: ProjectionCell[];
}

export interface BacktestHorizonStats {
  horizonDays: Horizon;
  samples: number;
  /** Risk-spec Rule 3: raw ÷ horizon overlap — the honest evidence count. */
  effectiveIndependentSamples?: number;
  directionHitRatePct: number;
  avgAbsErrorPct: number;
  avgPredictedPct: number;
  avgActualPct: number;
  withinBandPct: number;
  /** V6 — mean((directionProb − outcome)²), 4dp; 0 perfect, 0.25 = always saying 50%. */
  brierScore?: number;
  /** V6 — reliability buckets over stated P(up). */
  probBuckets?: CalibrationBucket[];
}

export interface SearchResult {
  ticker: string;
  name: string;
  exchange: string;
}

export interface AnalyzeAccuracy {
  testDays: number;
  horizons: BacktestHorizonStats[];
  ranAt: string;
}

export interface AnalyzeChart {
  bars: Bar[];
  sma20: (number | null)[];
  sma50: (number | null)[];
  sma200: (number | null)[];
}

/* ---- News radar (kept: timestamped items; the hype gauge UI was removed) ---- */

export interface NewsItem {
  title: string;
  source: string;
  publishedAt: string; // ISO
  url: string;
  sentiment: number; // -1..1
  ageHours: number;
  decayWeight: number; // 0..1
}

export interface NewsSummary {
  items: NewsItem[]; // ≤ 12, newest first, deduped across sources
  sentimentScore: number; // -100..100, decay-weighted mean of item sentiments
  hypeTemperature: number; // still emitted by the backend; no longer rendered as a gauge
  fresh24hCount: number;
  assessment: string; // human summary quoting real numbers
  caveat: string; // REQUIRED: keyword sentiment is crude/manipulable; verify vs filings
  asOf: string;
}

/* ---- Monte Carlo (folds into the single forecast chart as its band) ---- */

export interface MonteCarloHorizon {
  horizonDays: Horizon;
  pop: number; // P(return > 0), 0..1
  pDown10: number; // P(≤−10%)
  pDown20: number; // P(≤−20%)
  pUp10: number; // P(≥+10%)
  percentiles: { p5: number; p25: number; p50: number; p75: number; p95: number }; // % returns
}

export interface MonteCarloForecast {
  paths: number;
  method: string;
  horizons: MonteCarloHorizon[];
  note: string;
}

export type EntryAction = 'BUY_TODAY' | 'WAIT' | 'AVOID_ENTRY';

export interface EntryTiming {
  action: EntryAction;
  score: number; // 0..100
  reasons: string[]; // every reason quotes real values
  waitFor: string | null; // when WAIT: the concrete condition to wait for
  newsAware: boolean;
}

export interface AnalyzeResponse {
  ticker: string;
  name: string;
  exchange: string;
  currency: 'INR';
  quote: Quote;
  analysis: QuantAnalysis;
  projections: ProjectionRow[];
  accuracy: AnalyzeAccuracy | null;
  chart: AnalyzeChart;
  dataStatus: 'live' | 'cached';
  disclaimer: string;
  /** V2 — 8-phase framework report. */
  framework?: FrameworkReport | null;
  /** V2 — entry/stop/target plan; null when recommendation is AVOID. */
  tradePlan?: TradePlan | null;
  /** V2 — present only when `amount` was sent with the request. */
  investmentPlan?: InvestmentPlan | null;
  /** V5 — news radar; null when both news sources failed (analysis continues). */
  news?: NewsSummary | null;
  /** V5 — bootstrap Monte Carlo forecast. */
  monteCarlo?: MonteCarloForecast;
  /** V5 — "buy today or wait" timing lean (heuristic baseline, pending Phase D validation). */
  entryTiming?: EntryTiming;
  /** V5 — 1y beta vs NIFTY; null if <100 overlapping days. */
  beta1y?: number | null;
}

export interface AccuracyPerStock {
  ticker: string;
  name: string;
  hitRate1d: number | null;
  hitRate7d: number | null;
  hitRate30d: number | null;
  samples: number;
}

export interface AccuracyResponse {
  overall: BacktestHorizonStats[];
  perStock: AccuracyPerStock[];
  updatedAt: string;
  methodology: string;
  /** Honest warning about overlapping per-stock backtest windows. */
  perStockCaveat?: string;
}

export interface UniverseStockRow {
  ticker: string;
  name: string;
  sector: string;
  price?: number | null;
  changePercent?: number | null;
  score?: number | null;
  recommendation?: Recommendation | null;
  riskLevel?: RiskLevel | null;
  analyzedAt?: string | null; // latest Analysis row timestamp
  entryAction?: EntryAction | null;
}

/* ---- 8-phase framework (rendered as the condensed "Reasons & risks" accordion) ---- */

export type PhaseStatus = 'done' | 'partial' | 'unavailable';
export type PhaseCheckResult = 'pass' | 'fail' | 'neutral' | 'no-data';

export interface PhaseCheck {
  name: string;
  result: PhaseCheckResult;
  value: string;
}

export interface PhaseResult {
  phase: number;
  name: string;
  status: PhaseStatus;
  score: number | null;
  weight: number;
  checks: PhaseCheck[];
  missing: string[];
}

export type FrameworkVerdict = 'STRONG_CANDIDATE' | 'WATCH' | 'PASS' | 'NO_DATA';

export interface FrameworkReport {
  phases: PhaseResult[];
  masterScore: number | null;
  verdict: FrameworkVerdict;
  coverage: { done: number; partial: number; unavailable: number };
  weightsUsed: Record<string, number>;
}

/* ---- Amount-aware trade plan ---- */

export interface TradePlan {
  entry: number;
  stopLoss: number;
  stopLossPct: number;
  target: number;
  targetPct: number;
  rewardRiskRatio: number;
  meetsRewardRisk: boolean;
  note: string;
}

export interface InvestmentPlan {
  amount: number;
  shares: number;
  invested: number;
  cashLeft: number;
  maxLossAtStop: number; // ₹
  gainAtTarget: number; // ₹
  positionSizing2pct: { riskBudget: number; suggestedShares: number; suggestedInvestment: number; note: string };
  estimatedFees: { perSide: number; roundTrip: number; roundTripPct: number; note: string };
  projections: ProjectionRow;
  warnings: string[];
}

/** Amount accepted by POST /api/analyze (₹ 100 .. 10,00,00,000). */
export const AMOUNT_MIN = 100;
export const AMOUNT_MAX = 10_00_00_000;

/* ---- Sandbox (paper trading desk — secondary navigation, records preserved) ---- */

export type TradeSide = 'BUY' | 'SELL';
export type TradeStatus = 'OPEN' | 'CLOSED';
export type PositionAdvice =
  | 'HOLD'
  | 'SELL_NOW_STOP_HIT'
  | 'BOOK_PROFIT_TARGET_HIT'
  | 'EXIT_MOMENTUM_LOST'
  | 'RAISE_STOP_TRAIL';

export interface PaperTrade {
  id: number | string;
  ticker: string;
  name: string;
  side: TradeSide;
  qty: number;
  price: number;
  fees: number;
  executedAt: string;
  status: TradeStatus;
  stopLoss: number | null;
  target: number | null;
  exitPrice: number | null;
  exitAt: string | null;
  realizedPnl: number | null;
  note: string | null;
}

export interface OpenPosition {
  trade: PaperTrade;
  livePrice: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  advice: PositionAdvice;
  adviceReason: string;
}

export interface EquityPoint {
  date: string;
  equity: number;
}

/** Goal/milestone machinery was removed from the product (spec §2 row 13). */
export interface AdminAccountResponse {
  account: { name: string; startCapital: number; cash: number };
  equity: number;
  openPositions: OpenPosition[];
  realizedPnl: number;
  equityCurve: EquityPoint[];
  /** Full paper-trade history (backend attaches it under `history`). */
  history?: PaperTrade[];
  /** Legacy key some responses used for the same list. */
  trades?: PaperTrade[];
}

/** Daily 3%-of-equity loss circuit-breaker (kept; now read from the prediction audit). */
export interface LossGuard {
  limitPct: number;
  limit: number; // ₹ cap for today
  todayRealizedPnl: number;
  openUnrealizedPnl: number;
  effectiveDrawdown: number;
  halted: boolean;
  message: string;
}

/**
 * Sandbox settings. The backend currently rejects updates with an honest 400
 * (the destructive reset path was removed pending rework) — the UI surfaces
 * that server message verbatim.
 */
export interface AdminSettingsRequest {
  startCapital?: number;
}

export interface RecordTradeRequest {
  ticker: string;
  side: TradeSide;
  qty: number;
  price?: number; // defaults to live quote on the backend
}

/* ---- Calibration (Track Record) ---- */

/** One reliability bucket over the stated P(up): [pLow, pHigh). */
export interface CalibrationBucket {
  pLow: number;
  pHigh: number;
  n: number;
  meanPredicted: number; // 0..1
  observedUpFreq: number; // 0..1
}

export interface CalibrationHorizon {
  horizonDays: Horizon;
  samples: number;
  brierScore: number;
  /** Always 0.25 — the "always say 50%" honesty reference. */
  coinFlipBrier: number;
  /** (0.25 − brier) / 0.25 × 100 — positive = better than coin flip. */
  skillPct: number;
  buckets: CalibrationBucket[];
}

/** Live (logged-before-outcome) Brier from VERIFIED predictions; null below 10 samples. */
export interface CalibrationLiveRow {
  horizonDays: number;
  samples: number;
  brierScore: number | null;
}

export interface CalibrationResponse {
  backtest: CalibrationHorizon[];
  live: CalibrationLiveRow[];
  interpretation: string;
  methodology: string;
  updatedAt: string;
  /**
   * Historical per-model aggregate (the retired six-model experiment). The
   * backend no longer computes this block; it is read tolerantly so the
   * protected diagnostics table renders archived evidence if a backend ever
   * ships it, and hides otherwise.
   */
  models?: CalibrationModelsAggregate | null;
  modelDrift?: ModelDrift | null;
}

/* ---- Research brief (GET /api/research/:ticker — read-only since B1) ---- */

export interface ResearchVerdict {
  recommendation: string;
  entryAction: string;
  quantScore: number;
  masterScore: number | null;
  riskLevel: string;
  timingScore: number;
}

export interface ResearchKeyNumber {
  label: string;
  value: string;
}

export interface ResearchForecastRow {
  horizonDays: number;
  expectedPct: number;
  low80Pct: number;
  high80Pct: number;
  pop: number | null; // bootstrap scenario frequency of a gain; null = unavailable
}

export interface ResearchBrief {
  ticker: string;
  name: string;
  sector: string | null;
  generatedAt: string;
  verdict: ResearchVerdict;
  thesis: string;
  bullCase: string[];
  bearCase: string[];
  keyNumbers: ResearchKeyNumber[];
  forecast: ResearchForecastRow[];
  newsContext: string;
  risks: string[];
  accuracyContext: string;
  disclaimer: string;
  predictionEngine?: string | null;
  modelUsed?: string | null;
}

/* ---- Prediction audit (GET /api/admin/prediction-audit) ---- */

export interface VerifiedPredictionRow {
  ticker: string;
  predictionDate: string;
  horizonDays: number;
  targetDate: string | null;
  predictedPct: number;
  low80Pct: number | null;
  high80Pct: number | null;
  actualPct: number;
  hit: boolean;
  withinBand: boolean | null;
  errorPct: number;
  recommendationGiven: string | null;
}

export interface LivePredictionStats {
  horizonDays: number;
  samples: number;
  hitRatePct: number;
  avgAbsErrorPct: number;
  withinBandPct: number | null;
}

export interface TradeReviewRow {
  ticker: string;
  name: string | null;
  qty: number;
  entry: number;
  exit: number | null;
  stopLoss: number | null;
  target: number | null;
  realizedPnl: number | null;
  outcome: 'TARGET_HIT' | 'STOPPED_OUT' | 'MANUAL_EXIT';
  planNote: string;
  exitAt: string | null;
}

export interface TradeStats {
  closedTrades: number;
  winRatePct: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  expectancy: number | null;
  note: string;
}

export interface PredictionAuditResponse {
  recent: VerifiedPredictionRow[];
  pendingCount: number;
  liveStats: LivePredictionStats[];
  baseline: BacktestHorizonStats[];
  verdict: string;
  tradeReview: TradeReviewRow[];
  tradeStats: TradeStats;
  lossGuard: LossGuard;
  methodology: string;
  updatedAt: string;
}

/* ---- Historical model-pool aggregate (protected diagnostics only) ---- */

export interface ModelStat {
  brier: number;
  hitRatePct?: number | null;
  samples: number;
}

export interface ModelHorizonStat {
  horizonDays?: number;
  brier?: number | null;
  hitRatePct?: number | null;
  samples?: number | null;
}

export interface ModelDrift {
  updatedAt?: string | null;
  switches?: number | null;
  note?: string | null;
}

export interface CalibrationModelRow {
  model?: string;
  name?: string;
  horizons?: ModelHorizonStat[] | Record<string, ModelStat | number> | null;
}

export interface CalibrationModelsWrapper {
  perModel: CalibrationModelRow[];
  blended?: ModelHorizonStat[] | null;
  engineBaseline?: Array<{ horizonDays: number; samples?: number; brier: number }> | null;
  bestByHorizon?: Array<{ horizonDays: number; model: string; brier: number }> | null;
  note?: string | null;
}

/** Tolerant union — normalized by `normalizeModelAggregate` in lib/models.ts. */
export type CalibrationModelsAggregate =
  | CalibrationModelsWrapper
  | CalibrationModelRow[]
  | Array<{ horizonDays?: number; models?: Record<string, ModelStat | number> | null }>
  | Record<string, Record<string, ModelStat | number> | ModelHorizonStat[]>;

/* ---- Rank universe (Discover's momentum-rank sort; evaluation keeper) ---- */

export interface RankComponents {
  momentum?: number | null;
  quality?: number | null;
  sentiment?: number | null;
}

export type RankComponentStatus = Partial<Record<string, string | null>> | string | null;

export interface RankRow {
  ticker: string;
  name: string;
  sector: string;
  composite: number;
  /** Rank percentile 0–100 (higher = stronger vs the universe). */
  percentile: number;
  components?: RankComponents | null;
  componentStatus?: RankComponentStatus;
  qualitySource?: string | null;
}

/** Measured Spearman IC of rank vs realized forward 30d return — never simulated/backfilled. */
export interface RankIC {
  value: number;
  samples: number;
  since?: string | null;
}

/** Coverage of stored Intelligence metrics feeding the rank quality pillar. */
export type IntelligenceCoverage =
  | number
  | string
  | {
      count?: number | null;
      covered?: number | null;
      tickers?: number | null;
      total?: number | null;
      note?: string | null;
    }
  | null;

export interface RankUniverseResponse {
  asOf: string;
  rows: RankRow[];
  /** null until ≥ 20 snapshot days with matured forwards exist. */
  ic: RankIC | null;
  note?: string | null;
  methodology?: string | null;
  intelligenceCoverage?: IntelligenceCoverage;
  coverage?: IntelligenceCoverage;
  intelligenceNote?: string | null;
}

/* ---- Volatility forecast (labeled diagnostic, out of the primary flow) ---- */

export type VolRegime = 'elevated' | 'normal' | 'calm';

export interface VolForecastResponse {
  ticker: string;
  forecast1dVolPct: number | null;
  forecast5dVolPct: number | null;
  historicalAvgVolPct: number | null;
  regime: VolRegime;
  medianVol1yPct?: number | null;
  oosSamples?: number | null;
  sizingHint?: string | null;
  r2InSample: number | null;
  r2OutOfSample: number | null;
  method?: string | null;
  note?: string | null;
  vixDeltaR2?: number | null;
  r2OutOfSampleHar?: number | null;
  r2OutOfSampleHarX?: number | null;
  repoRatePct?: number | null;
}

/* ---- Forecast Lock (sandbox: purchase-day predictions vs reality) ---- */

export interface LockedForecastHorizon {
  expectedPrice: number;
  lowPrice: number;
  highPrice: number;
  expectedReturnPct: number;
  targetDate: string; // YYYY-MM-DD
}

export interface ForecastLock {
  lockedAt: string;
  baseClose: number;
  h7?: LockedForecastHorizon | null;
  h30?: LockedForecastHorizon | null;
}

export interface ForecastLockVerdict {
  actualPrice: number;
  actualDate: string;
  actualReturnPct: number;
  withinBand: boolean;
  directionHit: boolean;
  errorPct: number;
}

export interface ForecastLockLive {
  price?: number | null;
  vsBaseClosePct?: number | null;
  positionPnl?: number | null;
}

export interface ForecastLockRow {
  tradeId: string;
  ticker: string;
  name?: string | null;
  qty: number;
  tradeStatus: TradeStatus;
  buyPrice: number;
  buyDate: string; // YYYY-MM-DD (IST)
  lock: ForecastLock;
  live?: ForecastLockLive | null;
  daysElapsed?: number | null;
  daysRemaining30?: number | null;
  status: 'TRACKING' | 'MATURED';
  verdict7?: ForecastLockVerdict | null;
  verdict30?: ForecastLockVerdict | null;
}

export interface ForecastLocksResponse {
  rows: ForecastLockRow[];
  note: string;
  updatedAt: string;
}

/* ================================================================== */
/* B2 contracts — auth / watchlist / transactions / holdings.          */
/* Built in parallel with the backend slice (implementation-plan §3.3);*/
/* every field is optional-tolerant and every consumer shows an honest */
/* "backend pending" state on 404 instead of fabricating data.         */
/* ================================================================== */

/* ---- Accounts / auth ---- */

export interface AuthAccount {
  id?: number | string;
  email?: string | null;
  name?: string | null;
}

export type AuthStatus =
  /** Session cookie valid — private views render. */
  | { status: 'authenticated'; account: AuthAccount }
  /** Auth endpoint exists and says: not signed in — show the login screen. */
  | { status: 'unauthenticated' }
  /** Auth endpoints not shipped yet (404) — private views degrade honestly without a fake login wall. */
  | { status: 'unavailable'; note: string };

export interface LoginRequest {
  email: string;
  password: string;
}

/* ---- Watchlist (an item means "I follow this stock" — never a purchase) ---- */

/** Product horizon labels (spec §9): short ≤30 calendar days · medium 31–365 · long >365. */
export type HorizonBucket = 'short' | 'medium' | 'long';

export const HORIZON_BUCKET_LABELS: Record<HorizonBucket, string> = {
  short: 'Short · ≤30d',
  medium: 'Medium · 31–365d',
  long: 'Long · >365d',
};

export interface WatchlistItem {
  id: number | string;
  ticker: string;
  name?: string | null;
  note?: string | null;
  /** User-selected holding horizon (product label, not a tax classification). */
  horizon?: HorizonBucket | string | null;
  createdAt?: string | null;
}

export interface NewWatchlistItemRequest {
  ticker: string;
  note?: string;
  horizon?: HorizonBucket;
}

/* ---- Transactions / holdings (immutable ledger; corrections link, never edit) ---- */

export type TransactionType = 'BUY' | 'SELL' | 'DIVIDEND' | 'SPLIT' | 'CORRECTION';

export interface TransactionRecord {
  id: number | string;
  ticker: string;
  name?: string | null;
  type: TransactionType | string;
  /** Executed date (YYYY-MM-DD or ISO). */
  executedAt: string;
  qty?: number | null;
  price?: number | null;
  grossAmount?: number | null;
  /** Separately recorded charges; null/absent = unknown (flagged, never zeroed). */
  charges?: number | null;
  /** True when the execution price was estimated (e.g. day's close) — labeled in the UI. */
  priceEstimated?: boolean | null;
  /** Correction linkage — a corrected transaction is superseded, not edited. */
  correctsId?: number | string | null;
  correctedBy?: number | string | null;
  note?: string | null;
  createdAt?: string | null;
}

export interface NewTransactionRequest {
  ticker: string;
  type: 'BUY' | 'SELL' | 'DIVIDEND';
  executedAt: string; // YYYY-MM-DD
  qty?: number;
  /** Provide price OR grossAmount; contradictory combinations are rejected. */
  price?: number;
  grossAmount?: number;
  charges?: number;
  /** Explicit confirmation that an estimated price may be used (spec §3). */
  priceEstimated?: boolean;
  /** Client-generated idempotency key — safe retries, safe CSV re-imports. */
  idempotencyKey?: string;
  note?: string;
}

export interface HoldingPosition {
  ticker: string;
  name?: string | null;
  qty: number;
  /** Remaining FIFO cost basis including allocated purchase charges (₹). */
  costBasis?: number | null;
  avgCost?: number | null;
  invested?: number | null;
  currentPrice?: number | null;
  priceAsOf?: string | null;
  marketValue?: number | null;
  unrealizedPnl?: number | null;
  unrealizedPnlPct?: number | null;
  realizedPnl?: number | null;
  /** Freshness of the marking price, when the backend states it. */
  dataStatus?: string | null;
}

export interface HoldingsTotals {
  invested?: number | null;
  costBasis?: number | null;
  marketValue?: number | null;
  unrealizedPnl?: number | null;
  realizedPnl?: number | null;
}

export interface HoldingsResponse {
  positions: HoldingPosition[];
  totals?: HoldingsTotals | null;
  asOf?: string | null;
  note?: string | null;
}

/* ── Restored keeper types (Discover + Stock Detail chart) ──────────────── */

export type ChartRange = '7d' | '15d' | '1mo' | '3mo' | '6mo' | '1y' | '5y';
export const CHART_RANGES: ChartRange[] = ['7d', '15d', '1mo', '3mo', '6mo', '1y', '5y'];

export interface ChartResponse {
  ticker: string;
  range: ChartRange;
  bars: Bar[];
  sma20: (number | null)[];
  sma50: (number | null)[];
  sma200: (number | null)[];
}

export interface TopPick {
  rank: number;
  ticker: string;
  name: string;
  sector: string;
  price: number;
  changePercent: number;
  score: number;
  recommendation: Recommendation;
  riskLevel: RiskLevel;
  topReasons: string[];
  predictions: HorizonPrediction[];
  projections: ProjectionRow[];
  entryAction?: EntryAction;
  entryScore?: number;
}

export interface TopPicksResponse {
  asOf: string;
  universeSize: number;
  scannedCount: number;
  maxPrice: number | null;
  affordableCount: number | null;
  note: string;
  picks: TopPick[];
  /** Risk-spec Rule 15 buckets — setups grouped honestly; only gate-passed
   *  stocks appear under bestNewEntries (empty today rather than padded). */
  buckets?: {
    bestNewEntries: TopPick[];
    strongButExtended: TopPick[];
    watchForPullback: TopPick[];
    highRiskMomentum: TopPick[];
    insufficientEdgeCount: number;
  };
  bestNewEntriesNote?: string;
}

/* ------------------------------------------------------------------ */
/* Phase C — immutable forecast issuances (upgrade-spec §5)            */
/* ------------------------------------------------------------------ */

export interface ForecastDayPrices {
  p05: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  mean: number;
}

export interface ForecastOutcomeView {
  state: 'pending' | 'verified' | 'no_session' | 'missing_data';
  observedClose: number | null;
  realizedReturnPct: number | null;
  insideBand80: boolean | null;
  insideBand90: boolean | null;
}

export interface ForecastDay {
  date: string; // IST calendar date
  marketState: 'expected_session' | 'weekend' | 'expected_closed';
  tradingDayOffset: number | null;
  prices: ForecastDayPrices | null; // null on closed days — no prediction exists
  medianReturnPct: number | null;
  pop: number | null;
  carriesForwardFrom: string | null;
  outcome: ForecastOutcomeView | null;
}

export interface ForecastIssuance {
  runId: string;
  ticker: string;
  viewKind: 'next30' | 'month';
  periodKey: string | null;
  revision: number;
  issuedAt: string;
  featureCutoffAt: string;
  anchorSessionDate: string;
  anchorPrice: number;
  priceBasis: string;
  windowStart: string;
  windowEnd: string;
  targetSessionCount: number;
  versions: { model: string; calibration: string; policy: string };
  inputHash: string;
  days: ForecastDay[];
  realityCheck: string;
}

export type DailyForecastResponse =
  | { available: true; view: ForecastIssuance }
  | { available: false; reason: string };

export interface MonthForecastResponse {
  period: string;
  ticker: string;
  original: ForecastIssuance | null;
  latestOutlook: ForecastIssuance | null;
  actuals: Array<{ date: string; close: number }>;
  realityCheck: string;
}

export interface HoldingsProjectionRow {
  ticker: string;
  qty: number;
  costBasis: number;
  anchorSessionDate: string;
  horizonDate: string;
  value: { p10: number; p50: number; p90: number };
  pnl: { p10: number; p50: number; p90: number };
  pop: number | null;
  runId: string;
}

export interface HoldingsProjectionResponse {
  positions: HoldingsProjectionRow[];
  unavailable: string[];
  note: string;
}

/* ------------------------------------------------------------------ */
/* Unified portfolio (owner request 2026-09-06): watchlist ∪ holdings  */
/* with month forecast + decision + horizon per row, one read.        */
/* ------------------------------------------------------------------ */

export interface OverviewMonthForecast {
  period: string;
  monthEnd: string;
  anchorPrice: number;
  anchorDate: string;
  medianPrice: number;
  p10: number;
  p90: number;
  medianReturnPct: number | null;
  issuedAt: string;
  revision: number;
}

export interface OverviewDecision {
  status: string;
  evidenceStatus: string;
  riskLevel: string;
  asOf: string;
  validUntil: string;
  expired: boolean;
  topReason: string | null;
  horizon: { label: string | null; reasons: string[]; evidenceStatus: string } | null;
}

export interface PortfolioOverviewRow {
  instrumentId: string;
  ticker: string;
  name: string;
  watch: { itemId: string; userHorizon: string; note: string | null } | null;
  held: {
    qty: number;
    costBasis: number;
    avgCostPerShare: number | null;
    unrealizedGrossPnl: number | null;
    realizedPnl: number;
  } | null;
  price: { current: number; asOf: string | null; source: string | null } | null;
  monthForecast: OverviewMonthForecast | null;
  decision: OverviewDecision | null;
}

export interface PortfolioOverviewResponse {
  asOf: string;
  period: string;
  rows: PortfolioOverviewRow[];
  totals: {
    followed: number;
    held: number;
    costBasis: number;
    unrealizedGrossPnl: number | null;
    realizedPnl: number;
  };
  notes: string[];
}

export interface DecisionScoreCard {
  version: string;
  setupScore: number | null;
  technicalScore: number | null;
  momentumScore: number | null;
  valuationScore: number | null;
  fundamentalScore: number | null;
  businessQualityScore: number | null;
  entryTimingScore: number | null;
  risk: { score: number | null; band: 'low' | 'medium' | 'high' | 'unknown'; reasons: string[] };
  dataQuality: { score: number; penalties: string[] };
  forecastConfidence: {
    score: number;
    band: 'LOW' | 'MEDIUM' | 'HIGH';
    brierSkill: number | null;
    effectiveSamples: number | null;
    reasons: string[];
  };
  overallOpportunityScore: number | null;
  caption: string;
}

export interface DecisionExpectedValue {
  version: string;
  horizonDays: number;
  expectedReturnPct: number;
  expectedUpsidePct: number;
  expectedDownsidePct: number;
  scenarioFrequencyUp: number | null;
  scenarioFrequencyDown: number | null;
  transactionCostPct: number;
  evAfterCostsPct: number;
  expectedShortfallPct: number;
  rewardRiskRatio: number | null;
  notionalInr: number;
  notes: string[];
}

export interface DecisionSnapshotView {
  id: string;
  ticker: string;
  decisionStatus: 'BUY_CANDIDATE' | 'WAIT' | 'AVOID_NEW_ENTRY' | 'INSUFFICIENT_EVIDENCE';
  evidenceStatus: 'VALIDATED' | 'PARTIAL' | 'INSUFFICIENT';
  riskLevel: string;
  intendedHorizon: string;
  reasons: string[];
  risks: string[];
  holdingsReviewNote: string;
  horizonSuitability: { label: string | null; reasons: string[]; evidenceStatus: string } | null;
  /** Risk-spec T1 fields — null on snapshots published before 2026-09-07. */
  scoreCard?: DecisionScoreCard | null;
  expectedValue?: DecisionExpectedValue | null;
  existingHolderAction?: 'HOLD' | 'REVIEW' | 'INSUFFICIENT_DATA' | null;
  holderReasons?: string[] | null;
  unmetGates?: Array<{ gate: string; current: string; required: string }> | null;
  /** Phase 7: calibrated-or-refused direction probability (never a raw prob dressed as calibrated). */
  inputs?: {
    directionProbability?: {
      horizonDays: number;
      calibratedProbability: number | null;
      calibratorType: string | null;
      status: 'calibrated' | 'unavailable';
      statement: string;
    } | null;
  } | null;
  asOf: string;
  validUntil: string;
  modelVersion: string;
  decisionPolicyVersion: string;
}

export type DecisionResponse =
  | { available: true; expired: boolean; snapshot: DecisionSnapshotView }
  | { available: false; reason: string };

/* ---- AI Investment Committee (risk-spec Rule 13): advisory + cap-only ---- */

export interface CommitteeReviewView {
  action: string;
  newEntryAction: string;
  existingHolderAction: string;
  confidence: number;
  confidenceBand: 'LOW' | 'MEDIUM' | 'HIGH';
  setupScore: number;
  entryScore: number;
  topPositiveFactors: string[];
  topNegativeFactors: string[];
  missingCriticalEvidence: string[];
  invalidationConditions: string[];
  betterEntryConditions: string[];
  riskSummary: string;
  reasoningSummary: string;
  modelDisagreement: string;
  dataTimestamp: string;
}

export interface AiReviewRecord {
  id: string;
  ticker: string;
  promptVersion: string;
  modelName: string;
  provider: string;
  response: CommitteeReviewView;
  clamped: boolean;
  clampNotes: string[] | null;
  latencyMs: number;
  createdAt: string;
}

export interface CommitteeLatestResponse {
  available: boolean;
  review: AiReviewRecord | null;
  note: string;
}
