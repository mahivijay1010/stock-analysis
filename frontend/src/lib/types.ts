// Shared API types — mirror REBUILD_SPEC.md Module 3 contracts exactly.

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
  marketState?: string;
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
  directionHitRatePct: number;
  avgAbsErrorPct: number;
  avgPredictedPct: number;
  avgActualPct: number;
  withinBandPct: number;
  /** V6 — mean((directionProb − outcome)²), 4dp; 0 perfect, 0.25 = always saying 50%. Optional until the V6 backend ships. */
  brierScore?: number;
  /** V6 — reliability buckets over stated P(up). Optional until the V6 backend ships. */
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

/* ---- V5 (SPEC_TIMING_NEWS.md) — news radar, Monte Carlo, entry timing ---- */

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
  hypeTemperature: number; // 0..100 — volume+intensity of FRESH news (see decay model)
  fresh24hCount: number;
  assessment: string; // human summary quoting real numbers
  caveat: string; // REQUIRED: keyword sentiment is crude/manipulable; verify vs filings
  asOf: string;
}

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
  newsAware: boolean; // true on Analyze (news+MC included), false for scan-level verdicts
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
  /** V2 — 8-phase framework report (optional until the V2 backend ships). */
  framework?: FrameworkReport | null;
  /** V2 — entry/stop/target plan; null when recommendation is AVOID. */
  tradePlan?: TradePlan | null;
  /** V2 — present only when `amount` was sent with the request. */
  investmentPlan?: InvestmentPlan | null;
  /** V5 — news radar; null when both news sources failed (analysis continues). Optional so an older backend still renders. */
  news?: NewsSummary | null;
  /** V5 — bootstrap Monte Carlo forecast. Optional so an older backend still renders. */
  monteCarlo?: MonteCarloForecast;
  /** V5 — "buy today or wait" timing lean (news-aware on Analyze). */
  entryTiming?: EntryTiming;
  /** V5 — 1y beta vs NIFTY; null if <100 overlapping days. */
  beta1y?: number | null;
  /** V7 — model-pool ensemble (SPEC_V7 A2.4); null when pool eval unavailable, absent on older backends. */
  ensemble?: EnsembleBlock | null;
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
  /** V5 — scan-level (technicals-only) entry timing. Optional until the V5 backend ships. */
  entryAction?: EntryAction;
  entryScore?: number;
}

export interface TopPicksResponse {
  asOf: string;
  universeSize: number;
  scannedCount: number;
  /** Budget filter actually applied by the backend (null when unfiltered). */
  maxPrice: number | null;
  /** How many scanned stocks trade at or under maxPrice (null when unfiltered). */
  affordableCount: number | null;
  /** Honest one-liner about how this list was ranked/filtered. */
  note: string;
  picks: TopPick[];
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
  /** V5 — honest warning about overlapping per-stock backtest windows. */
  perStockCaveat?: string;
}

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

export interface UniverseStockRow {
  ticker: string;
  name: string;
  sector: string;
  price?: number | null;
  changePercent?: number | null;
  score?: number | null;
  recommendation?: Recommendation | null;
  riskLevel?: RiskLevel | null;
  analyzedAt?: string | null; // backend emits analyzedAt (latest Analysis row timestamp)
  /** V5 — scan-level entry timing chip (BUY_TODAY / WAIT / AVOID_ENTRY). */
  entryAction?: EntryAction | null;
}

/* ================================================================== */
/* V2 — mirror REBUILD_SPEC_V2.md contracts exactly                    */
/* ================================================================== */

/* ---- Module V2-A: macro regime ---- */

export interface MarketRegime {
  regime: 'risk-on' | 'neutral' | 'risk-off';
  score: number; // 0..100
  nifty: { price: number; vs50dmaPct: number; vs200dmaPct: number; trend: 'up' | 'down' | 'sideways'; r20dPct: number };
  vix: { value: number; zone: 'calm' | 'normal' | 'elevated' | 'fear' };
  usdinr: { value: number; r60dPct: number; trend: 'strengthening-inr' | 'weakening-inr' | 'stable' };
  notes: string[];
  asOf: string;
}

/* ---- Module V2-B: 8-phase framework report ---- */

export type PhaseStatus = 'done' | 'partial' | 'unavailable';
export type PhaseCheckResult = 'pass' | 'fail' | 'neutral' | 'no-data';

export interface PhaseCheck {
  name: string;
  result: PhaseCheckResult;
  value: string; // quotes real numbers, e.g. "PEG 0.82 — pass (<1.0 strong)"
}

export interface PhaseResult {
  phase: number;
  name: string;
  status: PhaseStatus;
  score: number | null; // 0..100, null if unavailable
  weight: number;
  checks: PhaseCheck[];
  missing: string[]; // honest list of what free data cannot provide
}

export type FrameworkVerdict = 'STRONG_CANDIDATE' | 'WATCH' | 'PASS';

export interface FrameworkReport {
  phases: PhaseResult[]; // 8 entries
  masterScore: number | null; // null if <3 phases scored
  verdict: FrameworkVerdict;
  coverage: { done: number; partial: number; unavailable: number };
  weightsUsed: Record<string, number>;
}

/* ---- Module V2-C: amount-aware trade plan ---- */

export interface TradePlan {
  entry: number;
  stopLoss: number;
  stopLossPct: number;
  target: number;
  targetPct: number;
  rewardRiskRatio: number; // 3.0 per owner's rule
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
  projections: ProjectionRow; // for the exact amount
  warnings: string[];
}

/** Amount accepted by POST /api/analyze (₹ 100 .. 10,00,00,000). */
export const AMOUNT_MIN = 100;
export const AMOUNT_MAX = 10_00_00_000;

/* ---- Module V2-D: admin paper-trading desk ---- */

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

export interface GoalMilestone {
  day: number;
  target: number;
}

export interface GoalTracker {
  milestones: GoalMilestone[]; // [{day:7,target:5000},{day:15,target:10000},{day:25,target:50000},{day:30,target:100000}]
  startedAt: string;
  currentEquity: number;
  currentDay: number;
  onTrack: boolean;
  requiredDailyReturnPctToNextMilestone: number;
  achievedAvgDailyReturnPct: number;
}

export interface EquityPoint {
  date: string;
  equity: number;
}

export interface AdminAccountResponse {
  account: { name: string; startCapital: number; cash: number };
  equity: number;
  openPositions: OpenPosition[];
  realizedPnl: number;
  equityCurve: EquityPoint[];
  goals: GoalTracker;
  /** Optional: some backends attach full trade history here. */
  trades?: PaperTrade[];
  /** V2 backend attaches the full paper-trade history under `history`. */
  history?: PaperTrade[];
}

export interface DailyPick {
  ticker: string;
  name: string;
  price: number;
  qty: number;
  invested: number;
  score: number;
  directionProb7d: number; // 0..1
  entry: number;
  stopLoss: number;
  target: number;
  maxLoss: number;
  potentialGain: number;
  fees: number;
  reasons: string[];
  historicalOdds: string;
}

export interface ExitAdviceRow {
  ticker: string;
  action: string;
  reason: string;
}

/** Daily 3%-of-equity loss circuit-breaker (mirrors backend LossGuard). */
export interface LossGuard {
  limitPct: number;
  limit: number; // ₹ cap for today
  todayRealizedPnl: number;
  openUnrealizedPnl: number;
  effectiveDrawdown: number;
  halted: boolean;
  message: string;
}

export interface DailyPlanResponse {
  asOf: string;
  cash: number;
  marketRegime: MarketRegime;
  pick: DailyPick | null;
  noPickReason?: string;
  allocation: AllocationPlan | null; // multi-stock split of the available cash
  allocationReason?: string;
  exitAdvice: ExitAdviceRow[];
  goalTracker: GoalTracker;
  realityCheck: string; // REQUIRED honest string — always displayed, never dismissable
  lossGuard: LossGuard; // daily 3% loss circuit-breaker (halts new trades when tripped)
}

/* ---- Multi-stock allocation (PortfolioService) ---- */

export type PortfolioStrategy = 'short-term' | 'long-term' | 'balanced';

export interface AllocationEvidence {
  name: string;
  value: string;
  result: 'pass' | 'fail' | 'neutral' | 'no-data';
}

export interface AllocationStock {
  ticker: string;
  name: string;
  sector: string;
  price: number;
  qty: number;
  invested: number;
  weightPct: number;
  score: number;
  masterScore: number | null;
  frameworkVerdict: 'STRONG_CANDIDATE' | 'WATCH' | 'PASS' | null;
  strategyFit: string;
  evidence: AllocationEvidence[];
  directionProb7d: number | null;
  stopLoss: number | null;
  target: number | null;
  maxLoss: number | null;
  expected7dPct: number | null;
  expected30dPct: number | null;
  whyChosen: string;
  reasons: string[];
  historicalOdds: string;
  fees: number;
}

export interface AllocationOutcome {
  horizonDays: Horizon;
  expectedValue: number;
  lowValue: number;
  highValue: number;
  expectedProfit: number;
  expectedProfitPct: number;
}

export interface AllocationPlan {
  amount: number;
  strategy: PortfolioStrategy;
  cashUsed: number;
  cashLeft: number;
  cashReservePct: number;
  cashReserveReason: string;
  tranchePlan: string[] | null;
  stocks: AllocationStock[];
  outcomes: AllocationOutcome[];
  totalFeesRoundTrip: number;
  totalFeesPct: number;
  correlationNote: string;
  rationale: string[];
  warnings: string[];
  asOf: string;
}

export interface PortfolioSuggestResponse {
  amount: number;
  strategy: PortfolioStrategy;
  allocation: AllocationPlan | null;
  reason?: string;
  disclaimer: string;
}

/* ================================================================== */
/* V6 — mirror SPEC_CALIBRATION.md contracts exactly                   */
/* (new fields consumed optional-tolerantly; older backends 404)       */
/* ================================================================== */

/* ---- Module C2: GET /api/calibration ---- */

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
  /** V7 — aggregate per-model Brier table across the universe (SPEC_V7 A5.1). Absent on older backends. */
  models?: CalibrationModelsAggregate | null;
  /** V7 — online-regret weight update indicator (SPEC_V7 A3). Absent on older backends. */
  modelDrift?: ModelDrift | null;
}

/* ---- Module C3: GET /api/research/:ticker — deterministic research brief ---- */

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
  pop: number; // P(return > 0), 0..1
}

export interface ResearchBrief {
  ticker: string;
  name: string;
  sector: string | null;
  generatedAt: string;
  verdict: ResearchVerdict;
  /** 2–3 deterministic paragraphs quoting real numbers — separated by blank lines. */
  thesis: string;
  bullCase: string[];
  bearCase: string[];
  keyNumbers: ResearchKeyNumber[];
  forecast: ResearchForecastRow[];
  newsContext: string;
  risks: string[];
  accuracyContext: string;
  disclaimer: string;
  /** V7 — "Prediction engine" line: best model, its 90d Brier, blend note. Absent on older backends. */
  predictionEngine?: string | null;
  /** V7 — some backends name the same line `modelUsed` (spec A2.4 app copy). */
  modelUsed?: string | null;
}

/* ---- Sensei assistant (stocks-only chat) ---- */

export interface AssistantResponse {
  reply: string;
  suggestions: string[];
  offTopic: boolean;
}

/* ---- Admin settings (dynamic capital + target) ---- */

export interface AdminSettingsRequest {
  startCapital?: number; // requires confirmReset: true — resets the challenge
  targetAmount?: number;
  targetDays?: number;
  confirmReset?: boolean;
}

export interface RecordTradeRequest {
  ticker: string;
  side: TradeSide;
  qty: number;
  price?: number; // defaults to live quote on the backend
}

/* ---- Holdings P&L calculator (stateless what-if tool) ---- */

export interface HoldingCalcRequest {
  ticker: string;
  buyPrice?: number; // provide this OR buyDate
  buyDate?: string; // YYYY-MM-DD
  quantity?: number; // provide this OR amount
  amount?: number; // ₹ invested
}

export interface HoldingForwardProjection {
  horizonDays: Horizon;
  expectedValue: number;
  lowValue: number;
  highValue: number;
  expectedProfit: number;
  expectedProfitPct: number;
}

export interface HoldingCalcResponse {
  ticker: string;
  name: string;
  buyPrice: number;
  buyDateRequested: string | null;
  buyDateUsed: string | null;
  currentPrice: number;
  dataStatus: 'live' | 'cached';
  asOf: string;
  quantity: number;
  invested: number;
  currentValue: number;
  grossProfit: number;
  grossProfitPct: number;
  fees: { buy: number; sell: number; roundTrip: number };
  netProfit: number;
  netProfitPct: number;
  daysHeld: number | null;
  annualizedReturnPct: number | null;
  niftyComparison: { returnPct: number; outperformancePct: number } | null;
  recommendation: Recommendation;
  score: number;
  forwardProjections: HoldingForwardProjection[];
  note: string;
}

/* ---- Prediction audit (GET /api/admin/prediction-audit) ---- */

/** One prediction that has matured and been verified against the real close. */
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

/** Live (logged-before-outcome) accuracy per horizon — the honest counterpart of the backtest baseline. */
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

/* ================================================================== */
/* V7 — mirror SPEC_V7.md (Adaptive Calibration Engine) contracts      */
/* All new fields are optional-tolerant: older backends omit them or   */
/* 404 the new endpoints, and every consumer hides itself gracefully.  */
/* ================================================================== */

/** V7 — the six lightweight direction models in the pool (spec A1). */
export type ModelName = 'momentum' | 'meanReversion' | 'trend' | 'volAdjusted' | 'sentiment' | 'macro';

/** Walk-forward stats for one model at one horizon (spec A2). */
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

/** Best model for this (ticker, horizon) by stored walk-forward Brier. */
export interface EnsembleBestModel {
  name: string;
  brier: number;
  samples: number;
}

/** One inverse-Brier softmax weight row (spec A2.3). weightPct sums ≈ 100 across models. */
export interface EnsembleWeightRow {
  model: string;
  weightPct: number;
  brier: number | null;
}

/**
 * One exact feature contribution of the selected linear model — honest triage:
 * this is the model's own arithmetic (real explainability), NOT a causal claim
 * about the market. Backends may send preformatted strings or structured rows.
 */
export interface FeatureContributionObj {
  feature?: string;
  name?: string;
  label?: string;
  /** z-scored feature value, e.g. +0.8 (σ). */
  value?: number | null;
  z?: number | null;
  /** Δ probability contributed, e.g. +0.06. */
  contribution?: number | null;
  deltaProb?: number | null;
  /** Preformatted line, e.g. "r20 +0.8σ → +0.06 prob". */
  detail?: string | null;
  text?: string | null;
}
export type FeatureContribution = FeatureContributionObj | string;

/** V7 — ensemble block on AnalyzeResponse (spec A2.4); null when the pool eval is unavailable. */
export interface EnsembleBlock {
  /** Blended P(up) per horizon, 0..1 (JSON keys may arrive as strings). */
  blendedProbUp?: Partial<Record<Horizon, number>> | null;
  bestModel?: EnsembleBestModel | null;
  weights?: EnsembleWeightRow[] | null;
  note?: string | null;
  /** Exact feature contributions of the best model, when provided. */
  featureContributions?: FeatureContribution[] | null;
  /** Alternate key some backends use for the same list. */
  contributions?: FeatureContribution[] | null;
}

/** V7 — online-regret weight drift indicator (spec A3), attached to /api/calibration. */
export interface ModelDrift {
  updatedAt?: string | null;
  switches?: number | null;
  note?: string | null;
}

/** Canonical model-major aggregate row for /api/calibration `models` (spec A5.1). */
export interface CalibrationModelRow {
  model?: string;
  name?: string;
  horizons?: ModelHorizonStat[] | Record<string, ModelStat | number> | null;
}

/**
 * Wrapper the backend actually ships (mirrors src/types CalibrationModels):
 * model-major rows plus aggregate meta series that are NOT pool models.
 */
export interface CalibrationModelsWrapper {
  perModel: CalibrationModelRow[];
  /** Out-of-sample blended-ensemble aggregate (online inverse-Brier weights). */
  blended?: ModelHorizonStat[] | null;
  /** V6 single-model baseline brier per horizon (for the honest delta). */
  engineBaseline?: Array<{ horizonDays: number; samples?: number; brier: number }> | null;
  /** Lowest-brier model per horizon (aggregate). */
  bestByHorizon?: Array<{ horizonDays: number; model: string; brier: number }> | null;
  note?: string | null;
}

/**
 * Aggregate per-model table embedded in /api/calibration as `models`.
 * The backend is built in parallel, so the reader tolerates every sane shape:
 *  - wrapper object:      { perModel: [{ model, horizons: [...] }], blended, engineBaseline, bestByHorizon, note }
 *  - model-major array:   [{ model, horizons: [{ horizonDays, brier, hitRatePct, samples }] }]
 *  - horizon-major array: [{ horizonDays, models: { momentum: { brier, ... }, ... } }]
 *  - record by model:     { momentum: { "7": { brier, ... }, ... }, ... }
 * Normalized by `normalizeModelAggregate` in lib/models.ts.
 */
export type CalibrationModelsAggregate =
  | CalibrationModelsWrapper
  | CalibrationModelRow[]
  | Array<{ horizonDays?: number; models?: Record<string, ModelStat | number> | null }>
  | Record<string, Record<string, ModelStat | number> | ModelHorizonStat[]>;

/* ================================================================== */
/* V8 — mirror SPEC_V8.md (Alpha Pivot: rank / vol / options / Kelly)  */
/* Every endpoint 404s on an older backend; all consumers hide         */
/* gracefully. Fields are optional-tolerant — never assume presence.   */
/* ================================================================== */

/* ---- R1: GET /api/rank/universe ---- */

/** Cross-sectional z-scores (clamped ±3): momentum60d ×0.5, quality ×0.3, sentimentDecay ×0.2. */
export interface RankComponents {
  momentum?: number | null;
  quality?: number | null;
  sentiment?: number | null;
}

/**
 * Per-component data status ('ok' | 'fallback' | 'no-data'; tolerant to new labels).
 * Backends may send a per-component record or a single string (spec context:
 * stocks without a cached NewsSummary get sentiment z=0 and status 'no-data').
 */
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
  /** Labeled quality provenance, e.g. 'roe' | 'operating-margin' (the stated fallback). */
  qualitySource?: string | null;
}

/** Measured Spearman IC of rank vs realized forward 30d return — never simulated/backfilled. */
export interface RankIC {
  value: number;
  samples: number;
  since?: string | null;
}

export interface RankUniverseResponse {
  asOf: string;
  rows: RankRow[];
  /** null until ≥ 20 snapshot days with matured forwards exist. */
  ic: RankIC | null;
  /** Honest note, e.g. "IC unlocks after ~7 weeks of snapshots — collecting since <date>". V10 may append the intelligence coverage count. */
  note?: string | null;
  /** Backend's own methodology line (preferred over the frontend fallback when present). */
  methodology?: string | null;
  /** V10 B1 — stored-intelligence coverage count (rotating nightly refresh, full universe in ~3 weeks). Tolerant to number / {covered,total} / preformatted string. */
  intelligenceCoverage?: IntelligenceCoverage;
  /** V10 B1 — alternate key some backends use for the same coverage block. */
  coverage?: IntelligenceCoverage;
  /** V10 B1 — dedicated coverage note when the backend separates it from the IC note. */
  intelligenceNote?: string | null;
}

/* ---- R2: GET /api/volatility/forecast/:ticker ---- */

export type VolRegime = 'elevated' | 'normal' | 'calm';

export interface VolForecastResponse {
  ticker: string;
  /** Annualized vol %, 1-day-ahead HAR-RV forecast. */
  forecast1dVolPct: number | null;
  forecast5dVolPct: number | null;
  /** 22d realized vol, annualized — the "historical avg" comparison. */
  historicalAvgVolPct: number | null;
  /** Forecast vs 1y median: >1.25× elevated, <0.8× calm. */
  regime: VolRegime;
  /** 1y median realized vol the regime is judged against (backend extra). */
  medianVol1yPct?: number | null;
  /** Number of walk-forward days behind r2OutOfSample (backend extra). */
  oosSamples?: number | null;
  /** Present when elevated: "reduce position ~X% to keep rupee-risk equal to a median-vol day". */
  sizingHint?: string | null;
  r2InSample: number | null;
  /** Walk-forward (no lookahead) over the last ~60 days — the honest number. */
  r2OutOfSample: number | null;
  method?: string | null;
  /** REQUIRED caveat: daily-proxy RV (r²) is noisier than true intraday HAR-RV. */
  note?: string | null;
  /** V10 B2 — OOS R² delta from adding the prev-day India VIX regressor (HAR-X − plain HAR); the winner is used and named in `method`. */
  vixDeltaR2?: number | null;
  /** V10 B2 — both walk-forward OOS R²s when the backend fits both models (plain HAR vs HAR-X). */
  r2OutOfSampleHar?: number | null;
  r2OutOfSampleHarX?: number | null;
  /** V10 B2 — RBI repo rate context chip (display only — NEVER a regressor; rare policy moves are unfitable on ~250 daily obs). */
  repoRatePct?: number | null;
}

/* ---- R3: GET /api/options/skew/:ticker ---- */

export type OptionsSkewStatus = 'ok' | 'NOT_AVAILABLE';
export type OptionsSignal = 'HEDGING_SPIKE' | 'NEUTRAL';

/** Every numeric is null when status is NOT_AVAILABLE (probe blocked — widget hides entirely). */
export interface OptionsSkewResponse {
  ticker: string;
  status: OptionsSkewStatus;
  /** Σ put OI / Σ call OI, nearest expiry. */
  pcr: number | null;
  pcr5dAvg: number | null;
  /** Mean IV of OTM puts − OTM calls (~25-delta equivalent), %. */
  ivSkewPct: number | null;
  signal: OptionsSignal | null;
  expiry: string | null;
  asOf: string | null;
  note?: string | null;
  /** NOT_AVAILABLE evidence: HTTP code / Akamai marker from the live probe. */
  reason?: string | null;
  probedAt?: string | null;
}

/* ---- R4: GET /api/position-size/:ticker?capital= ---- */

/** A measured Kelly input with its provenance (per-stock vs universe fallback vs structural assumption). */
export interface KellyInput {
  value: number | null;
  source: string;
  samples: number | null;
}

export interface PositionSizeResponse {
  ticker: string;
  capital: number;
  /** p — measured direction hit rate (0..1). V9: this stays the MODEL block. */
  winRate: KellyInput;
  /** b — measured avg win / avg loss (fallback 1.5 stated as structural assumption). V9: model block. */
  payoff: KellyInput;
  /** f* = p − (1−p)/b, clamped [0, 0.25]. V9: recomputed from the APPLIED pair. */
  kellyFraction: number;
  /** THE headline: half of f* — estimation-error safety. */
  halfKelly: number;
  /** halfKelly × capital, ₹. */
  recommendedAmount: number;
  sharesAtLivePrice: number | null;
  /** Live price used for the share count (backend extra). */
  livePrice?: number | null;
  warnings: string[];
  /** Kelly maximizes log growth ONLY if p/b are right; half-Kelly halves drawdowns for ~75% of growth. */
  note: string;
  /** Zero-edge copy when f* ≤ 0: "no edge measured — do not size up; minimum position or skip". */
  recommendation?: string | null;
  /** V9 — YOUR measured desk history (closed paper trades). Absent on older backends. */
  measured?: MeasuredKellyBlock | null;
  /** V9 — which (p, b) pair the headline was recomputed from (see KELLY_APPLIED_PAIRS; tolerant to new labels). */
  applied?: string | null;
  /** V9 — honest model-vs-YOUR-history comparison line, rendered verbatim. */
  comparison?: string | null;
}

/* ================================================================== */
/* V9 — mirror SPEC_V9.md (Execution Feedback Loop) contracts          */
/* GET /api/execution/summary 404s on an older backend — the desk      */
/* feedback card hides itself. position-size V9 fields are optional.   */
/* ================================================================== */

/** V9 — the three (p, b) selection outcomes of the adaptive-Kelly rule (SPEC_V9 E2). */
export const KELLY_APPLIED_PAIRS = ['measured-p+measured-b', 'model-p+measured-b', 'model-p+structural-b'] as const;
export type KellyAppliedPair = (typeof KELLY_APPLIED_PAIRS)[number];

/** V9 — one measured Kelly input from YOUR closed desk trades (position-size `measured` block). */
export interface MeasuredKellyStat {
  value: number | null;
  samples: number;
  usable: boolean;
}

/** V9 — measured desk-history block gained by /api/position-size/:ticker. */
export interface MeasuredKellyBlock {
  closedTrades: number;
  winRate: MeasuredKellyStat;
  payoff: MeasuredKellyStat;
  kellyFraction: number | null;
  halfKelly: number | null;
}

/** Measured-from-YOUR-closed-trades block of /api/execution/summary (last-30 window). */
export interface ExecutionMeasured {
  winRatePct: number | null;
  payoff: number | null;
  halfKellyPct: number | null;
  usableP: boolean;
  usableB: boolean;
  /** Honest reasons when p/b are not usable yet (e.g. "no losing trades yet — payoff unmeasurable"). */
  reasons: string[];
  /** Backend extras (live shape) — all optional-tolerant. */
  applied?: string | null;
  wins?: number | null;
  losses?: number | null;
  avgWin?: number | null;
  avgLoss?: number | null;
}

/** One nightly Kelly-drift snapshot (KellyDrift row, ascending by date). */
export interface ExecutionDriftPoint {
  date: string; // YYYY-MM-DD
  closedTrades: number;
  /** Measured win rate; backends may emit 0..1 or a percent — consumers normalize tolerantly. */
  measuredP: number | null;
  measuredB: number | null;
  halfKellyPct: number | null;
  applied: string;
}

export interface ExecutionSummaryResponse {
  closedTrades: number;
  window: { size: number; used: number };
  measured: ExecutionMeasured;
  /** The V8 model p source for the universe (aggregate 7d hit rate). */
  model: { winRatePct: number; source: string };
  /** Reuses the audit's expectancy formula over closed trades. */
  expectancy: { value: number | null; note: string };
  drift: ExecutionDriftPoint[];
  /** REQUIRED honesty: paper fills have zero slippage — live results will be worse by fees + slippage. */
  note: string;
  /** V10 B4 — win-rate splits by entry-context factor (or the honest unlock note). Absent on older backends — the block hides. */
  factorInsights?: FactorInsights | null;
}

/* ================================================================== */
/* V10 — mirror SPEC_V10.md (Intelligence-Driven Feedback Bridge)      */
/* Built in parallel with the backend: every field is optional and     */
/* every consumer reads tolerantly / hides itself when absent.         */
/* ================================================================== */

/**
 * V10 B1 — how many universe tickers have STORED Intelligence metrics feeding
 * the rank quality pillar. Backends may ship a bare count, a {covered, total}
 * object (extra keys tolerated) or a preformatted string.
 */
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

/**
 * V10 B3 — canonical payoff-source kinds for the Kelly b input. The backend's
 * `payoff.source` is a descriptive string containing one of these tokens
 * (e.g. "DCF-implied (assumption-sensitive — bear/base/bull scenarios, not
 * measured)"); classify with `dcf` → `structural` → `measured` in that order,
 * since the structural and DCF labels both contain the words "not measured".
 */
export type PayoffSourceKind = 'measured' | 'dcf-implied' | 'structural';

/** V10 B4 — one half of a factor split (e.g. the quantScore ≥60 side). Win rates may arrive 0..1 or 0..100. */
export interface FactorInsightSide {
  label?: string | null;
  n?: number | null;
  samples?: number | null;
  count?: number | null;
  winRatePct?: number | null;
  winRate?: number | null;
  wins?: number | null;
}

/** V10 B4 — win-rate split of closed trades by one entry-context factor (emitted only when both sides have n≥8). */
export interface FactorInsightSplit {
  factor?: string | null;
  name?: string | null;
  label?: string | null;
  threshold?: number | string | null;
  high?: FactorInsightSide | null;
  low?: FactorInsightSide | null;
  /** Alternate side keys some backends use. */
  above?: FactorInsightSide | null;
  below?: FactorInsightSide | null;
  note?: string | null;
  detail?: string | null;
}

/**
 * V10 B4 — `factorInsights` on /api/execution/summary: splits once ≥20 closed
 * trades carry entry_context snapshots, else the honest unlock note
 * ("insights unlock at 20 closed trades with entry snapshots — currently N").
 * Tolerant to a wrapper object, a bare split array or a bare note string;
 * normalized in the desk PerformanceFeedbackCard.
 */
export type FactorInsights =
  | {
      splits?: FactorInsightSplit[] | null;
      insights?: FactorInsightSplit[] | null;
      note?: string | null;
      closedWithContext?: number | null;
      withContext?: number | null;
      unlockAt?: number | null;
    }
  | FactorInsightSplit[]
  | string;

/* ================================================================== */
/* Forecast Lock — GET /api/admin/forecast-locks                       */
/* Every desk BUY freezes that day's 7d/30d forecast into the trade    */
/* (entry_context.forecastLock); this endpoint tracks live price vs    */
/* the frozen band and grades matured horizons against the REAL close  */
/* on the target date. Locks are NEVER recomputed. Optional-tolerant:  */
/* the desk card hides on 404 and reads every nested field defensively.*/
/* ================================================================== */

/** One frozen horizon (7d or 30d) of a purchase-day forecast. */
export interface LockedForecastHorizon {
  expectedPrice: number;
  lowPrice: number;
  highPrice: number;
  expectedReturnPct: number;
  /** YYYY-MM-DD — the calendar date this horizon matures on. */
  targetDate: string;
}

/** The forecast frozen at BUY time — anchor close + 7d/30d horizons. */
export interface ForecastLock {
  lockedAt: string;
  /** The close the forecast was anchored on (verdicts measure vs this, not the buy price). */
  baseClose: number;
  h7?: LockedForecastHorizon | null;
  h30?: LockedForecastHorizon | null;
}

/** Grade of one matured horizon against the REAL close on/before its target date. */
export interface ForecastLockVerdict {
  actualPrice: number;
  actualDate: string;
  actualReturnPct: number;
  withinBand: boolean;
  directionHit: boolean;
  /** |expectedReturnPct − actualReturnPct| in percentage points. */
  errorPct: number;
}

/** Live tracking of the position vs the lock's anchor close. All nullable — quotes can fail. */
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
  /** YYYY-MM-DD (IST) of the BUY. */
  buyDate: string;
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
  /** REQUIRED honesty: locks are frozen at buy time and never recomputed. */
  note: string;
  updatedAt: string;
}

/* ---- Module A4: GET /api/portfolio/stress ---- */

/** One historical worst-window scenario applied to the given portfolio. */
export interface StressScenario {
  label: string;
  portfolioReturnPct: number;
}

export interface PortfolioStressResponse {
  /** Worst 5 historical 21-trading-day windows, most damaging first. */
  scenarios: StressScenario[];
  /** Block-bootstrap 21-day drawdown percentiles (p1 ≤ p5 ≤ 0). */
  p5DrawdownPct: number;
  p1DrawdownPct: number;
  method: string;
  note: string;
  /** Plain-text risk-reduction hint (reduce weight / raise cash) — never options advice. */
  hedgeHint: string;
}
