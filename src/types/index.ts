/**
 * API-layer types for the Indian Stock Analysis & Prediction System.
 * Shared quant/market shapes are re-exported from the quant module so the
 * whole backend speaks one set of field names (see REBUILD_SPEC.md).
 */

import type {
  Bar,
  Quote,
  Horizon,
  HorizonPrediction,
  QuantAnalysis,
  ProjectionRow,
  BacktestHorizonStats,
  BacktestResult,
} from "../services/quant/types";

export type {
  Bar,
  Quote,
  Horizon,
  HorizonPrediction,
  Signal,
  QuantAnalysis,
  ProjectionRow,
  ProbBucket,
  BacktestHorizonStats,
  BacktestResult,
  ModelHorizonStat,
} from "../services/quant/types";

import type { Fundamentals, MarketRegime } from "../services/market/types";
export type { Fundamentals, MarketRegime } from "../services/market/types";

// Monte Carlo shapes are defined next to the pure simulator (Module N2).
import type {
  MonteCarloForecast,
} from "../services/quant/montecarlo";
export type {
  MonteCarloHorizon,
  MonteCarloForecast,
} from "../services/quant/montecarlo";

// ── V5: News radar (Module N1) ──────────────────────────────────────────────

export interface NewsItem {
  title: string;
  source: string;
  publishedAt: string; // ISO
  url: string;
  sentiment: number; // -1..1 (deterministic finance-lexicon score)
  ageHours: number;
  decayWeight: number; // 0..1, 0.5^(ageHours/48)
}

export interface NewsSummary {
  items: NewsItem[]; // ≤ 12, newest first, deduped across sources
  sentimentScore: number; // -100..100, decay-weighted mean of item sentiments
  hypeTemperature: number; // 0..100 — volume+intensity of FRESH news
  fresh24hCount: number;
  assessment: string; // human summary quoting real numbers
  caveat: string; // keyword sentiment is crude/manipulable; verify vs filings
  asOf: string;
}

// ── V5: Entry timing (Module N3) ────────────────────────────────────────────

export type EntryAction = "TIMING_OK" | "WAIT" | "AVOID_ENTRY";

export interface EntryTiming {
  action: EntryAction;
  score: number; // 0..100
  reasons: string[]; // every reason quotes real values
  waitFor: string | null; // when WAIT: the concrete condition to wait for
  newsAware: boolean; // true on Analyze (news+MC included), false for scan-level verdicts
}

// ── Requests ────────────────────────────────────────────────────────────────

export interface AnalyzeRequest {
  ticker: string; // accepts a symbol ("RELIANCE.NS") or a company name ("infosys")
  amount?: number; // optional ₹ investment amount, 100..10,00,00,000
}

// ── Responses ───────────────────────────────────────────────────────────────

/** Measured accuracy summary from the latest stored backtest for a ticker. */
export interface AccuracySummary {
  testDays: number;
  horizons: BacktestHorizonStats[];
  ranAt: string;
}

export interface ChartPayload {
  bars: Bar[]; // last ~250
  sma20: (number | null)[];
  sma50: (number | null)[];
  sma200: (number | null)[];
}

export interface AnalyzeResponse {
  ticker: string;
  name: string;
  exchange: string;
  currency: "INR";
  quote: Quote;
  analysis: QuantAnalysis; // includes predictions
  projections: ProjectionRow[]; // amounts 1000/10000/100000/1000000
  accuracy: AccuracySummary | null;
  chart: ChartPayload;
  dataStatus: "live" | "cached";
  disclaimer: string;
  // ── V2 additions ──
  framework: FrameworkReport; // 8-phase owner-methodology report (V2-B)
  macro: MarketRegime | null; // null only if the macro fetch failed
  fundamentals: Fundamentals | null; // null only if the fundamentals fetch failed
  tradePlan: TradePlan | null; // null when recommendation is AVOID
  investmentPlan: InvestmentPlan | null; // present only when `amount` was sent
  // ── V5 additions ──
  news: NewsSummary | null; // null only if BOTH news sources failed
  monteCarlo: MonteCarloForecast; // seeded bootstrap over real daily returns
  entryTiming: EntryTiming; // news-aware "buy today or wait" lean
  beta1y: number | null; // cov/var vs NIFTY daily returns; null if <100 overlapping days
  // NOTE: the V7 `ensemble` block was removed from production execution
  // (upgrade-spec §2 row 6). ensemble_weights rows remain as archived
  // experiment artifacts; no active code path reads or writes them.
}

// ── V2-B: Framework report ──────────────────────────────────────────────────

export interface PhaseCheck {
  name: string;
  result: "pass" | "fail" | "neutral" | "no-data";
  value: string; // quotes real numbers, never placeholders
}

export interface PhaseResult {
  phase: number;
  name: string; // e.g. 1, "Macro-Economic Tide"
  status: "done" | "partial" | "unavailable";
  score: number | null; // 0..100, null if unavailable
  weight: number; // owner's weights: macro .10, industry .15, fundamentals .20, valuation .20, technicals .15
  checks: PhaseCheck[];
  missing: string[]; // honest list of what free data cannot provide
}

export interface FrameworkReport {
  phases: PhaseResult[]; // 8 entries
  masterScore: number | null; // weighted avg over AVAILABLE scored phases (weights renormalized); null if <3 scored
  verdict: "STRONG_CANDIDATE" | "WATCH" | "PASS" | "NO_DATA"; // >85 / 70-85 / <70 / unscored
  coverage: { done: number; partial: number; unavailable: number };
  weightsUsed: Record<string, number>;
}

// ── V2-C: Trade plan + amount-aware investment plan ─────────────────────────

export interface TradePlan {
  entry: number; // current price
  stopLoss: number;
  stopLossPct: number; // max(2×ATR14, 5% bluechip / 7.5% if annualVol>30%) below entry
  target: number;
  targetPct: number; // entry + 3 × (entry − stopLoss) — owner's 3:1 rule
  rewardRiskRatio: number; // always 3.0
  meetsRewardRisk: boolean; // false if target exceeds the +2.5σ√21d plausibility clamp
  note: string;
}

export interface InvestmentPlan {
  amount: number;
  shares: number;
  invested: number;
  cashLeft: number;
  maxLossAtStop: number; // ₹, tradePlan stop distance × shares
  gainAtTarget: number; // ₹, tradePlan target distance × shares
  positionSizing2pct: {
    riskBudget: number;
    suggestedShares: number;
    suggestedInvestment: number;
    note: string;
  };
  estimatedFees: {
    perSide: number;
    roundTrip: number;
    roundTripPct: number;
    note: string;
  };
  projections: ProjectionRow; // for the exact amount, 5 horizons
  warnings: string[];
}

// ── V2-D: Admin trading desk ────────────────────────────────────────────────

export type PositionAdvice =
  | "HOLD"
  | "SELL_NOW_STOP_HIT"
  | "BOOK_PROFIT_TARGET_HIT"
  | "RAISE_STOP_TRAIL" // up ≥1R: move the stop to breakeven / trail it
  | "EXIT_MOMENTUM_LOST";

export interface PaperTradeView {
  id: string;
  ticker: string;
  name: string | null;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  fees: number;
  executedAt: string;
  status: "OPEN" | "CLOSED";
  stopLoss: number | null;
  target: number | null;
  exitPrice: number | null;
  exitAt: string | null;
  realizedPnl: number | null;
  note: string | null;
}

export interface OpenPositionView {
  trade: PaperTradeView;
  livePrice: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  advice: PositionAdvice;
  adviceReason: string;
}

export interface AdminAccountResponse {
  account: { name: string; startCapital: number; cash: number };
  equity: number;
  openPositions: OpenPositionView[];
  realizedPnl: number;
  equityCurve: Array<{ date: string; equity: number }>; // derived, never stored
  // NOTE: the goal/milestone tracker was removed from active execution
  // (upgrade-spec §2 row 13). PaperAccount.targetAmount/targetDays/
  // challengeStartedAt COLUMNS and values are preserved as user state.
  history: PaperTradeView[]; // full trade history, newest first
}

export interface RecordTradeRequest {
  ticker: string;
  side: "BUY" | "SELL";
  qty: number;
  price?: number; // defaults to live quote
}

export interface RecordTradeResponse {
  side: "BUY" | "SELL";
  ticker: string;
  name: string | null;
  qty: number;
  price: number;
  fees: number;
  realizedPnl: number | null; // SELL only, net of fees
  cash: number; // account cash after the trade
  trade: PaperTradeView | null; // BUY: the created lot
  closedLots: PaperTradeView[]; // SELL: lots fully/partially closed
  message: string;
}

// NOTE: the multi-stock allocation builder (PortfolioService.suggest) and the
// Sensei assistant were REMOVED from the product (upgrade-spec §2 rows 5/12);
// their request/response types went with them.

// ── Admin account settings (dynamic capital + target) ──────────────────────

export interface AdminSettingsRequest {
  startCapital?: number; // requires confirmReset: true — resets the challenge
  targetAmount?: number;
  targetDays?: number;
  confirmReset?: boolean;
}

// NOTE: GET /api/admin/daily-plan (pick + cash-split + goal tracker +
// reality check) was REMOVED (upgrade-spec §2 rows 5/13). The loss-guard
// remains, surfaced via the prediction audit.

export interface TopPick {
  rank: number;
  ticker: string;
  name: string;
  sector: string;
  price: number;
  changePercent: number;
  score: number;
  recommendation: "BUY" | "HOLD" | "AVOID";
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  topReasons: string[];
  predictions: HorizonPrediction[];
  projections: ProjectionRow[];
  // V5: technical-only entry timing (newsAware=false at scan level).
  entryAction: EntryAction;
  entryScore: number;
}

export interface TopPicksResponse {
  asOf: string;
  universeSize: number;
  scannedCount: number;
  /** Budget filter applied (₹ max price per share), null = no filter. */
  maxPrice: number | null;
  /** How many scanned stocks were affordable under maxPrice (null when unfiltered). */
  affordableCount: number | null;
  /** Honest note about how the list was ranked/filtered. */
  note: string;
  picks: TopPick[];
  /** Risk-spec Rule 15 buckets: setups grouped honestly; only gate-passed
   *  stocks appear under bestNewEntries (empty today — stated, not padded). */
  buckets: {
    bestNewEntries: TopPick[];
    strongButExtended: TopPick[];
    watchForPullback: TopPick[];
    highRiskMomentum: TopPick[];
    insufficientEdgeCount: number;
  };
  bestNewEntriesNote: string;
}

// ── Prediction audit (the validation loop: predicted vs real, explained) ────

export interface VerifiedPredictionRow {
  ticker: string;
  predictionDate: string;
  horizonDays: number;
  targetDate: string | null;
  predictedPct: number;
  low80Pct: number | null;
  high80Pct: number | null;
  actualPct: number;
  hit: boolean; // direction correct
  withinBand: boolean | null; // actual inside the predicted 80% band
  errorPct: number; // |predicted − actual|
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
  outcome: "TARGET_HIT" | "STOPPED_OUT" | "MANUAL_EXIT";
  planNote: string;
  exitAt: string | null;
}

export interface TradeStats {
  closedTrades: number;
  winRatePct: number | null;
  avgWin: number | null; // ₹, winners only
  avgLoss: number | null; // ₹, losers only (positive number)
  expectancy: number | null; // ₹ per trade = win%×avgWin − loss%×avgLoss
  note: string;
}

/** Prop-desk daily loss limit — when hit, no new trades today. */
export interface LossGuard {
  limitPct: number; // % of current equity
  limit: number; // ₹
  todayRealizedPnl: number;
  openUnrealizedPnl: number;
  effectiveDrawdown: number; // ₹ counted against the limit (≤ 0)
  halted: boolean;
  message: string;
}

export interface PredictionAuditResponse {
  recent: VerifiedPredictionRow[]; // newest first, ≤ 60
  pendingCount: number; // predictions awaiting maturity/verification
  liveStats: LivePredictionStats[]; // measured on VERIFIED live predictions
  baseline: BacktestHorizonStats[]; // walk-forward backtest baseline
  verdict: string; // honest live-vs-baseline comparison
  tradeReview: TradeReviewRow[]; // closed paper trades classified vs their plan
  tradeStats: TradeStats;
  lossGuard: LossGuard;
  methodology: string;
  updatedAt: string;
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
  // V5: honest warning about overlapping backtest windows per stock.
  perStockCaveat: string;
  disclaimer: string;
}

// ── V6: Calibration dashboard (SPEC_CALIBRATION Module C2) ─────────────────

import type { ProbBucket } from "../services/quant/types";

export interface CalibrationHorizon {
  horizonDays: Horizon;
  samples: number;
  brierScore: number; // sample-weighted mean across ModelPerformance rows, 4dp
  coinFlipBrier: 0.25;
  skillPct: number; // (0.25 − brier) / 0.25 × 100
  buckets: ProbBucket[]; // pooled: n summed, means weighted by n
}

export interface CalibrationLiveHorizon {
  horizonDays: number;
  samples: number; // VERIFIED PredictionLog rows for this horizon
  brierScore: number | null; // null when samples < 10 (too few to be honest)
}

export interface CalibrationResponse {
  backtest: CalibrationHorizon[];
  live: CalibrationLiveHorizon[];
  interpretation: string; // plain-language read computed from the real numbers
  methodology: string;
  updatedAt: string;
}

// ── V6: Research brief (SPEC_CALIBRATION Module C3) ─────────────────────────

export interface ResearchBrief {
  ticker: string;
  name: string;
  sector: string | null;
  generatedAt: string;
  verdict: {
    recommendation: string;
    entryAction: string;
    quantScore: number;
    masterScore: number | null;
    riskLevel: string;
    timingScore: number;
  };
  thesis: string; // 2–3 paragraphs, deterministic template quoting REAL values
  bullCase: string[]; // reasons.positive + passing framework checks (≤5)
  bearCase: string[]; // reasons.negative + failing checks (≤5)
  keyNumbers: Array<{ label: string; value: string }>;
  forecast: Array<{
    horizonDays: number;
    expectedPct: number;
    low80Pct: number;
    high80Pct: number;
    /** Bootstrap scenario frequency of a gain; NULL when unavailable (never a substituted heuristic — audit §4). */
    pop: number | null;
  }>;
  newsContext: string; // NewsSummary.assessment or quiet-tape line
  risks: string[];
  accuracyContext: string; // this ticker's measured hit rates + honesty line
  disclaimer: string;
}

// ── V7 A4: portfolio stress + portfolio calibration ─────────────────────────

export interface StressScenario {
  label: string; // e.g. "2025-02-10 → 2025-03-12 (NIFTY −7.4%)"
  portfolioReturnPct: number; // beta-mapped portfolio return for the window
}

export interface PortfolioStressResponse {
  tickers: Array<{ ticker: string; weightPct: number; beta1y: number | null }>;
  /** Worst historical windows, ordered worst-first. */
  scenarios: StressScenario[];
  p5DrawdownPct: number; // block-bootstrap 5th-percentile worst point, ≤ 0
  p1DrawdownPct: number; // 1st percentile, ≤ p5
  method: string;
  note: string;
  hedgeHint: string; // plain-text risk reduction — never fabricated options advice
  asOf: string;
}

export interface PortfolioCalibrationTickerHorizon {
  horizonDays: Horizon;
  brier: number | null; // null when this ticker has no stored calibration
  hitRatePct: number | null;
  samples: number;
}

export interface PortfolioCalibrationHorizon {
  horizonDays: Horizon;
  weightedBrier: number | null; // weight-blended across tickers with data
  weightedHitRatePct: number | null;
  samples: number; // total backtest samples underlying the blend
  coveragePct: number; // % of portfolio weight that had stored stats
}

export interface PortfolioCalibrationResponse {
  perTicker: Array<{
    ticker: string;
    weightPct: number;
    horizons: PortfolioCalibrationTickerHorizon[];
  }>;
  horizons: PortfolioCalibrationHorizon[];
  note: string;
  updatedAt: string;
}

export type ChartRange = "7d" | "15d" | "1mo" | "3mo" | "6mo" | "1y" | "5y";

export interface ChartResponse extends ChartPayload {
  ticker: string;
  range: ChartRange;
}

export interface UniverseStockRow {
  ticker: string;
  name: string;
  sector: string;
  price: number | null;
  changePercent: number | null;
  score: number | null;
  recommendation: string | null;
  riskLevel: string | null;
  analyzedAt: string | null;
  // V5: entry chip from the latest scan snapshot (null when never scanned).
  entryAction?: EntryAction | null;
}

// ── Envelope ────────────────────────────────────────────────────────────────

export interface SuccessEnvelope<T> {
  success: true;
  data: T;
}

export interface ErrorEnvelope {
  success: false;
  error: { message: string };
}

/** Error with an HTTP status code the error middleware understands. */
export class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

// ── Holdings P&L calculator (stateless — no persistence; usable from the
// Analyze tab for the stock being viewed, and from Admin as a standalone
// what-if tool) ───────────────────────────────────────────────────────────

export interface HoldingCalcRequest {
  ticker: string;
  buyPrice?: number; // provide this OR buyDate (buyPrice wins if both given)
  buyDate?: string; // YYYY-MM-DD — resolved to the nearest trading-day close on/before this date
  quantity?: number; // provide this OR amount (quantity wins if both given)
  amount?: number; // ₹ invested amount; quantity = floor(amount / buyPrice)
}

export interface HoldingForwardProjection {
  horizonDays: Horizon;
  expectedValue: number; // quantity × predicted price at this horizon
  lowValue: number;
  highValue: number;
  expectedProfit: number; // vs `invested` (the original cost basis)
  expectedProfitPct: number;
}

export interface HoldingCalcResponse {
  ticker: string;
  name: string;
  buyPrice: number;
  buyDateRequested: string | null;
  buyDateUsed: string | null; // actual trading-day date buyPrice was resolved to (only when buyDate was given)
  currentPrice: number;
  dataStatus: "live" | "cached";
  asOf: string;
  quantity: number;
  invested: number;
  currentValue: number;
  grossProfit: number;
  grossProfitPct: number;
  fees: { buy: number; sell: number; roundTrip: number };
  netProfit: number; // profit if sold right now, net of round-trip fees
  netProfitPct: number;
  daysHeld: number | null; // only when buyDate was given
  annualizedReturnPct: number | null; // only when daysHeld > 0
  niftyComparison: { returnPct: number; outperformancePct: number } | null; // only when buyDate resolved within available NIFTY history
  recommendation: "BUY" | "HOLD" | "AVOID";
  score: number;
  forwardProjections: HoldingForwardProjection[]; // 5 horizons, from the SAME quant predictions used elsewhere
  note: string; // plain-English summary, composed from the real numbers above
}

export const DISCLAIMER =
  "This is an educational analysis tool, not SEBI-registered investment advice. " +
  "Markets are inherently uncertain: every prediction is a statistical estimate with an 80% range, " +
  "and measured past accuracy does not guarantee future results. Do your own research before investing.";

// ── V8 R1: relative-strength rank (GET /api/rank/universe) ──────────────────

export type RankComponentStatusValue = "ok" | "no-data";

export interface RankUniverseRow {
  ticker: string;
  name: string;
  sector: string;
  composite: number;
  percentile: number; // 0..100
  components: { momentum: number; quality: number; sentiment: number }; // clamped z-scores
  componentStatus: {
    momentum: RankComponentStatusValue;
    /** V10 B1 — 'intelligence (n inputs)' | 'quoteSummary fallback' | 'no-data'. */
    quality: string;
    sentiment: RankComponentStatusValue;
  };
  /** Which source fed the quality z — honest labeling of the fallback chain. */
  qualitySource: "intelligence" | "roe" | "operating-margin" | null;
}

/** V10 B1 — how many universe tickers have stored Intelligence metrics. */
export interface RankIntelligenceCoverage {
  covered: number;
  total: number;
  note: string;
}

export interface RankIcBlock {
  value: number; // mean daily Spearman IC
  samples: number; // snapshot days measured
  since: string; // earliest snapshot date (YYYY-MM-DD)
}

export interface RankUniverseResponse {
  asOf: string;
  rows: RankUniverseRow[];
  ic: RankIcBlock | null; // null until ≥20 days of snapshots have matured forwards
  note: string;
  methodology: string;
  /** V10 B1 — stored-intelligence coverage (rotating nightly refresh builds it). */
  intelligenceCoverage: RankIntelligenceCoverage;
}

// ── V8 R2: volatility forecast (GET /api/volatility/forecast/:ticker) ───────

export interface VolatilityForecastResponse {
  ticker: string;
  forecast1dVolPct: number | null; // annualized %
  forecast5dVolPct: number | null; // annualized %
  historicalAvgVolPct: number | null; // 22d realized, annualized %
  medianVol1yPct: number | null; // 1y median of rolling 22d realized vol
  regime: "elevated" | "normal" | "calm" | null;
  sizingHint: string | null; // present when elevated
  r2InSample: number | null;
  r2OutOfSample: number | null; // walk-forward, last ≤60 days — the CHOSEN model's
  oosSamples: number;
  /** V10 B2 — which model the forecast uses: 'HAR-X' | 'HAR' (the OOS winner). */
  method: string;
  /** The full formula/measurement description (was `method` before V10). */
  methodology: string;
  /** V10 B2 — plain-HAR walk-forward OOS R² (same days as HAR-X when both fit). */
  r2OutOfSampleHar: number | null;
  /** V10 B2 — HAR-X walk-forward OOS R² (null when VIX missing/unfittable). */
  r2OutOfSampleHarX: number | null;
  /** V10 B2 — HAR-X OOS R² − plain HAR OOS R². */
  vixDeltaR2: number | null;
  /** V10 B2 — RBI repo rate % from STORED macro observations: CONTEXT ONLY,
   *  never a regressor (rare policy moves are unfitable on ~250 daily obs). */
  repoRatePct: number | null;
  note: string;
}

// NOTE: the options-skew radar (permanently Akamai-blocked), consumer Kelly
// position sizing, and the adaptive execution-feedback summary were REMOVED
// (upgrade-spec §2 rows 6/9/11). kelly_drift rows are preserved as archived
// experiment artifacts.

// ── V10 B4: entry-context snapshot + factor insights ─────────────────────────

/**
 * Snapshot of what the system believed at BUY time, stored on the PaperTrade
 * row (nullable jsonb). Values come ONLY from data already computed in the
 * buy path — anything not available at that moment is honestly null.
 */
/** One frozen horizon forecast captured at BUY time — never recomputed. */
export interface LockedForecastHorizon {
  expectedPrice: number;
  lowPrice: number;
  highPrice: number;
  expectedReturnPct: number; // vs baseClose, as stated by the model at lock time
  targetDate: string; // buy date + horizon calendar days (YYYY-MM-DD, IST)
}

/**
 * Forecast Lock — the purchase-day prediction, frozen so reality can grade it.
 * Anchored on baseClose (the last bar the model saw), NOT the fill price.
 */
export interface ForecastLock {
  lockedAt: string; // ISO
  baseClose: number;
  h7: LockedForecastHorizon | null;
  h30: LockedForecastHorizon | null;
}

export interface EntryContextSnapshot {
  quantScore: number | null; // 0-100 quant engine score from the buy-path analysis
  masterScore: number | null; // 8-phase framework score (null — not computed on BUY)
  entryTimingScore: number | null; // cached scan's entry-timing score, if fresh
  intelligenceQuality: number | null; // stored-metrics quality score (0-100), if covered
  regime: string | null; // cached macro regime (risk-on/neutral/risk-off), if warm
  forecastLock?: ForecastLock | null; // frozen purchase-day forecast (trades made before this feature: absent)
}

/** Verdict once a locked forecast matures (30 calendar days elapsed). */
export interface ForecastLockVerdict {
  actualPrice: number; // real close on/before the target date
  actualDate: string;
  actualReturnPct: number; // vs baseClose — same basis the model stated
  withinBand: boolean;
  directionHit: boolean;
  errorPct: number; // |expectedReturnPct − actualReturnPct|
}

export interface ForecastLockRow {
  tradeId: string;
  ticker: string;
  name: string | null;
  qty: number;
  tradeStatus: "OPEN" | "CLOSED";
  buyPrice: number;
  buyDate: string; // YYYY-MM-DD IST
  lock: ForecastLock;
  live: { price: number | null; vsBaseClosePct: number | null; positionPnl: number | null };
  daysElapsed: number;
  daysRemaining30: number; // 0 when matured
  status: "TRACKING" | "MATURED";
  verdict7: ForecastLockVerdict | null; // once ≥7 calendar days
  verdict30: ForecastLockVerdict | null; // once ≥30 calendar days
}

export interface ForecastLocksResponse {
  rows: ForecastLockRow[]; // newest first, ≤50
  note: string; // honest: frozen at purchase, never recomputed; pre-feature trades absent
  updatedAt: string;
}

/** One side of a factor split (e.g. the quantScore ≥60 half). */
export interface FactorInsightSideStat {
  label: string;
  n: number;
  wins: number;
  winRatePct: number;
}

/** Win-rate split of closed trades by one entry-context factor. */
export interface FactorInsightSplit {
  factor: string;
  threshold: number | string;
  high: FactorInsightSideStat;
  low: FactorInsightSideStat;
  /** high.winRatePct − low.winRatePct, percentage points. */
  deltaPp: number;
}

export interface FactorInsightsBlock {
  /** True once ≥20 closed trades carry entry-context snapshots. */
  unlocked: boolean;
  closedWithContext: number;
  required: number; // 20
  minPerSide: number; // 8 — splits with a thinner side are suppressed as noise
  splits: FactorInsightSplit[];
  note: string;
}
