import {
  AnnualFinancials,
  Consolidation,
  FinancialConcept,
  NormalizedFinancialFact,
  PeriodType,
  SourceRef,
  XbrlContext,
  XbrlFact,
} from "./types";

/**
 * Aliases are deliberately explicit. Unknown taxonomy concepts remain in the
 * raw source snapshot and are not guessed into an internal concept.
 */
const CONCEPT_ALIASES: Record<FinancialConcept, string[]> = {
  revenue: ["RevenueFromOperations", "Revenue", "IncomeFromOperations", "TotalRevenue", "Income"],
  ebitda: ["EarningsBeforeInterestTaxesDepreciationAndAmortisation", "EBITDA"],
  ebit: ["EarningsBeforeInterestAndTax", "ProfitBeforeFinanceCostsAndTax", "OperatingProfit"],
  profit_before_tax: ["ProfitBeforeTax", "ProfitLossFromOrdinaryActivitiesBeforeTax", "ProfitBeforeExtraordinaryItemsAndTax"],
  net_income: [
    "ProfitLossForPeriod", "ProfitLossForThePeriod", "ProfitLossFromOrdinaryActivitiesAfterTax",
    "ProfitLossAfterTaxesMinorityInterestAndShareOfProfitLossOfAssociates", "NetProfitLossForThePeriod",
  ],
  eps: [
    "BasicEarningsLossPerShareFromContinuingAndDiscontinuedOperations",
    "BasicEarningsLossPerShareFromContinuingOperations",
    "BasicEarningsPerShareAfterExtraordinaryItems",
    "BasicEarningsPerShareBeforeExtraordinaryItems",
    "BasicEarningsPerShare",
  ],
  tax_expense: ["TaxExpense", "TotalTaxExpense"],
  finance_costs: ["FinanceCosts", "FinanceCost"],
  depreciation: ["DepreciationDepletionAndAmortisationExpense", "DepreciationAndAmortisationExpense"],
  other_income: ["OtherIncome"],
  total_assets: ["Assets", "TotalAssets"],
  current_assets: ["CurrentAssets", "TotalCurrentAssets"],
  cash_and_equivalents: ["CashAndCashEquivalents", "CashAndBalancesWithReserveBankOfIndia", "CashAndCashEquivalentsCashFlowStatement"],
  inventory: ["Inventories", "Inventory"],
  receivables: ["TradeReceivablesCurrent", "TradeReceivables"],
  current_liabilities: ["CurrentLiabilities", "TotalCurrentLiabilities"],
  total_liabilities: ["Liabilities", "TotalLiabilities"],
  equity: ["Equity", "EquityAttributableToOwnersOfParent", "ShareholdersFunds", "NetWorth"],
  share_capital: ["EquityShareCapital", "PaidUpValueOfEquityShareCapital", "Capital"],
  reserves: ["OtherEquity", "ReservesAndSurplus", "ReservesExcludingRevaluationReserve"],
  borrowings_current: ["BorrowingsCurrent", "CurrentBorrowings"],
  borrowings_noncurrent: ["BorrowingsNoncurrent", "NoncurrentBorrowings"],
  gross_debt: ["Borrowings", "TotalBorrowings", "GrossDebt"],
  cash_from_operations: [
    "CashFlowsFromUsedInOperatingActivities", "CashFlowsFromUsedInOperatingActivitiesBeforeExtraordinaryItems",
    "NetCashFlowsFromUsedInOperatingActivities",
  ],
  capex: [
    "PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities",
    "PurchaseOfTangibleAssetsClassifiedAsInvestingActivities",
    "PurchaseOfIntangibleAssetsClassifiedAsInvestingActivities",
    "PaymentsToAcquirePropertyPlantAndEquipment",
    "CapitalExpenditure",
  ],
  investing_cash_flow: ["CashFlowsFromUsedInInvestingActivities", "NetCashFlowsFromUsedInInvestingActivities"],
  financing_cash_flow: ["CashFlowsFromUsedInFinancingActivities", "NetCashFlowsFromUsedInFinancingActivities"],
};

const ALIAS_LOOKUP = new Map<string, FinancialConcept>();
for (const [concept, aliases] of Object.entries(CONCEPT_ALIASES) as Array<[FinancialConcept, string[]]>) {
  for (const alias of aliases) ALIAS_LOOKUP.set(alias.toLowerCase(), concept);
}

const CAPEX_COMPONENTS = new Set([
  "purchaseofpropertyplantandequipmentclassifiedasinvestingactivities",
  "purchaseoftangibleassetsclassifiedasinvestingactivities",
  "purchaseofintangibleassetsclassifiedasinvestingactivities",
]);

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)));
}

function attr(attributes: string, name: string): string | undefined {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match?.[1];
}

function durationDays(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
}

export function classifyPeriod(context: XbrlContext): PeriodType {
  if (context.instant || !context.startDate) return "INSTANT";
  const days = durationDays(context.startDate, context.endDate);
  if (days >= 300 && days <= 400) return "ANNUAL";
  if (days >= 150 && days <= 220) return "HALF_YEARLY";
  if (days >= 60 && days <= 120) return "QUARTERLY";
  return "OTHER";
}

export function parseXbrlContexts(xml: string): Map<string, XbrlContext> {
  const contexts = new Map<string, XbrlContext>();
  const re = /<(?:[\w.-]+:)?context\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?context>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const id = attr(match[1], "id");
    if (!id) continue;
    const body = match[2];
    const instant = body.match(/<(?:[\w.-]+:)?instant>([^<]+)<\//i)?.[1];
    const startDate = body.match(/<(?:[\w.-]+:)?startDate>([^<]+)<\//i)?.[1];
    const endDate = body.match(/<(?:[\w.-]+:)?endDate>([^<]+)<\//i)?.[1];
    const entity = body.match(/<(?:[\w.-]+:)?identifier\b[^>]*>([^<]+)<\//i)?.[1];
    const resolvedEnd = (instant ?? endDate)?.trim();
    if (!resolvedEnd || !/^\d{4}-\d{2}-\d{2}$/.test(resolvedEnd)) continue;
    contexts.set(id, {
      id,
      entity: entity ? decodeXml(entity.trim()) : undefined,
      startDate: startDate?.trim(),
      endDate: resolvedEnd,
      instant: Boolean(instant),
      hasDimensions: /<(?:[\w.-]+:)?(?:scenario|segment)\b/i.test(body),
    });
  }
  return contexts;
}

export function parseXbrlFacts(xml: string): XbrlFact[] {
  const facts: XbrlFact[] = [];
  const re = /<(?:[\w.-]+:)?([A-Za-z][\w.-]*)\b([^>]*)>([^<]*)<\/(?:[\w.-]+:)?\1>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const contextId = attr(match[2], "contextRef");
    if (!contextId || /xsi:nil\s*=\s*["']true["']/i.test(match[2])) continue;
    const text = decodeXml(match[3]).replace(/,/g, "").trim();
    if (!text || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) continue;
    const value = Number(text);
    if (!Number.isFinite(value)) continue;
    facts.push({
      rawConcept: match[1],
      contextId,
      unit: attr(match[2], "unitRef"),
      decimals: attr(match[2], "decimals"),
      value,
    });
  }
  return facts;
}

export interface NormalizeXbrlOptions {
  ticker: string;
  consolidation: Consolidation;
  source: SourceRef;
  allowDimensionalFacts?: boolean;
}

export function normalizeXbrl(
  xml: string,
  options: NormalizeXbrlOptions
): NormalizedFinancialFact[] {
  const contexts = parseXbrlContexts(xml);
  const rawFacts = parseXbrlFacts(xml);
  const normalized: NormalizedFinancialFact[] = [];
  for (const fact of rawFacts) {
    const concept = ALIAS_LOOKUP.get(fact.rawConcept.toLowerCase());
    const context = contexts.get(fact.contextId);
    if (!concept || !context) continue;
    if (context.hasDimensions && !options.allowDimensionalFacts) continue;
    const periodType = classifyPeriod(context);
    // Flow facts from odd/quarterly contexts are retained as raw facts, but
    // aggregators later require like-for-like annual contexts for annual metrics.
    normalized.push({
      ticker: options.ticker,
      concept,
      rawConcept: fact.rawConcept,
      contextId: fact.contextId,
      value: concept === "capex" ? Math.abs(fact.value) : fact.value,
      currency: fact.unit?.toUpperCase().includes("INR") ? "INR" : null,
      unit: fact.unit ?? null,
      periodStart: context.startDate ?? null,
      periodEnd: context.endDate,
      periodType,
      consolidation: options.consolidation,
      status: "RAW",
      confidence: "HIGH",
      source: options.source,
      validationNotes: [],
    });
  }
  return applyAccountingValidations(normalized);
}

function applyAccountingValidations(facts: NormalizedFinancialFact[]): NormalizedFinancialFact[] {
  const byPeriod = new Map<string, NormalizedFinancialFact[]>();
  for (const fact of facts) {
    const group = byPeriod.get(fact.periodEnd) ?? [];
    group.push(fact);
    byPeriod.set(fact.periodEnd, group);
  }
  for (const periodFacts of byPeriod.values()) {
    const get = (concept: FinancialConcept): number | null =>
      periodFacts.find((f) => f.concept === concept && f.periodType === "INSTANT")?.value ?? null;
    const assets = get("total_assets");
    const liabilities = get("total_liabilities");
    const equity = get("equity");
    if (assets != null && liabilities != null && equity != null) {
      const mismatchPct = Math.abs(assets - liabilities - equity) / Math.max(1, Math.abs(assets));
      if (mismatchPct > 0.01) {
        for (const fact of periodFacts) {
          fact.confidence = "MEDIUM";
          fact.validationNotes.push(`Accounting equation mismatch ${(mismatchPct * 100).toFixed(2)}%.`);
        }
      }
    }
  }
  return facts;
}

function fyLabel(periodEnd: string): string {
  const year = Number(periodEnd.slice(0, 4));
  const month = Number(periodEnd.slice(5, 7));
  return `FY${month <= 3 ? year : year + 1}`;
}

const INSTANT_CONCEPTS = new Set<FinancialConcept>([
  "total_assets", "current_assets", "cash_and_equivalents", "inventory", "receivables",
  "current_liabilities", "total_liabilities", "equity", "share_capital", "reserves",
  "borrowings_current", "borrowings_noncurrent", "gross_debt",
]);

/** Convert normalized facts to one comparable annual row per fiscal period. */
export function buildAnnualSeries(
  facts: NormalizedFinancialFact[],
  consolidation: Consolidation = "CONSOLIDATED"
): AnnualFinancials[] {
  const eligible = facts.filter((f) => f.consolidation === consolidation);
  const ends = [...new Set(eligible.map((f) => f.periodEnd))].sort().reverse();
  const rows: AnnualFinancials[] = [];
  for (const periodEnd of ends) {
    const group = eligible.filter((f) => f.periodEnd === periodEnd);
    const flowFacts = group.filter((f) => f.periodType === "ANNUAL");
    const instantFacts = group.filter((f) => f.periodType === "INSTANT");
    if (flowFacts.length === 0) continue;
    const get = (concept: FinancialConcept): number | null => {
      const pool = INSTANT_CONCEPTS.has(concept) ? instantFacts : flowFacts;
      const matches = pool.filter((f) => f.concept === concept);
      if (matches.length === 0) return null;
      if (concept === "capex") {
        const components = matches.filter((f) => CAPEX_COMPONENTS.has(f.rawConcept.toLowerCase()));
        if (components.length > 0) {
          const unique = new Map(components.map((f) => [f.rawConcept.toLowerCase(), f.value]));
          return [...unique.values()].reduce((sum, value) => sum + Math.abs(value), 0);
        }
      }
      // Inputs are supplied newest-source first by the orchestrator; do not
      // average duplicate filings or mix revisions.
      return matches[0].value;
    };
    const shareCapital = get("share_capital");
    const reserves = get("reserves");
    const equity = get("equity") ??
      (shareCapital != null && reserves != null ? shareCapital + reserves : null);
    const borrowingsCurrent = get("borrowings_current");
    const borrowingsNoncurrent = get("borrowings_noncurrent");
    const grossDebt = get("gross_debt") ??
      (borrowingsCurrent != null || borrowingsNoncurrent != null
        ? (borrowingsCurrent ?? 0) + (borrowingsNoncurrent ?? 0)
        : null);
    const sourceFacts = [...flowFacts, ...instantFacts];
    const sources = sourceFacts.map((f) => f.source).filter(
      (s, i, a) => a.findIndex((x) => x.url === s.url) === i
    );
    rows.push({
      period: fyLabel(periodEnd), periodEnd,
      revenue: get("revenue"), ebitda: get("ebitda"), ebit: get("ebit"),
      profitBeforeTax: get("profit_before_tax"), netIncome: get("net_income"), eps: get("eps"),
      taxExpense: get("tax_expense"), financeCosts: get("finance_costs"), depreciation: get("depreciation"),
      currentAssets: get("current_assets"), currentLiabilities: get("current_liabilities"),
      totalAssets: get("total_assets"), totalLiabilities: get("total_liabilities"), equity,
      cash: get("cash_and_equivalents"), borrowingsCurrent, borrowingsNoncurrent, grossDebt,
      cfo: get("cash_from_operations"), capex: get("capex"), sources,
    });
  }
  return rows;
}

export function conceptAliases(): Readonly<Record<FinancialConcept, readonly string[]>> {
  return CONCEPT_ALIASES;
}
