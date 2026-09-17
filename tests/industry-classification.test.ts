/**
 * Regression test for docs/system-trust-review.md §5.1: the old hardcoded
 * 10-ticker BANKS regex (IntelligenceService.ts) missed 24 of the 34
 * financial-sector tickers in the 151-stock universe (real banks like PNB,
 * CANBK, BANKBARODA, UNIONBANK, YESBANK, plus every NBFC and insurer), so
 * those tickers silently got industrial ROIC/ROCE/current-ratio/FCF/DCF with
 * no refusal. classifyIndustryKind now classifies by the universe's own
 * sector field (Banking/Financial Services/Insurance), with a name-pattern
 * fallback only for tickers outside NSE_UNIVERSE.
 */

import { classifyIndustryKind } from "../src/services/intelligence/IntelligenceService";
import { NSE_UNIVERSE } from "../src/data/nseUniverse";

const FINANCIAL_SECTORS = new Set(["Banking", "Financial Services", "Insurance"]);

describe("classifyIndustryKind — universe sector path", () => {
  test("every previously-covered bank still classifies FINANCIAL", () => {
    // The old regex's exact 10 tickers — must not regress.
    for (const t of ["HDFCBANK", "ICICIBANK", "AXISBANK", "KOTAKBANK", "SBIN", "INDUSINDBK", "FEDERALBNK", "BANDHANBNK", "IDFCFIRSTB", "AUBANK"]) {
      expect(classifyIndustryKind(t)).toBe("FINANCIAL");
    }
  });

  test("banks the old regex MISSED are now correctly FINANCIAL", () => {
    for (const t of ["PNB", "CANBK", "BANKBARODA", "UNIONBANK", "YESBANK"]) {
      expect(classifyIndustryKind(t)).toBe("FINANCIAL");
    }
  });

  test("NBFCs and insurers the old regex missed are now correctly FINANCIAL", () => {
    for (const t of ["BAJFINANCE", "BAJAJFINSV", "SHRIRAMFIN", "CHOLAFIN", "MUTHOOTFIN", "LICI", "SBICARD", "HDFCLIFE", "SBILIFE", "ICICIGI", "ICICIPRULI", "PFC", "RECLTD", "HDFCAMC"]) {
      expect(classifyIndustryKind(t)).toBe("FINANCIAL");
    }
  });

  test("genuine non-financial tickers stay NON_FINANCIAL", () => {
    for (const t of ["RELIANCE", "TCS", "INFY", "SUNPHARMA", "MARUTI", "ITC"]) {
      expect(classifyIndustryKind(t)).toBe("NON_FINANCIAL");
    }
  });

  test("accepts a .NS suffix and is case-insensitive", () => {
    expect(classifyIndustryKind("HDFCBANK.NS")).toBe("FINANCIAL");
    expect(classifyIndustryKind("hdfcbank")).toBe("FINANCIAL");
    expect(classifyIndustryKind("reliance.NS")).toBe("NON_FINANCIAL");
  });

  test("every Banking/Financial Services/Insurance ticker in the universe classifies FINANCIAL", () => {
    const financialTickers = NSE_UNIVERSE.filter((s) => FINANCIAL_SECTORS.has(s.sector));
    // Sanity: the universe really does contain more than the old regex's 10.
    expect(financialTickers.length).toBeGreaterThan(10);
    for (const stock of financialTickers) {
      expect(classifyIndustryKind(stock.ticker)).toBe("FINANCIAL");
    }
  });

  test("every non-financial-sector ticker in the universe classifies NON_FINANCIAL", () => {
    const nonFinancial = NSE_UNIVERSE.filter((s) => !FINANCIAL_SECTORS.has(s.sector));
    for (const stock of nonFinancial) {
      expect(classifyIndustryKind(stock.ticker)).toBe("NON_FINANCIAL");
    }
  });
});

describe("classifyIndustryKind — name-pattern fallback (tickers outside NSE_UNIVERSE)", () => {
  test("falls back to a name pattern for an unlisted bank-like ticker", () => {
    expect(classifyIndustryKind("SOMENEWBANK")).toBe("FINANCIAL");
    expect(classifyIndustryKind("XYZFINANCE")).toBe("FINANCIAL");
    expect(classifyIndustryKind("ABCLIFE")).toBe("FINANCIAL");
  });

  test("falls back to NON_FINANCIAL for an unlisted, unrecognizable ticker", () => {
    expect(classifyIndustryKind("SOMENEWCO")).toBe("NON_FINANCIAL");
  });
});
