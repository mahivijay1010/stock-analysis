export type DataStatus =
  | "RAW"
  | "CALCULATED"
  | "EXTRACTED"
  | "ESTIMATED"
  | "AI_ANALYSIS"
  | "NOT_AVAILABLE"
  | "STALE"
  | "ERROR";

export type Confidence = "HIGH" | "MEDIUM" | "LOW";
export type Consolidation = "CONSOLIDATED" | "STANDALONE" | "UNKNOWN";
export type PeriodType = "INSTANT" | "QUARTERLY" | "HALF_YEARLY" | "ANNUAL" | "OTHER";

export type FinancialConcept =
  | "revenue"
  | "ebitda"
  | "ebit"
  | "profit_before_tax"
  | "net_income"
  | "eps"
  | "tax_expense"
  | "finance_costs"
  | "depreciation"
  | "other_income"
  | "total_assets"
  | "current_assets"
  | "cash_and_equivalents"
  | "inventory"
  | "receivables"
  | "current_liabilities"
  | "total_liabilities"
  | "equity"
  | "share_capital"
  | "reserves"
  | "borrowings_current"
  | "borrowings_noncurrent"
  | "gross_debt"
  | "cash_from_operations"
  | "capex"
  | "investing_cash_flow"
  | "financing_cash_flow";

export interface SourceRef {
  provider: string;
  sourceLevel: 1 | 2 | 3 | 4 | 5;
  url: string;
  document?: string | null;
  publishedAt?: string | null;
  sourceId?: string;
}

export interface XbrlContext {
  id: string;
  entity?: string;
  startDate?: string;
  endDate: string;
  instant: boolean;
  hasDimensions: boolean;
}

export interface XbrlFact {
  rawConcept: string;
  contextId: string;
  unit?: string;
  decimals?: string;
  value: number;
}

export interface NormalizedFinancialFact {
  ticker: string;
  concept: FinancialConcept;
  rawConcept: string;
  contextId: string;
  value: number;
  currency: string | null;
  unit: string | null;
  periodStart: string | null;
  periodEnd: string;
  periodType: PeriodType;
  consolidation: Consolidation;
  status: "RAW" | "EXTRACTED";
  confidence: Confidence;
  source: SourceRef;
  validationNotes: string[];
}

export interface MetricResult<T = number> {
  metric: string;
  value: T | null;
  period: string;
  formula: string | null;
  inputs: Record<string, unknown>;
  methodology: string;
  sources: SourceRef[];
  status: DataStatus;
  confidence: Confidence;
  reason?: string;
  calculatedAt: string;
}

export interface AnnualFinancials {
  period: string;
  periodEnd: string;
  revenue: number | null;
  ebitda: number | null;
  ebit: number | null;
  profitBeforeTax: number | null;
  netIncome: number | null;
  eps: number | null;
  taxExpense: number | null;
  financeCosts: number | null;
  depreciation: number | null;
  currentAssets: number | null;
  currentLiabilities: number | null;
  totalAssets: number | null;
  totalLiabilities: number | null;
  equity: number | null;
  cash: number | null;
  borrowingsCurrent: number | null;
  borrowingsNoncurrent: number | null;
  grossDebt: number | null;
  cfo: number | null;
  capex: number | null;
  sources: SourceRef[];
}

export interface GrowthMetrics {
  patYoyPct: number | null;
  epsYoyPct: number | null;
  patCagr3yPct: number | null;
  patCagr5yPct: number | null;
  epsCagr3yPct: number | null;
  epsCagr5yPct: number | null;
}

export interface DcfScenarioAssumptions {
  name: "bear" | "base" | "bull" | string;
  fcfGrowthPct: number;
  waccPct: number;
  terminalGrowthPct: number;
  forecastYears?: number;
}

export interface DcfScenarioResult {
  name: string;
  assumptions: Required<DcfScenarioAssumptions>;
  projectedFcf: number[];
  pvForecastFcf: number;
  terminalValue: number;
  pvTerminalValue: number;
  enterpriseValue: number;
  equityValue: number;
  intrinsicValuePerShare: number;
  currentPrice: number | null;
  marginOfSafetyPct: number | null;
}

export interface DcfOutput {
  scenarios: DcfScenarioResult[];
  sensitivity: Array<{
    waccPct: number;
    terminalGrowthPct: number;
    intrinsicValuePerShare: number;
  }>;
}

export type RuleVerdict = "PASS" | "FAIL" | "NOT_AVAILABLE";

export interface RuleThresholds {
  roeMinPct: number;
  roicMinPct: number;
  earningsGrowthMinPct: number;
  fcfMin: number;
  currentRatioMin: number;
  pegMax: number;
}

export interface FilingDocument {
  provider: "NSE" | "BSE" | "COMPANY_IR";
  ticker: string;
  title: string;
  documentType: string;
  url: string;
  xbrlUrl?: string | null;
  ixbrlUrl?: string | null;
  publishedAt?: string | null;
  periodEnd?: string | null;
  audited?: boolean | null;
  consolidation: Consolidation;
  revision?: string | null;
  metadata: Record<string, unknown>;
}

export interface CrossCheck {
  concept: FinancialConcept;
  period: string;
  primaryValue: number;
  comparisonValue: number;
  differencePct: number;
  status: "MATCH" | "DISCREPANCY";
  sources: SourceRef[];
}

export interface CoverageRow {
  metric: string;
  status: DataStatus | "AVAILABLE";
  source: string;
  reason?: string;
}

export interface MacroValue {
  indicator: string;
  value: number;
  unit: string;
  period: string;
  provider: "RBI" | "MOSPI";
  sourceUrl: string;
  publicationDate?: string | null;
  status: "RAW";
  confidence: "HIGH";
  metadata?: Record<string, unknown>;
}

export interface ExtractedEvidence {
  category: "ORDER_BOOK" | "ORDER_INFLOW" | "HISTORICAL_CAPEX" | "PLANNED_CAPEX" | "CAPACITY" | "TAM";
  label: string;
  value: number | null;
  currency: string | null;
  asOfDate: string | null;
  excerpt: string;
  sourceUrl: string;
  status: "EXTRACTED" | "ESTIMATED";
  confidence: Confidence;
  metadata: Record<string, unknown>;
}
