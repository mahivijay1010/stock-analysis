/**
 * Fundamentals fallback engine + sanity circuit-breaker + widened parsing.
 * Live Screener is exercised separately; here providers are mocked so the
 * merge / sanity / provenance logic is deterministic.
 */

import { sanitizeRatios, crossFieldContradictions } from "../src/services/intelligence/fundamentalsSanity";
import { FundamentalsEngine } from "../src/services/intelligence/FundamentalsEngine";
import { FundamentalsProvider, ProviderResult, ScrapedRatios } from "../src/services/intelligence/providers/fundamentalsTypes";
import { yoyFromRow } from "../src/services/intelligence/providers/ScreenerDataSource";

function provider(name: string, values: Partial<ScrapedRatios>): FundamentalsProvider {
  return { name, fetch: async (): Promise<ProviderResult> => ({ values, source: { provider: name, sourceLevel: 4, url: "" } }) };
}
const throwing = (name: string): FundamentalsProvider => ({ name, fetch: async () => { throw new Error("down"); } });

describe("sanity circuit-breaker", () => {
  test("drops physically-impossible values, keeps the good ones", () => {
    const { clean, rejected } = sanitizeRatios({ peRatio: 1500, currentRatio: 80, roe: 18, promoterHolding: 62 });
    expect(clean.roe).toBe(18);
    expect(clean.promoterHolding).toBe(62);
    expect(clean.peRatio).toBeUndefined(); // >1000
    expect(clean.currentRatio).toBeUndefined(); // >50 (Cr/Lakh error)
    expect(rejected.map((r) => r.field).sort()).toEqual(["currentRatio", "peRatio"]);
  });

  test("cross-field: positive P/E with clearly-negative ROE drops the P/E", () => {
    expect(crossFieldContradictions({ peRatio: 30, roe: -12 })).toContain("peRatio");
    expect(crossFieldContradictions({ peRatio: 30, roe: 12 })).toEqual([]);
  });
});

describe("yoyFromRow (widened quarterly parse)", () => {
  test("YoY = latest vs 4 quarters ago", () => {
    expect(yoyFromRow([10, 11, 12, 13, 20])).toBe(100); // 20 vs 10
    expect(yoyFromRow([100, 90, 80, 70, 50])).toBe(-50);
  });
  test("too few quarters or zero base ⇒ null", () => {
    expect(yoyFromRow([10, 20])).toBeNull();
    expect(yoyFromRow([0, 1, 2, 3, 5])).toBeNull();
  });
});

describe("fallback + merge engine", () => {
  test("merges gaps across providers, first-priority wins per field, records provenance", async () => {
    const engine = new FundamentalsEngine([
      provider("SCREENER", { roe: 18, peRatio: 25 }),
      provider("TRENDLYNE", { roe: 17, currentRatio: 1.4, debtToEquity: 0.3 }), // fills gaps only
    ]);
    const m = await engine.getRatios("X");
    expect(m.values.roe).toBe(18); // Screener wins (higher priority)
    expect(m.values.currentRatio).toBe(1.4); // filled by Trendlyne
    expect(m.fieldSources.roe).toBe("SCREENER");
    expect(m.fieldSources.currentRatio).toBe("TRENDLYNE");
    expect(m.providersTried).toEqual(["SCREENER", "TRENDLYNE"]);
  });

  test("a throwing provider is skipped, the chain continues", async () => {
    const engine = new FundamentalsEngine([throwing("SCREENER"), provider("TICKERTAPE", { roe: 15 })]);
    const m = await engine.getRatios("X");
    expect(m.values.roe).toBe(15);
    expect(m.providersTried).toEqual(["SCREENER(error)", "TICKERTAPE"]);
  });

  test("all sources empty ⇒ empty record (never a thrown error or a fake zero)", async () => {
    const engine = new FundamentalsEngine([provider("A", {}), provider("B", {})]);
    const m = await engine.getRatios("X");
    expect(Object.keys(m.values)).toHaveLength(0);
    expect(engine.toMetricResults(m)).toEqual([]);
  });

  test("impossible scraped values are dropped by the engine before persistence", async () => {
    const engine = new FundamentalsEngine([provider("SCREENER", { roe: 18, peRatio: 99999 })]);
    const m = await engine.getRatios("X");
    expect(m.values.roe).toBe(18);
    expect(m.values.peRatio).toBeUndefined();
    expect(m.rejected.some((r) => r.field === "peRatio")).toBe(true);
    const rows = engine.toMetricResults(m);
    expect(rows.find((r) => r.metric === "pe_ratio")).toBeUndefined();
    expect(rows.find((r) => r.metric === "roe")!.status).toBe("SCRAPED");
  });
});
