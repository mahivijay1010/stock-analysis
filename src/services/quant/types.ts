/**
 * Module 2 — Quant engine shared types.
 * Structural duplicates of the shared types in REBUILD_SPEC.md — field names MUST stay identical.
 * This module is pure: no DB, no HTTP, no imports from other src/services.
 */

export interface Bar {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Phase 1: split/dividend-adjusted close when available (analytics use adjustedClose ?? close). */
  adjustedClose?: number | null;
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

export type Horizon = 1 | 3 | 7 | 15 | 30; // trading-day-ish horizons in calendar days

export interface HorizonPrediction {
  horizonDays: Horizon;
  expectedReturnPct: number; // e.g. 1.8 means +1.8%
  low80Pct: number;
  high80Pct: number; // 80% band on return, in pct
  expectedPrice: number;
  lowPrice: number;
  highPrice: number;
  directionProb: number; // 0..1 probability price is UP after horizon
}

export interface Signal {
  name: string;
  direction: 'bullish' | 'bearish' | 'neutral';
  weight: number;
  detail: string;
}

export interface QuantAnalysis {
  score: number; // 0..100 composite
  recommendation: 'BUY' | 'HOLD' | 'AVOID';
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  signals: Signal[];
  reasons: { positive: string[]; negative: string[] };
  technicals: {
    rsi14: number | null;
    macd: { line: number; signal: number; histogram: number } | null;
    sma20: number | null;
    sma50: number | null;
    sma200: number | null;
    bollinger: { upper: number; middle: number; lower: number; percentB: number } | null;
    atr14: number | null;
    annualVolatilityPct: number | null;
    week52: { high: number; low: number; positionPct: number } | null; // position: 0=at low, 100=at high
    volumeRatio20d: number | null; // today vol / 20d avg
    returns: { r5dPct: number | null; r20dPct: number | null; r60dPct: number | null };
  };
  predictions: HorizonPrediction[]; // exactly the 5 horizons
}

export interface ProjectionRow {
  amount: number; // 1000 | 10000 | 100000 | 1000000
  byHorizon: Array<{
    horizonDays: Horizon;
    expectedValue: number;
    lowValue: number;
    highValue: number;
    expectedProfit: number;
  }>;
}

/**
 * V6 calibration: one reliability-diagram bucket of directionProb predictions.
 * Bucket edges are [0–0.40, 0.40–0.475, 0.475–0.525, 0.525–0.60, 0.60–1].
 */
export interface ProbBucket {
  pLow: number;
  pHigh: number;
  n: number; // samples whose directionProb fell in [pLow, pHigh)
  meanPredicted: number; // mean directionProb of those samples (0 when n=0)
  observedUpFreq: number; // fraction that actually closed up (0 when n=0)
}

/**
 * V7: walk-forward stats for one direction model (or the blended ensemble)
 * at one horizon. brier = mean((probUp − outcome)²), 4dp.
 */
export interface ModelHorizonStat {
  brier: number;
  hitRatePct: number; // % where (probUp > 0.5) matched the realized direction
  samples: number;
}

export interface BacktestHorizonStats {
  horizonDays: Horizon;
  samples: number;
  /** Risk-spec Rule 3: raw ÷ horizon overlap — the honest evidence count. */
  effectiveIndependentSamples?: number;
  directionHitRatePct: number; // % of predictions where sign(predicted) === sign(actual)
  avgAbsErrorPct: number; // mean |predictedReturnPct - actualReturnPct|
  avgPredictedPct: number;
  avgActualPct: number;
  withinBandPct: number; // % of actuals inside the 80% band
  // ── V6 calibration (optional, additive — absent on rows from older runs) ──
  brierScore?: number; // mean((directionProb − outcome)²), outcome = 1 if actual>0 else 0; 4dp
  probBuckets?: ProbBucket[]; // always the 5 fixed buckets when present
  // ── V7 model pool (optional, additive — absent on rows from older runs) ──
  /** HISTORICAL rows only: per-model V7 pool stats (feature removed; keys preserved as evidence). */
  models?: Record<string, ModelHorizonStat>;
  /** HISTORICAL rows only: V7 blended-ensemble stat (feature removed; keys preserved as evidence). */
  ensemble?: ModelHorizonStat;
}

export interface BacktestResult {
  ticker: string;
  testDays: number;
  ranAt: string;
  horizons: BacktestHorizonStats[];
  samples: Array<{
    date: string;
    horizonDays: Horizon;
    predictedPct: number;
    actualPct: number;
    correct: boolean;
  }>; // most recent ≤50
}
