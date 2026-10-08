/** Security master ingestion: parsing, classification, dedupe, change detection, liquidity tiers, activity. */
import { parseListingCsv, parseSymbolChanges, parseNameChanges, parseIndexList, parseNseDate } from "../src/services/universe/providers/NseSecurityMasterProvider";
import { classifyInstrumentType, dedupeListings, diffMaster, industryIndexMap, isActiveByTrade, isTradable, liquidityTierOf, marketCapBucketFromIndices, marketCapBucketFromValue, MasterRowInput } from "../src/services/universe/universeClassification";
import { scoreCoverage } from "../src/services/universe/SecurityDataCoverageService";

const EQ = `SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE
RELIANCE,Reliance Industries Limited,EQ,29-NOV-1995,10,1,INE002A01018,10
ABC,ABC Limited,BE,01-JAN-2020,10,1,INE000A00001,10
EMBASSY,Embassy Office Parks REIT,EQ,01-APR-2019,10,1,INE041025011,10`;
const SME = `SYMBOL,NAME_OF_COMPANY,SERIES,DATE_OF_LISTING,PAID_UP_VALUE,ISIN_NUMBER,FACE_VALUE,
EVENTIONS,Eventions Limited,ST,08-Oct-26,10,INE20M201019,10,`;

describe("NSE list parsing", () => {
  test("EQUITY_L rows with series, ISIN, listing date", () => {
    const rows = parseListingCsv(EQ, "EQUITY_L");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ symbol: "RELIANCE", series: "EQ", isin: "INE002A01018", listedDate: "1995-11-29", faceValue: 10 });
    expect(rows[1].series).toBe("BE");
  });
  test("SME list uses underscore headers and two-digit years", () => {
    const rows = parseListingCsv(SME, "SME_EQUITY_L");
    expect(rows[0]).toMatchObject({ symbol: "EVENTIONS", series: "ST", listedDate: "2026-10-08" });
  });
  test("symbol changes skip identity rows; name changes parse", () => {
    const sc = parseSymbolChanges("Cadila,CADILAHC,ZYDUSLIFE,07-MAR-2022\nSame,X,X,01-JAN-2020\n");
    expect(sc).toEqual([{ companyName: "Cadila", oldSymbol: "CADILAHC", newSymbol: "ZYDUSLIFE", effectiveDate: "2022-03-07" }]);
    const nc = parseNameChanges("NCH_SYMBOL, NCH_PREV_NAME, NCH_NEW_NAME, NCH_DT\nZYDUSLIFE,Cadila Healthcare Limited,Zydus Lifesciences Limited,07-MAR-2022");
    expect(nc[0]).toMatchObject({ symbol: "ZYDUSLIFE", newName: "Zydus Lifesciences Limited" });
  });
  test("index list carries NSE industry", () => {
    const m = parseIndexList("Company Name,Industry,Symbol,Series,ISIN Code\nReliance,Oil Gas & Consumable Fuels,RELIANCE,EQ,INE002A01018", "NIFTY100");
    expect(m[0]).toEqual({ symbol: "RELIANCE", index: "NIFTY100", industry: "Oil Gas & Consumable Fuels" });
  });
  test("date parsing tolerates bad input", () => {
    expect(parseNseDate("")).toBeNull();
    expect(parseNseDate("31-XYZ-2020")).toBeNull();
  });
});

describe("classification", () => {
  test("instrument types from list source, series and name", () => {
    const rows = parseListingCsv(EQ, "EQUITY_L");
    expect(classifyInstrumentType(rows[0])).toBe("EQUITY");
    expect(classifyInstrumentType(rows[2])).toBe("REIT");
    expect(classifyInstrumentType(parseListingCsv(SME, "SME_EQUITY_L")[0])).toBe("SME");
    expect(classifyInstrumentType({ symbol: "NIFTYBEES", companyName: "x", series: null, isin: null, listedDate: null, faceValue: null, listSource: "ETF" })).toBe("ETF");
    expect(classifyInstrumentType({ symbol: "T", companyName: "Oriental InfraTrust", series: "IV", isin: null, listedDate: null, faceValue: null, listSource: "INVITS_L" })).toBe("INVIT");
  });
  test("liquidity tiers are threshold-based and X when unknown", () => {
    expect(liquidityTierOf(2e8)).toBe("A");
    expect(liquidityTierOf(5e7)).toBe("B");
    expect(liquidityTierOf(1e7)).toBe("C");
    expect(liquidityTierOf(1e6)).toBe("X");
    expect(liquidityTierOf(null)).toBe("X");
  });
  test("market-cap bucket from NSE indices is labelled; value-based buckets when a cap is known", () => {
    expect(marketCapBucketFromIndices(["NIFTY100", "NIFTY500"])).toEqual({ bucket: "LARGE", source: "nse-index:NIFTY100" });
    expect(marketCapBucketFromIndices(["SMALLCAP250"]).bucket).toBe("SMALL");
    expect(marketCapBucketFromIndices([]).bucket).toBe("UNKNOWN");
    expect(marketCapBucketFromValue(6e11)).toBe("LARGE");
    expect(marketCapBucketFromValue(1e10)).toBe("MICRO");
  });
  test("tradable = active main-board EQ equity in tier A/B with no surveillance", () => {
    const base = { instrumentType: "EQUITY" as const, series: "EQ", liquidityTier: "A" as const, isActive: true, surveillance: null };
    expect(isTradable(base)).toBe(true);
    expect(isTradable({ ...base, liquidityTier: "C" })).toBe(false);
    expect(isTradable({ ...base, series: "BE" })).toBe(false);
    expect(isTradable({ ...base, surveillance: "ASM-ST" })).toBe(false);
    expect(isTradable({ ...base, instrumentType: "SME" })).toBe(false);
    expect(isTradable({ ...base, isActive: false })).toBe(false);
  });
  test("activity: inactive after 20 sessions without an EQ trade", () => {
    const sessions = Array.from({ length: 40 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`);
    expect(isActiveByTrade("2026-09-40", "2026-09-40", sessions)).toBe(true);
    expect(isActiveByTrade("2026-09-25", "2026-09-40", sessions)).toBe(true);
    expect(isActiveByTrade("2026-09-10", "2026-09-40", sessions)).toBe(false);
    expect(isActiveByTrade(null, "2026-09-40", sessions)).toBe(false);
  });
});

describe("dedupe + change detection", () => {
  const stored = new Map<string, MasterRowInput>([
    ["RELIANCE", { symbol: "RELIANCE", companyName: "Reliance Industries Limited", isin: "INE002A01018", series: "EQ", instrumentType: "EQUITY", listedDate: "1995-11-29", isActive: true }],
    ["OLDCO", { symbol: "OLDCO", companyName: "Old Co", isin: "INE1", series: "EQ", instrumentType: "EQUITY", listedDate: null, isActive: false }],
  ]);
  test("never duplicates a symbol; main board beats SME on a collision; REIT list beats EQUITY_L", () => {
    const d = dedupeListings([
      { symbol: "X", companyName: "X sme", series: "SM", isin: null, listedDate: null, faceValue: null, listSource: "SME_EQUITY_L" },
      { symbol: "X", companyName: "X main", series: "EQ", isin: null, listedDate: null, faceValue: null, listSource: "EQUITY_L" },
      { symbol: "R", companyName: "R eq", series: "EQ", isin: null, listedDate: null, faceValue: null, listSource: "EQUITY_L" },
      { symbol: "R", companyName: "R reit", series: "RR", isin: null, listedDate: null, faceValue: null, listSource: "REITS_L" },
    ]);
    expect(d).toHaveLength(2);
    expect(d.find((x) => x.symbol === "X")?.listSource).toBe("EQUITY_L");
    expect(d.find((x) => x.symbol === "R")?.listSource).toBe("REITS_L");
  });
  test("new listing, name change, ISIN change, series change, reactivation are detected; unchanged rows produce nothing", () => {
    const ch = diffMaster(stored, [
      { symbol: "RELIANCE", companyName: "Reliance Industries Limited", isin: "INE002A01018", series: "EQ", instrumentType: "EQUITY", listedDate: "1995-11-29", isActive: true },
      { symbol: "NEWCO", companyName: "New Co", isin: "INE9", series: "EQ", instrumentType: "EQUITY", listedDate: "2026-10-01", isActive: true },
      { symbol: "OLDCO", companyName: "Old Co Renamed", isin: "INE2", series: "BE", instrumentType: "EQUITY", listedDate: null, isActive: true },
    ]);
    expect(ch.map((c) => `${c.symbol}:${c.changeType}`).sort()).toEqual(["NEWCO:NEW_LISTING", "OLDCO:ISIN_CHANGE", "OLDCO:NAME_CHANGE", "OLDCO:REACTIVATED", "OLDCO:SERIES_CHANGE"]);
    expect(diffMaster(stored, [...stored.values()])).toHaveLength(0);
  });
  test("industry/index map keeps the first industry label and unions index memberships", () => {
    const m = industryIndexMap([{ symbol: "A", index: "NIFTY500", industry: "IT" }, { symbol: "A", index: "NIFTY100", industry: "IT Services" }]);
    expect(m.industry.get("A")).toBe("IT");
    expect(m.indices.get("A")).toEqual(["NIFTY500", "NIFTY100"]);
  });
});

describe("coverage score", () => {
  const base = { priceAvailable: true, ohlcvAvailable: true, closeOnly: false, historicalDepthSessions: 250, fundamentalsAvailable: true, financialResultsAvailable: true, corporateActionsAvailable: true, announcementAvailable: true, newsAvailable: true, technicalFeaturesAvailable: true, lastPriceTimestamp: null, lastFundamentalTimestamp: null, lastNewsTimestamp: null, lastEventTimestamp: null };
  test("full coverage is 100; close-only with no fundamentals is partial; depth scales", () => {
    expect(scoreCoverage(base)).toBe(100);
    expect(scoreCoverage({ ...base, ohlcvAvailable: false, closeOnly: true, fundamentalsAvailable: false, financialResultsAvailable: false, technicalFeaturesAvailable: false, newsAvailable: false, announcementAvailable: false, corporateActionsAvailable: false })).toBe(30);
    expect(scoreCoverage({ ...base, historicalDepthSessions: 125 })).toBe(92.5);
  });
});

describe("M4 fundamentals rotation picking", () => {
  const { pickRotation } = jest.requireActual("../src/services/universe/FundamentalsRotationService") as typeof import("../src/services/universe/FundamentalsRotationService");
  test("never-refreshed tier-A first, then oldest tier-A, then tier-B; batch respected", () => {
    const picked = pickRotation(
      [
        { symbol: "B_OLD", tier: "B", lastFundamentalAt: "2026-09-01T00:00:00Z" },
        { symbol: "A_FRESH", tier: "A", lastFundamentalAt: "2026-10-07T00:00:00Z" },
        { symbol: "A_NEVER", tier: "A", lastFundamentalAt: null },
        { symbol: "A_OLD", tier: "A", lastFundamentalAt: "2026-08-01T00:00:00Z" },
        { symbol: "B_NEVER", tier: "B", lastFundamentalAt: null },
      ],
      3
    );
    expect(picked).toEqual(["A_NEVER", "A_OLD", "A_FRESH"]);
    expect(pickRotation([], 5)).toEqual([]);
  });
});
