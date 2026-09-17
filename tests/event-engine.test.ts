/**
 * Phase 9+10 tests — deterministic headline classifier, and the new
 * ROCE / working-capital calculations (formula correctness + honest
 * refusals when inputs are missing or the entity is a bank).
 */

import { classifyHeadline } from "../src/services/market/EventService";
import { calculateRoce, calculateWorkingCapital } from "../src/services/intelligence/calculations";
import { AnnualFinancials } from "../src/services/intelligence/types";

function fy(over: Partial<AnnualFinancials>): AnnualFinancials {
  return {
    period: "FY2025",
    periodEnd: "2025-03-31",
    revenue: null,
    ebitda: null,
    ebit: null,
    profitBeforeTax: null,
    netIncome: null,
    eps: null,
    taxExpense: null,
    financeCosts: null,
    depreciation: null,
    currentAssets: null,
    currentLiabilities: null,
    totalAssets: null,
    totalLiabilities: null,
    equity: null,
    cash: null,
    borrowingsCurrent: null,
    borrowingsNoncurrent: null,
    grossDebt: null,
    cfo: null,
    capex: null,
    sources: [],
    ...over,
  };
}

describe("classifyHeadline — deterministic keyword rules", () => {
  test.each([
    ["BHEL bags Rs 5,500 crore order from NTPC", "order_win"],
    ["SEBI issues show cause notice to promoter entity", "regulatory"],
    ["Company appoints new CFO effective October", "management_change"],
    ["Firm faces arbitration over supply contract", "litigation"],
    ["Brokerage upgrades stock, raises target price", "rating_change"],
    ["Q2 results: net profit rises 18% on strong execution", "results"],
    ["Shares rise on heavy volumes", null],
  ])("%s → %s", (headline, expected) => {
    expect(classifyHeadline(headline)).toBe(expected);
  });
});

describe("calculateRoce (Phase 10)", () => {
  const prev = fy({ period: "FY2024", periodEnd: "2024-03-31", totalAssets: 900, currentLiabilities: 300 });

  test("EBIT over average capital employed", () => {
    const cur = fy({ profitBeforeTax: 90, financeCosts: 10, totalAssets: 1100, currentLiabilities: 300 });
    const r = calculateRoce(cur, prev);
    // EBIT 100; CE now 800, prev 600, avg 700 → 14.2857%
    expect(r.status).toBe("CALCULATED");
    expect(r.value).toBeCloseTo(14.2857, 3);
  });

  test("refuses without a prior period or balance-sheet inputs", () => {
    const cur = fy({ profitBeforeTax: 90, financeCosts: 10, totalAssets: 1100, currentLiabilities: 300 });
    expect(calculateRoce(cur, null).status).toBe("NOT_AVAILABLE");
    expect(calculateRoce(fy({ profitBeforeTax: 90, financeCosts: 10 }), prev).status).toBe("NOT_AVAILABLE");
  });

  test("not meaningful for banks/NBFCs/insurers", () => {
    const cur = fy({ profitBeforeTax: 90, financeCosts: 10, totalAssets: 1100, currentLiabilities: 300 });
    const r = calculateRoce(cur, prev, "FINANCIAL");
    expect(r.status).toBe("NOT_AVAILABLE");
    expect(r.methodology).toBe("FINANCIAL_NOT_MEANINGFUL");
  });
});

describe("calculateWorkingCapital (Phase 10)", () => {
  test("current assets minus current liabilities, with WC-days when revenue known", () => {
    const r = calculateWorkingCapital(fy({ currentAssets: 500, currentLiabilities: 320, revenue: 1460 }));
    expect(r.status).toBe("CALCULATED");
    expect(r.value).toBe(180);
    expect(r.inputs.wc_days_of_revenue).toBeCloseTo(45, 0);
  });

  test("refuses when balance-sheet inputs are missing; not meaningful for banks/NBFCs/insurers", () => {
    expect(calculateWorkingCapital(fy({ currentAssets: 500 })).status).toBe("NOT_AVAILABLE");
    expect(calculateWorkingCapital(fy({ currentAssets: 500, currentLiabilities: 320 }), "FINANCIAL").methodology).toBe(
      "FINANCIAL_NOT_MEANINGFUL"
    );
  });
});
