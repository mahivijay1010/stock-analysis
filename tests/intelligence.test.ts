import { calculateCurrentRatio, calculateFcf, calculateGrowth, calculatePeg, calculateRoe, calculateRoic, evaluateRules } from "../src/services/intelligence/calculations";
import { calculateDcf } from "../src/services/intelligence/dcf";
import { extractDocumentEvidence } from "../src/services/intelligence/documentExtraction";
import { calculateCorrelationMatrix, calculatePortfolioExposure } from "../src/services/intelligence/portfolioAnalytics";
import { AnnualFinancials } from "../src/services/intelligence/types";
import { buildAnnualSeries, normalizeXbrl, parseXbrlContexts } from "../src/services/intelligence/xbrl";
import { Bar } from "../src/services/market/types";

const source = { provider: "NSE", sourceLevel: 1 as const, url: "https://nsearchives.nseindia.com/example.xml" };

function annual(period: string, periodEnd: string, values: Partial<AnnualFinancials>): AnnualFinancials {
  return { period, periodEnd, revenue: null, ebitda: null, ebit: null, profitBeforeTax: null,
    netIncome: null, eps: null, taxExpense: null, financeCosts: null, depreciation: null,
    currentAssets: null, currentLiabilities: null, totalAssets: null, totalLiabilities: null,
    equity: null, cash: null, borrowingsCurrent: null, borrowingsNoncurrent: null, grossDebt: null,
    cfo: null, capex: null, sources: [source], ...values };
}

describe("provenance-first calculations", () => {
  const current = annual("FY2026", "2026-03-31", { netIncome: 120, eps: 12, ebit: 180,
    profitBeforeTax: 160, taxExpense: 40, equity: 600, grossDebt: 100, cash: 50,
    cfo: 175, capex: -55, currentAssets: 300, currentLiabilities: 150 });
  const previous = annual("FY2025", "2025-03-31", { netIncome: 100, eps: 10, equity: 500,
    grossDebt: 120, cash: 40 });

  it("uses average equity, cash capex sign normalization, and average invested capital", () => {
    expect(calculateRoe(current, previous).value).toBeCloseTo(21.8182);
    expect(calculateFcf(current).value).toBe(120);
    expect(calculateCurrentRatio(current).value).toBe(2);
    expect(calculateRoic(current, previous).value).toBeCloseTo(21.9512);
  });

  // Regression for docs/system-trust-review.md §6: when grossDebt AND both
  // borrowing sub-concepts are absent, debt used to be silently imputed as 0
  // (via `(borrowingsCurrent ?? 0) + (borrowingsNoncurrent ?? 0)`), inflating
  // ROIC for a company whose debt is simply unreported — not one that is
  // genuinely debt-free. calculateRoic must now refuse instead.
  it("refuses ROIC when debt is entirely unreported, rather than imputing zero debt", () => {
    const noDebtData = annual("FY2026", "2026-03-31", {
      ebit: 180, profitBeforeTax: 160, taxExpense: 40, equity: 600, cash: 50,
      // grossDebt, borrowingsCurrent, borrowingsNoncurrent all left null
    });
    const prevNoDebtData = annual("FY2025", "2025-03-31", { equity: 500, cash: 40 });
    const r = calculateRoic(noDebtData, prevNoDebtData);
    expect(r.status).toBe("NOT_AVAILABLE");
    expect(r.value).toBeNull();
  });

  it("still computes ROIC when debt is known via borrowing sub-concepts (no grossDebt line)", () => {
    const withSubConcepts = annual("FY2026", "2026-03-31", {
      ebit: 180, profitBeforeTax: 160, taxExpense: 40, equity: 600, cash: 50,
      borrowingsCurrent: 30, borrowingsNoncurrent: 70, // sums to the same 100 as `current.grossDebt` above
    });
    const prevWithSubConcepts = annual("FY2025", "2025-03-31", {
      equity: 500, cash: 40, borrowingsCurrent: 40, borrowingsNoncurrent: 80,
    });
    const r = calculateRoic(withSubConcepts, prevWithSubConcepts);
    expect(r.status).toBe("CALCULATED");
    expect(r.value).toBeCloseTo(21.9512); // same as the grossDebt=100/120 case above
  });

  it("still computes ROIC when debt is known and genuinely zero (a sub-concept is explicitly 0, not null)", () => {
    const zeroDebt = annual("FY2026", "2026-03-31", {
      ebit: 180, profitBeforeTax: 160, taxExpense: 40, equity: 600, cash: 50,
      borrowingsCurrent: 0, borrowingsNoncurrent: 0,
    });
    const prevZeroDebt = annual("FY2025", "2025-03-31", { equity: 500, cash: 40, borrowingsCurrent: 0, borrowingsNoncurrent: 0 });
    const r = calculateRoic(zeroDebt, prevZeroDebt);
    expect(r.status).toBe("CALCULATED");
  });

  it("keeps missing inputs unavailable instead of converting them to a failed rule", () => {
    const metric = calculateRoe(current, null);
    expect(metric.status).toBe("NOT_AVAILABLE");
    expect(evaluateRules({ roe: null, roic: null, earningsGrowth: null, fcf: null, currentRatio: null, peg: null }))
      .toEqual({ roe_15: "NOT_AVAILABLE", roic_15: "NOT_AVAILABLE", earnings_growth_positive: "NOT_AVAILABLE",
        fcf_positive: "NOT_AVAILABLE", current_ratio_1: "NOT_AVAILABLE", peg_1_5: "NOT_AVAILABLE" });
  });

  it("calculates historical CAGR/PEG and rejects non-positive growth", () => {
    const series = [current, previous,
      annual("FY2024", "2024-03-31", { netIncome: 90, eps: 9 }),
      annual("FY2023", "2023-03-31", { netIncome: 80, eps: 8 })];
    const growth = calculateGrowth(series);
    expect(growth.value?.epsCagr3yPct).toBeCloseTo(14.4714);
    expect(calculatePeg(28, growth).value).toBeCloseTo(1.9349);
    const negative = calculateGrowth([annual("FY2026", "2026-03-31", { eps: -1 }), previous]);
    expect(calculatePeg(10, negative).status).toBe("NOT_AVAILABLE");
  });

  it("returns explicit bear/base/bull DCF and sensitivity assumptions", () => {
    const dcf = calculateDcf({ latestFcf: 100, debt: 20, cash: 10, sharesOutstanding: 10, currentPrice: 100,
      period: "FY2026", sources: [source] });
    // ESTIMATED, not CALCULATED: growth/WACC/terminal-growth are fixed
    // assumptions, not measured inputs (docs/system-trust-review.md §6).
    expect(dcf.status).toBe("ESTIMATED");
    expect(dcf.value?.scenarios.map((x) => x.name)).toEqual(["bear", "base", "bull"]);
    expect(dcf.value?.sensitivity.length).toBeGreaterThan(0);
    expect(dcf.value?.scenarios.every((x) => x.assumptions.terminalGrowthPct < x.assumptions.waccPct)).toBe(true);
  });
});

describe("XBRL normalization", () => {
  const xml = `<?xml version="1.0"?><xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:in="x">
    <xbrli:context id="D"><xbrli:entity><xbrli:identifier scheme="x">TCS</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:startDate>2025-04-01</xbrli:startDate><xbrli:endDate>2026-03-31</xbrli:endDate></xbrli:period></xbrli:context>
    <xbrli:context id="I"><xbrli:entity><xbrli:identifier scheme="x">TCS</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:instant>2026-03-31</xbrli:instant></xbrli:period></xbrli:context>
    <in:RevenueFromOperations contextRef="D" unitRef="INR">240000000</in:RevenueFromOperations>
    <in:ProfitLossForPeriod contextRef="D" unitRef="INR">46000000</in:ProfitLossForPeriod>
    <in:CashFlowsFromUsedInOperatingActivities contextRef="D" unitRef="INR">50000000</in:CashFlowsFromUsedInOperatingActivities>
    <in:PurchaseOfTangibleAssetsClassifiedAsInvestingActivities contextRef="D" unitRef="INR">2000000</in:PurchaseOfTangibleAssetsClassifiedAsInvestingActivities>
    <in:PurchaseOfIntangibleAssetsClassifiedAsInvestingActivities contextRef="D" unitRef="INR">500000</in:PurchaseOfIntangibleAssetsClassifiedAsInvestingActivities>
    <in:Equity contextRef="I" unitRef="INR">90000000</in:Equity>
  </xbrli:xbrl>`;

  it("preserves contexts/raw concepts and sums distinct capex components", () => {
    expect(parseXbrlContexts(xml).size).toBe(2);
    const facts = normalizeXbrl(xml, { ticker: "TCS", consolidation: "CONSOLIDATED", source });
    const series = buildAnnualSeries(facts)[0];
    expect(series.revenue).toBe(240000000);
    expect(series.capex).toBe(2500000);
    expect(facts.every((fact) => fact.source.url === source.url && fact.rawConcept.length > 0)).toBe(true);
  });
});

describe("document and portfolio analytics", () => {
  it("never conflates order book with order inflow", () => {
    const evidence = extractDocumentEvidence(
      "As of 31 March 2026, the order book stood at INR 25,000 crore. During FY2026, order inflow was INR 18,000 crore.",
      "https://company.example/investor.pdf"
    );
    expect(evidence.find((x) => x.category === "ORDER_BOOK")?.value).toBe(250_000_000_000);
    expect(evidence.find((x) => x.category === "ORDER_INFLOW")?.value).toBe(180_000_000_000);
  });

  it("uses market values for concentration and daily returns for correlations", () => {
    const exposure = calculatePortfolioExposure([
      { ticker: "A", quantity: 2, averagePrice: 50, currentPrice: 100, sector: "IT" },
      { ticker: "B", quantity: 1, averagePrice: 100, currentPrice: 100, sector: "Bank" },
    ]);
    expect(exposure.positions[0].stockWeightPct).toBeCloseTo(66.6667);
    const bars = (closes: number[]): Bar[] => closes.map((close, index) => ({ date: `2026-01-${String(index + 1).padStart(2, "0")}`, open: close, high: close, low: close, close, volume: 1 }));
    const matrix = calculateCorrelationMatrix({ A: bars(Array.from({ length: 31 }, (_, i) => 100 + i * i)),
      B: bars(Array.from({ length: 31 }, (_, i) => 50 + i * i * 2)) }, "30D");
    expect(matrix.matrix[0][1]).not.toBeNull();
    expect(matrix.observations["A:B"]).toBe(30);
  });
});
