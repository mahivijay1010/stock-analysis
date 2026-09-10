import { SourceRef } from "../types";

/**
 * Canonical scraped-fundamentals record shared by every provider in the
 * fallback chain. Every field is optional — a provider fills what it can, the
 * engine MERGES across providers (first non-null per field wins), and the
 * sanity layer drops physically-impossible values before anything is stored.
 */
export interface ScrapedRatios {
  peRatio: number | null;
  roe: number | null;
  roce: number | null;
  currentRatio: number | null;
  bookValue: number | null;
  dividendYield: number | null;
  marketCap: number | null; // ₹ crore
  faceValue: number | null;
  currentPrice: number | null;
  debtToEquity: number | null;
  priceToBook: number | null;
  promoterHolding: number | null; // %
  operatingMargin: number | null; // %
  quarterlyProfitGrowthYoY: number | null; // % — latest quarter net profit vs year-ago
  promoterHoldingChangeQoQ: number | null; // pp change vs previous quarter (− = promoters selling)
}

export const RATIO_FIELDS: Array<keyof ScrapedRatios> = [
  "peRatio",
  "roe",
  "roce",
  "currentRatio",
  "bookValue",
  "dividendYield",
  "marketCap",
  "faceValue",
  "currentPrice",
  "debtToEquity",
  "priceToBook",
  "promoterHolding",
  "operatingMargin",
  "quarterlyProfitGrowthYoY",
  "promoterHoldingChangeQoQ",
];

/** Canonical field → the persisted intelligence_metrics `metric` key + unit. */
export const FIELD_METRIC: Record<keyof ScrapedRatios, { metric: string; unit: string }> = {
  peRatio: { metric: "pe_ratio", unit: "x" },
  roe: { metric: "roe", unit: "percent" },
  roce: { metric: "roce", unit: "percent" },
  currentRatio: { metric: "current_ratio", unit: "x" },
  bookValue: { metric: "book_value", unit: "inr" },
  dividendYield: { metric: "dividend_yield", unit: "percent" },
  marketCap: { metric: "market_cap", unit: "inr_cr" },
  faceValue: { metric: "face_value", unit: "inr" },
  currentPrice: { metric: "current_price", unit: "inr" },
  debtToEquity: { metric: "debt_to_equity", unit: "x" },
  priceToBook: { metric: "price_to_book", unit: "x" },
  promoterHolding: { metric: "promoter_holding", unit: "percent" },
  operatingMargin: { metric: "operating_margin", unit: "percent" },
  quarterlyProfitGrowthYoY: { metric: "profit_growth_yoy", unit: "percent" },
  promoterHoldingChangeQoQ: { metric: "promoter_holding_change_qoq", unit: "pp" },
};

export interface ProviderResult {
  values: Partial<ScrapedRatios>;
  source: SourceRef;
}

/** One source in the fallback chain. Must NEVER throw — return {} on failure. */
export interface FundamentalsProvider {
  readonly name: string;
  fetch(ticker: string): Promise<ProviderResult>;
}
