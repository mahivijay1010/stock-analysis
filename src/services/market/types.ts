/**
 * Market data layer — shared types (Module 1).
 * Field names follow REBUILD_SPEC.md exactly. Duplicated structurally per module.
 */

export interface Bar {
  date: string; // YYYY-MM-DD (Asia/Kolkata)
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
  asOf: string; // ISO timestamp
  marketState?: string;
}

/** Supported ranges for daily bars. */
export type DailyRange = "3mo" | "6mo" | "1y" | "2y" | "5y";

/** Where getDailyBarsWithSource() actually got its bars from. */
export type BarsSource = "yahoo" | "db-fresh" | "db-stale";

export interface BarsResult {
  bars: Bar[];
  source: BarsSource;
}

export interface ResolveResult {
  ticker: string;
  name: string;
  exchange: "NSE" | "BSE";
}

export interface SearchSuggestion {
  ticker: string;
  name: string;
  exchange: string;
}

export interface SeedResult {
  ok: string[];
  failed: string[];
}

// ── V2-A: Fundamentals (Yahoo quoteSummary) ─────────────────────────────────

/**
 * EVERY field nullable — Yahoo omits many per ticker. Percentages are real
 * percentages (Yahoo fractions × 100), never fractions.
 */
export interface Fundamentals {
  trailingPE: number | null;
  pegRatio: number | null;
  priceToBook: number | null;
  enterpriseToEbitda: number | null;
  grossMarginPct: number | null;
  operatingMarginPct: number | null;
  netMarginPct: number | null;
  revenueGrowthPct: number | null;
  earningsGrowthPct: number | null;
  returnOnEquityPct: number | null;
  returnOnAssetsPct: number | null;
  totalDebt: number | null;
  totalCash: number | null;
  freeCashflow: number | null;
  currentRatio: number | null;
  dividendYieldPct: number | null;
  payoutRatioPct: number | null;
  marketCap: number | null;
  insiderHoldingPct: number | null;
  beta: number | null;
  asOf: string;
  source: "yahoo";
}

// ── V2-A: Market regime (NIFTY + India VIX + USDINR) ────────────────────────

export interface MarketRegime {
  regime: "risk-on" | "neutral" | "risk-off";
  score: number; // 0..100
  nifty: {
    price: number;
    vs50dmaPct: number;
    vs200dmaPct: number;
    trend: "up" | "down" | "sideways";
    r20dPct: number;
  };
  vix: { value: number; zone: "calm" | "normal" | "elevated" | "fear" }; // <13 calm, 13-17 normal, 17-25 elevated, >25 fear
  usdinr: {
    value: number;
    r60dPct: number;
    trend: "strengthening-inr" | "weakening-inr" | "stable";
  };
  notes: string[]; // human-readable, real numbers quoted
  asOf: string;
}
