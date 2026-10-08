/**
 * Provider abstraction for the universe engine. Vendor-specific code lives in
 * adapters implementing these interfaces; the engine never imports a vendor
 * module directly. Every payload carries source + asOf so the UI can show
 * provenance and never label delayed data as live.
 */

export interface ProviderHealth {
  provider: string;
  state: "OK" | "DEGRADED" | "DOWN" | "UNKNOWN";
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  calls: number;
  failures: number;
}

export interface SecurityListing {
  symbol: string;
  companyName: string;
  series: string | null;
  isin: string | null;
  listedDate: string | null; // YYYY-MM-DD
  faceValue: number | null;
  /** The list the row came from, e.g. EQUITY_L / SME_EQUITY_L / REITS_L / INVITS_L / ETF */
  listSource: string;
}

export interface SymbolChangeRecord {
  companyName: string;
  oldSymbol: string;
  newSymbol: string;
  effectiveDate: string | null;
}
export interface NameChangeRecord {
  symbol: string;
  oldName: string;
  newName: string;
  effectiveDate: string | null;
}
export interface IndexMembership {
  symbol: string;
  index: string;
  industry: string | null;
}

export interface SecurityMasterSnapshot {
  source: string;
  fetchedAt: string;
  listings: SecurityListing[];
  symbolChanges: SymbolChangeRecord[];
  nameChanges: NameChangeRecord[];
  indexMemberships: IndexMembership[];
  errors: string[];
}

export interface SecurityMasterProvider {
  readonly name: string;
  fetchSnapshot(): Promise<SecurityMasterSnapshot>;
  health(): ProviderHealth;
}

/** Daily OHLCV bar (adjusted close optional). */
export interface DailyBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adjustedClose?: number | null;
}
export interface MarketDataProvider {
  readonly name: string;
  getDailyBars(yahooTicker: string, range: "6mo" | "1y" | "2y"): Promise<{ bars: DailyBar[]; source: string; asOf: string | null }>;
  health(): ProviderHealth;
}
export interface FundamentalsSnapshot {
  symbol: string;
  asOf: string | null;
  source: string;
  metrics: Record<string, number | null>;
}
export interface FundamentalsProvider {
  readonly name: string;
  getFundamentals(symbol: string): Promise<FundamentalsSnapshot | null>;
  health(): ProviderHealth;
}
export interface NewsItem {
  symbol: string;
  headline: string;
  url: string | null;
  publishedAt: string | null;
  source: string;
  kind: string;
  sentiment: string | null;
}
export interface NewsProvider {
  readonly name: string;
  getRecentNews(symbol: string, days: number): Promise<NewsItem[]>;
  health(): ProviderHealth;
}
export interface CorporateAction {
  symbol: string;
  type: string;
  exDate: string | null;
  detail: string;
  source: string;
}
export interface CorporateActionsProvider {
  readonly name: string;
  getCorporateActions(symbol: string): Promise<CorporateAction[]>;
  health(): ProviderHealth;
}
export interface FinancialResult {
  symbol: string;
  periodEnd: string;
  periodType: string;
  revenue: number | null;
  netProfit: number | null;
  eps: number | null;
  source: string;
}
export interface FinancialResultsProvider {
  readonly name: string;
  getResults(symbol: string): Promise<FinancialResult[]>;
  health(): ProviderHealth;
}

/** Tiny in-process health tracker shared by adapters. */
export class HealthTracker {
  private h: ProviderHealth;
  constructor(provider: string) {
    this.h = { provider, state: "UNKNOWN", lastSuccessAt: null, lastErrorAt: null, lastError: null, calls: 0, failures: 0 };
  }
  ok(): void {
    this.h.calls += 1;
    this.h.lastSuccessAt = new Date().toISOString();
    this.h.state = this.h.failures > 0 && this.h.failures / this.h.calls > 0.5 ? "DEGRADED" : "OK";
  }
  fail(err: unknown): void {
    this.h.calls += 1;
    this.h.failures += 1;
    this.h.lastErrorAt = new Date().toISOString();
    this.h.lastError = err instanceof Error ? err.message : String(err);
    this.h.state = this.h.lastSuccessAt ? "DEGRADED" : "DOWN";
  }
  get(): ProviderHealth {
    return { ...this.h };
  }
}
