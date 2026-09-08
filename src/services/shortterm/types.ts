/**
 * SHORT-TERM TRADE RADAR — shared contracts (S1).
 *
 * Positional short-term trading on COMPLETED daily bars (1–21 trading days).
 * Intraday is explicitly out of scope: adding it later requires its own
 * validation methodology (spec). Quotes are used for display and stop/target
 * monitoring only — never to confirm signals.
 */

export const SHORT_TERM_VERSION = "short-term-v1";
export const SHORT_TERM_POLICY_VERSION = "st-policy-v1";
export const SHORT_TERM_FEATURE_VERSION = "st-features-v1";

export type ShortTermHorizon = "1-3d" | "3-5d" | "5-10d" | "10-21d";
export const HORIZON_TD: Record<ShortTermHorizon, { min: number; max: number; mid: number }> = {
  "1-3d": { min: 1, max: 3, mid: 2 },
  "3-5d": { min: 3, max: 5, mid: 4 },
  "5-10d": { min: 5, max: 10, mid: 7 },
  "10-21d": { min: 10, max: 21, mid: 15 },
};
export const DEFAULT_HORIZON: ShortTermHorizon = "5-10d";

export type SetupType =
  | "PULLBACK_IN_UPTREND"
  | "BREAKOUT_CONFIRMATION"
  | "MOMENTUM_CONTINUATION"
  | "VOLATILITY_CONTRACTION"
  | "MEAN_REVERSION"
  | "FAILED_BREAKOUT"
  | "LATE_TREND"
  | "HIGH_EVENT_RISK"
  | "NO_SETUP";

export type StrategyFilter = "ALL" | "PULLBACK" | "BREAKOUT" | "MOMENTUM" | "MEAN_REVERSION";

export const STRATEGY_SETUPS: Record<Exclude<StrategyFilter, "ALL">, SetupType[]> = {
  PULLBACK: ["PULLBACK_IN_UPTREND"],
  BREAKOUT: ["BREAKOUT_CONFIRMATION", "VOLATILITY_CONTRACTION"],
  MOMENTUM: ["MOMENTUM_CONTINUATION"],
  MEAN_REVERSION: ["MEAN_REVERSION"],
};

/** User-facing short-term action vocabulary (never bare BUY/SELL). */
export type ShortTermAction =
  | "NO_TRADE"
  | "WATCH"
  | "WAIT_FOR_ENTRY"
  | "ENTRY_ZONE"
  | "BREAKOUT_CONFIRMATION"
  | "HOLD"
  | "TAKE_PARTIAL_PROFIT"
  | "TRAIL_STOP"
  | "EXIT"
  | "INVALIDATED";

/** Candidate lifecycle states (every transition is recorded). */
export type CandidateState =
  | "SCANNED"
  | "WATCH"
  | "WAIT_FOR_ENTRY"
  | "ENTRY_READY"
  | "ACTIVE_POSITION"
  | "TARGET1_REACHED"
  | "TRAILING"
  | "EXITED"
  | "INVALIDATED";

export type DataFreshness = "LIVE" | "DELAYED" | "STALE";

export interface FreshnessReport {
  state: DataFreshness;
  lastUpdate: string | null;
  ageSeconds: number | null;
  /** Honest label of what the provider actually is. */
  providerNote: string;
}

export type EntryType = "PULLBACK_ZONE" | "BREAKOUT_TRIGGER" | "MOMENTUM_CONTINUATION" | "MEAN_REVERSION_ZONE" | "NONE";

export interface TradePlan {
  entryType: EntryType;
  entryZoneLow: number | null;
  entryZoneHigh: number | null;
  /** Human-readable deterministic trigger rule (e.g. "close above ₹437.20 with relVol ≥ 1.3"). */
  entryTrigger: string | null;
  entryTriggerPrice: number | null;
  entryTriggerRelVolume: number | null;
  invalidationPrice: number | null;
  invalidationReason: string | null;
  initialStop: number | null;
  stopBasis: string | null;
  target1: number | null;
  target2: number | null;
  target3: number | null;
  targetBasis: string | null;
  expectedHoldingDays: number;
  rewardRiskToTarget1: number | null;
  rewardRiskToTarget2: number | null;
  atr14: number | null;
  annualVolPct: number | null;
  /** ADV-based liquidity in ₹; entries capped to a fraction of this. */
  advInr: number | null;
  estimatedSlippagePct: number;
  transactionCostPct: number;
  /** EV after costs to a probability-weighted bracket outcome — see model.ts for the honest assumptions. */
  expectedValueAfterCostsPct: number | null;
  expectedShortfallPct: number | null;
}

export interface PositionSizing {
  riskAmount: number;
  riskPerShare: number | null;
  rawRiskBasedQty: number | null;
  positionSizeShares: number;
  capitalRequired: number;
  capitalRemaining: number;
  constraintsApplied: string[];
  /** Loss if the initial stop is hit (incl. costs+slippage), ₹. */
  lossAtStop: number | null;
}

export interface ShortTermForecast {
  expectedExcessReturnPct: number | null;
  p10Pct: number | null;
  p50Pct: number | null;
  p90Pct: number | null;
  /** ONLY set when a calibrated meta-label model is promoted; else null + statement. */
  probabilityTargetBeforeStop: number | null;
  probabilityStatement: string;
  expectedHoldingDays: number;
  modelConfidence: "LOW" | "MEDIUM" | "HIGH";
  modelConfidenceReasons: string[];
  setupSampleSize: number | null;
  modelVersion: string;
}

export interface GateResult {
  passed: boolean;
  failures: Array<{ gate: string; current: string; required: string }>;
}

export interface ShortTermCandidateView {
  rank: number | null;
  ticker: string;
  name: string;
  sector: string;
  currentPrice: number | null;
  freshness: FreshnessReport;
  /** V2: freshness semantics (LIVE/DELAYED_INTRADAY/EOD_FINAL/STALE). */
  freshnessV2: string;
  action: string; // ShortTermActionV2 (kept as string to avoid a type cycle with actionStates)
  state: CandidateState;
  setupType: SetupType;
  setupScore: number;
  entryQuality: number | null;
  modelHealth: string;
  dataQuality: number;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  whyCandidate: string[];
  whatCanGoWrong: string[];
  changedSincePrevious: string[] | null;
  plan: TradePlan;
  sizing: PositionSizing | null;
  forecast: ShortTermForecast;
  gates: GateResult;
  rankingScore: number | null;
  aiSummary: { text: string; provider: string; model: string } | null;
  // ── V2 qualification-integrity fields ──────────────────────────────────
  /** Evidence tier A/B/C/D — decides Qualified vs Research Watchlist. */
  tier: string;
  /** True only for a genuinely actionable, affordable, tier-A confirmed entry. */
  qualified: boolean;
  /** Geometry-derived action before ceilings (ZONE_REACHED etc.). */
  geometryAction: string;
  /** The deterministic ceiling and why it binds. */
  ceilingReasons: string[];
  /** Plain "why this is NOT entry-confirmed" bullets. */
  whyNotEntry: string[];
  confirmation: { satisfied: boolean; met: string[]; unmet: string[] } | null;
  contradictions: Array<{ code: string; message: string; cap: string }>;
  ev: Record<string, unknown> | null;
  setupEvidence: Record<string, unknown> | null;
  plausibility: Record<string, unknown> | null;
}

export interface ScanParams {
  budgetInr: number | null;
  priceMin: number | null;
  priceMax: number | null;
  horizon: ShortTermHorizon;
  riskPerTradePct: number; // 0.25 | 0.5 | 1.0 | custom
  strategy: StrategyFilter;
  sector: string | null;
  minAdvInr: number | null; // AUTO = null → default floor
  aiDepth: "AUTO" | "LOCAL_ONLY" | "LOW_COST" | "DEEP_REVIEW";
  limit: number; // display cap: 5 | 10 | 20 | 0 (=all passing)
}

export const DEFAULT_SCAN_PARAMS: ScanParams = {
  budgetInr: null,
  priceMin: null,
  priceMax: null,
  horizon: DEFAULT_HORIZON,
  riskPerTradePct: 0.5,
  strategy: "ALL",
  sector: null,
  minAdvInr: null,
  aiDepth: "AUTO",
  limit: 5,
};
