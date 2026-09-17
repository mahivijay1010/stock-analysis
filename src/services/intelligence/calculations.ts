import {
  AnnualFinancials,
  GrowthMetrics,
  MetricResult,
  RuleThresholds,
  RuleVerdict,
} from "./types";

const now = (): string => new Date().toISOString();
const round = (v: number, digits = 4): number => Number(v.toFixed(digits));
const finite = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

/**
 * FINANCIAL covers banks, NBFCs and insurers: their balance sheets and cash
 * flow statements are not comparable to an industrial company's (deposits are
 * both a liability and the "product"; a lender's CFO is dominated by loan
 * book movements, not operating cash generation). Every ratio below that is
 * meaningless for a bank is equally meaningless for an NBFC/insurer, so both
 * get the same refusal — never a hardcoded ticker list (see
 * classifyIndustryKind in IntelligenceService.ts, which classifies by the
 * universe's own sector field).
 */
export type IndustryKind = "FINANCIAL" | "NON_FINANCIAL";

function unavailable(
  metric: string,
  period: string,
  formula: string,
  reason: string,
  methodology = "STANDARD"
): MetricResult {
  return {
    metric,
    value: null,
    period,
    formula,
    inputs: {},
    methodology,
    sources: [],
    status: "NOT_AVAILABLE",
    confidence: "LOW",
    reason,
    calculatedAt: now(),
  };
}

function calculated(
  metric: string,
  value: number,
  period: string,
  formula: string,
  inputs: Record<string, number>,
  methodology: string,
  periods: AnnualFinancials[]
): MetricResult {
  const sources = periods.flatMap((p) => p.sources);
  return {
    metric,
    value: round(value),
    period,
    formula,
    inputs,
    methodology,
    sources: sources.filter(
      (s, i) => sources.findIndex((x) => x.url === s.url) === i
    ),
    status: "CALCULATED",
    confidence: sources.length > 0 ? "HIGH" : "MEDIUM",
    calculatedAt: now(),
  };
}

/** PAT / average opening and closing shareholders' equity, expressed as %. */
export function calculateRoe(
  current: AnnualFinancials,
  previous: AnnualFinancials | null
): MetricResult {
  const formula = "PAT / ((opening shareholders equity + closing shareholders equity) / 2) * 100";
  if (!previous || !finite(current.netIncome) || !finite(current.equity) || !finite(previous.equity)) {
    return unavailable("roe", current.period, formula, "PAT and both opening/closing equity are required.");
  }
  const averageEquity = (previous.equity + current.equity) / 2;
  if (averageEquity === 0) return unavailable("roe", current.period, formula, "Average equity is zero.");
  return calculated(
    "roe",
    (current.netIncome / averageEquity) * 100,
    current.period,
    formula,
    { PAT: current.netIncome, opening_equity: previous.equity, closing_equity: current.equity },
    "AVERAGE_EQUITY",
    [current, previous]
  );
}

/** CFO - positive cash paid for PPE/intangibles. CapEx sign is normalized here. */
export function calculateFcf(
  current: AnnualFinancials,
  industryKind: IndustryKind = "NON_FINANCIAL"
): MetricResult {
  const formula = "CFO - abs(CapEx cash paid)";
  if (industryKind === "FINANCIAL") {
    return unavailable(
      "fcf",
      current.period,
      formula,
      "CFO-CapEx free cash flow is not meaningful for a bank/NBFC/insurer — CFO is dominated by loan-book and deposit movements, not operating cash generation.",
      "FINANCIAL_NOT_MEANINGFUL"
    );
  }
  if (!finite(current.cfo) || !finite(current.capex)) {
    return unavailable("fcf", current.period, formula, "Cash from operations and CapEx are required.");
  }
  const normalizedCapex = Math.abs(current.capex);
  return calculated(
    "fcf",
    current.cfo - normalizedCapex,
    current.period,
    formula,
    { CFO: current.cfo, reported_capex: current.capex, normalized_capex: normalizedCapex },
    "CFO_LESS_CAPEX",
    [current]
  );
}

export function calculateCurrentRatio(
  current: AnnualFinancials,
  industryKind: IndustryKind = "NON_FINANCIAL"
): MetricResult {
  const formula = "Current assets / current liabilities";
  if (industryKind === "FINANCIAL") {
    return unavailable(
      "current_ratio",
      current.period,
      formula,
      "Current ratio is not comparable for a bank/NBFC/insurer balance sheet.",
      "FINANCIAL_NOT_MEANINGFUL"
    );
  }
  if (!finite(current.currentAssets) || !finite(current.currentLiabilities) || current.currentLiabilities === 0) {
    return unavailable("current_ratio", current.period, formula, "Current assets and non-zero current liabilities are required.");
  }
  return calculated(
    "current_ratio",
    current.currentAssets / current.currentLiabilities,
    current.period,
    formula,
    { current_assets: current.currentAssets, current_liabilities: current.currentLiabilities },
    "STANDARD",
    [current]
  );
}

/** NOPAT / average invested capital. Does not substitute ROE. */
export function calculateRoic(
  current: AnnualFinancials,
  previous: AnnualFinancials | null,
  industryKind: IndustryKind = "NON_FINANCIAL"
): MetricResult {
  const formula = "EBIT * (1 - effective tax rate) / average(equity + debt - cash) * 100";
  if (industryKind === "FINANCIAL") {
    return unavailable(
      "roic",
      current.period,
      formula,
      "Industrial invested-capital ROIC is not valid for a bank/NBFC/insurer.",
      "FINANCIAL_REQUIRES_SPECIALIST_ROIC"
    );
  }
  const ebit = finite(current.ebit)
    ? current.ebit
    : finite(current.profitBeforeTax) && finite(current.financeCosts)
      ? current.profitBeforeTax + current.financeCosts
      : null;
  if (!previous || !finite(ebit) || !finite(current.profitBeforeTax) || !finite(current.taxExpense)) {
    return unavailable("roic", current.period, formula, "EBIT, PBT, tax and opening invested capital are required.");
  }
  // Debt is only "known" from grossDebt, or from the sum of borrowing
  // sub-concepts when AT LEAST ONE of them is actually reported. If both
  // grossDebt and every borrowing sub-concept are absent, debt is UNKNOWN —
  // never silently imputed as 0 (a missing filing line is not the same as a
  // genuinely debt-free balance sheet, and defaulting to 0 here inflates ROIC).
  const debtNowKnown = finite(current.grossDebt) || finite(current.borrowingsCurrent) || finite(current.borrowingsNoncurrent);
  const debtPrevKnown = finite(previous.grossDebt) || finite(previous.borrowingsCurrent) || finite(previous.borrowingsNoncurrent);
  if (!debtNowKnown || !debtPrevKnown) {
    return unavailable("roic", current.period, formula, "Debt (gross debt, or at least one borrowing sub-concept) is required for both periods — a missing filing line is not assumed to mean zero debt.");
  }
  const debtNow = finite(current.grossDebt)
    ? current.grossDebt
    : (current.borrowingsCurrent ?? 0) + (current.borrowingsNoncurrent ?? 0);
  const debtPrev = finite(previous.grossDebt)
    ? previous.grossDebt
    : (previous.borrowingsCurrent ?? 0) + (previous.borrowingsNoncurrent ?? 0);
  if (!finite(current.equity) || !finite(previous.equity) || !finite(current.cash) || !finite(previous.cash)) {
    return unavailable("roic", current.period, formula, "Equity, debt and cash for both periods are required.");
  }
  const currentIc = current.equity + debtNow - current.cash;
  const previousIc = previous.equity + debtPrev - previous.cash;
  const averageInvestedCapital = (currentIc + previousIc) / 2;
  if (averageInvestedCapital <= 0 || current.profitBeforeTax === 0) {
    return unavailable("roic", current.period, formula, "Invested capital or PBT is non-positive.");
  }
  const effectiveTaxRate = Math.max(0, Math.min(1, current.taxExpense / current.profitBeforeTax));
  const nopat = ebit * (1 - effectiveTaxRate);
  return calculated(
    "roic",
    (nopat / averageInvestedCapital) * 100,
    current.period,
    formula,
    { EBIT: ebit, effective_tax_rate: effectiveTaxRate, NOPAT: nopat, opening_invested_capital: previousIc, closing_invested_capital: currentIc },
    "NOPAT_AVERAGE_INVESTED_CAPITAL",
    [current, previous]
  );
}

/**
 * ROCE = EBIT / average capital employed × 100, where capital employed =
 * total assets − current liabilities (completion Phase 10). Distinct from
 * ROIC: pre-tax, and charges the whole operating asset base.
 */
export function calculateRoce(
  current: AnnualFinancials,
  previous: AnnualFinancials | null,
  industryKind: IndustryKind = "NON_FINANCIAL"
): MetricResult {
  const formula = "EBIT / average(total assets - current liabilities) * 100";
  if (industryKind === "FINANCIAL") {
    return unavailable("roce", current.period, formula, "Capital-employed ROCE is not valid for a bank/NBFC/insurer.", "FINANCIAL_NOT_MEANINGFUL");
  }
  const ebit = finite(current.ebit)
    ? current.ebit
    : finite(current.profitBeforeTax) && finite(current.financeCosts)
      ? current.profitBeforeTax + current.financeCosts
      : null;
  if (!previous || !finite(ebit)) {
    return unavailable("roce", current.period, formula, "EBIT (or PBT + finance costs) and a prior period are required.");
  }
  if (
    !finite(current.totalAssets) || !finite(current.currentLiabilities) ||
    !finite(previous.totalAssets) || !finite(previous.currentLiabilities)
  ) {
    return unavailable("roce", current.period, formula, "Total assets and current liabilities for both periods are required.");
  }
  const ceNow = current.totalAssets - current.currentLiabilities;
  const cePrev = previous.totalAssets - previous.currentLiabilities;
  const averageCe = (ceNow + cePrev) / 2;
  if (averageCe <= 0) {
    return unavailable("roce", current.period, formula, "Average capital employed is non-positive.");
  }
  return calculated(
    "roce",
    (ebit / averageCe) * 100,
    current.period,
    formula,
    { EBIT: ebit, opening_capital_employed: cePrev, closing_capital_employed: ceNow },
    "EBIT_AVERAGE_CAPITAL_EMPLOYED",
    [current, previous]
  );
}

/**
 * Working capital = current assets − current liabilities (absolute, reporting
 * currency); inputs also expose WC as days of revenue when revenue is known.
 */
export function calculateWorkingCapital(
  current: AnnualFinancials,
  industryKind: IndustryKind = "NON_FINANCIAL"
): MetricResult {
  const formula = "Current assets - current liabilities";
  if (industryKind === "FINANCIAL") {
    return unavailable("working_capital", current.period, formula, "Working capital is not comparable for a bank/NBFC/insurer balance sheet.", "FINANCIAL_NOT_MEANINGFUL");
  }
  if (!finite(current.currentAssets) || !finite(current.currentLiabilities)) {
    return unavailable("working_capital", current.period, formula, "Current assets and current liabilities are required.");
  }
  const wc = current.currentAssets - current.currentLiabilities;
  const inputs: Record<string, number> = {
    current_assets: current.currentAssets,
    current_liabilities: current.currentLiabilities,
  };
  if (finite(current.revenue) && current.revenue > 0) {
    inputs.wc_days_of_revenue = round((wc / current.revenue) * 365, 1);
  }
  return calculated("working_capital", wc, current.period, formula, inputs, "STANDARD", [current]);
}

function yoy(current: number | null, previous: number | null): number | null {
  if (!finite(current) || !finite(previous) || previous === 0) return null;
  return round(((current / previous) - 1) * 100);
}

function cagr(latest: number | null, oldest: number | null, years: number): number | null {
  if (!finite(latest) || !finite(oldest) || latest <= 0 || oldest <= 0 || years <= 0) return null;
  return round((Math.pow(latest / oldest, 1 / years) - 1) * 100);
}

/** Series must be newest first and contain annual, non-mixed consolidation data. */
export function calculateGrowth(series: AnnualFinancials[]): MetricResult<GrowthMetrics> {
  const current = series[0];
  const empty: GrowthMetrics = {
    patYoyPct: null, epsYoyPct: null, patCagr3yPct: null, patCagr5yPct: null,
    epsCagr3yPct: null, epsCagr5yPct: null,
  };
  if (!current) {
    return { ...unavailable("earnings_growth", "UNKNOWN", "YoY and CAGR from annual PAT/EPS", "No annual series."), value: null };
  }
  const value: GrowthMetrics = {
    ...empty,
    patYoyPct: yoy(current.netIncome, series[1]?.netIncome ?? null),
    epsYoyPct: yoy(current.eps, series[1]?.eps ?? null),
    patCagr3yPct: series.length >= 4 ? cagr(current.netIncome, series[3].netIncome, 3) : null,
    patCagr5yPct: series.length >= 6 ? cagr(current.netIncome, series[5].netIncome, 5) : null,
    epsCagr3yPct: series.length >= 4 ? cagr(current.eps, series[3].eps, 3) : null,
    epsCagr5yPct: series.length >= 6 ? cagr(current.eps, series[5].eps, 5) : null,
  };
  const available = Object.values(value).some(finite);
  if (!available) {
    return { ...unavailable("earnings_growth", current.period, "YoY and CAGR from annual PAT/EPS", "At least two comparable annual observations are required."), value: null };
  }
  return {
    metric: "earnings_growth",
    value,
    period: current.period,
    formula: "YoY=(latest/prior-1)*100; CAGR=(latest/oldest)^(1/years)-1",
    inputs: { periods: series.map((s) => ({ period: s.period, PAT: s.netIncome, EPS: s.eps })) },
    methodology: "HISTORICAL_ACTUALS",
    sources: series.flatMap((s) => s.sources).filter((s, i, a) => a.findIndex((x) => x.url === s.url) === i),
    status: "CALCULATED",
    confidence: "HIGH",
    calculatedAt: now(),
  };
}

export function calculatePeg(
  pe: number | null,
  growth: MetricResult<GrowthMetrics>
): MetricResult {
  const formula = "Current trailing PE / historical EPS growth percent";
  if (!finite(pe) || !growth.value) {
    return unavailable("peg", growth.period, formula, "PE and historical EPS growth are required.");
  }
  const growthPct = growth.value.epsCagr3yPct ?? growth.value.epsYoyPct;
  if (!finite(growthPct) || growthPct <= 0) {
    return unavailable("peg", growth.period, formula, "EPS growth is missing or non-positive; PEG is not meaningful.");
  }
  return {
    metric: "peg",
    value: round(pe / growthPct),
    period: growth.period,
    formula,
    inputs: { trailing_pe: pe, eps_growth_pct: growthPct },
    methodology: growth.value.epsCagr3yPct != null ? "TRAILING_PE_OVER_3Y_EPS_CAGR" : "TRAILING_PE_OVER_EPS_YOY",
    sources: growth.sources,
    status: "CALCULATED",
    confidence: growth.value.epsCagr3yPct != null ? "HIGH" : "MEDIUM",
    calculatedAt: now(),
  };
}

export const DEFAULT_RULE_THRESHOLDS: RuleThresholds = {
  roeMinPct: 15,
  roicMinPct: 15,
  earningsGrowthMinPct: 0,
  fcfMin: 0,
  currentRatioMin: 1,
  pegMax: 1.5,
};

function threshold(value: number | null, predicate: (v: number) => boolean): RuleVerdict {
  return finite(value) ? (predicate(value) ? "PASS" : "FAIL") : "NOT_AVAILABLE";
}

export function evaluateRules(
  values: {
    roe: number | null;
    roic: number | null;
    earningsGrowth: number | null;
    fcf: number | null;
    currentRatio: number | null;
    peg: number | null;
  },
  config: Partial<RuleThresholds> = {}
): Record<string, RuleVerdict> {
  const t = { ...DEFAULT_RULE_THRESHOLDS, ...config };
  return {
    roe_15: threshold(values.roe, (v) => v >= t.roeMinPct),
    roic_15: threshold(values.roic, (v) => v >= t.roicMinPct),
    earnings_growth_positive: threshold(values.earningsGrowth, (v) => v > t.earningsGrowthMinPct),
    fcf_positive: threshold(values.fcf, (v) => v > t.fcfMin),
    current_ratio_1: threshold(values.currentRatio, (v) => v >= t.currentRatioMin),
    peg_1_5: threshold(values.peg, (v) => v < t.pegMax),
  };
}
