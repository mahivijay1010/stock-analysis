/**
 * Scraping MarketDataProvider layer — the reviewer's data-integrity firewall:
 * parser-change detection, mandatory freshness, source disagreement, bounded
 * concurrency, deterministic retry/backoff, mode authority ceiling, and
 * provider swappability.
 */

import { validateQuote, classifyFreshness, reconcilePrices, buildScrapedSnapshot } from "../src/services/realtime/snapshotValidation";
import { mapWithConcurrency, withRetry, backoffDelay } from "../src/services/realtime/asyncUtils";
import { ScrapingMarketProvider, buildProvenanceRows } from "../src/services/realtime/scrapingMarketProvider";
import { modeAuthorityCeiling, capActionByMode, snapshotToDataQuality, RawPriceQuote, PriceSource, Security } from "../src/services/realtime/marketDataProvider";

const SEC: Security = { securityId: "s1", ticker: "RELIANCE.NS" };
const NOW = 1_700_000_000_000;
const quote = (over: Partial<RawPriceQuote> = {}): RawPriceQuote => ({
  source: "A", securityId: "s1", ticker: "RELIANCE.NS", price: 1435, previousClose: 1420, open: 1421,
  dayHigh: 1440, dayLow: 1418, volume: 1_800_000, changePct: 1.06, sourceTimestamp: NOW - 60_000, fetchedAt: NOW, ...over,
});

describe("validateQuote — the parser firewall", () => {
  test("a clean quote is OK", () => expect(validateQuote(quote(), "RELIANCE.NS").quality).toBe("OK"));
  test("a missing price (selector change) ⇒ PARSER_ERROR", () => {
    expect(validateQuote(quote({ price: null }), "RELIANCE.NS").quality).toBe("PARSER_ERROR");
  });
  test("invariant breaches ⇒ DATA_INVALID", () => {
    expect(validateQuote(quote({ price: 1500 }), "RELIANCE.NS").quality).toBe("DATA_INVALID"); // price > dayHigh
    expect(validateQuote(quote({ dayLow: 1450 }), "RELIANCE.NS").quality).toBe("DATA_INVALID"); // low > high
    expect(validateQuote(quote({ volume: -5 }), "RELIANCE.NS").quality).toBe("DATA_INVALID");
    expect(validateQuote(quote({ changePct: 95 }), "RELIANCE.NS").quality).toBe("DATA_INVALID");
  });
  test("ticker mismatch ⇒ DATA_INVALID; fetch error ⇒ FAILED", () => {
    expect(validateQuote(quote({ ticker: "TCS.NS" }), "RELIANCE.NS").quality).toBe("DATA_INVALID");
    expect(validateQuote(quote({ fetchError: "timeout" }), "RELIANCE.NS").quality).toBe("FAILED");
  });
});

describe("freshness is mandatory", () => {
  test("recent source timestamp ⇒ FRESH; old ⇒ STALE; missing ⇒ UNKNOWN_FRESHNESS", () => {
    expect(classifyFreshness(quote({ sourceTimestamp: NOW - 60_000 }), NOW).freshness).toBe("FRESH");
    expect(classifyFreshness(quote({ sourceTimestamp: NOW - 30 * 60_000 }), NOW).freshness).toBe("STALE");
    expect(classifyFreshness(quote({ sourceTimestamp: null }), NOW).freshness).toBe("UNKNOWN_FRESHNESS");
  });
  test("a stale/failed snapshot maps to a non-HEALTHY data quality (⇒ no new entry)", () => {
    const stale = buildScrapedSnapshot(SEC, [quote({ sourceTimestamp: NOW - 30 * 60_000 })], { now: NOW });
    expect(snapshotToDataQuality(stale)).toBe("DEGRADED");
    const failed = buildScrapedSnapshot(SEC, [quote({ fetchError: "down" })], { now: NOW });
    expect(snapshotToDataQuality(failed)).toBe("UNAVAILABLE");
  });
});

describe("multi-source reconciliation", () => {
  test("agreeing sources merge to a median price", () => {
    expect(reconcilePrices([1435.2, 1435.25, 1435.1]).agreed).toBe(true);
  });
  test("disagreeing sources ⇒ SOURCE_DISAGREEMENT (quarantine)", () => {
    // B is internally VALID (its own OHLC band around 1392) but disagrees with A.
    const snap = buildScrapedSnapshot(SEC, [quote({ source: "A", price: 1435 }), quote({ source: "B", price: 1392, open: 1393, dayHigh: 1395, dayLow: 1390, previousClose: 1420, changePct: -1.97 })], { now: NOW });
    expect(snap.quality).toBe("SOURCE_DISAGREEMENT");
    expect(snapshotToDataQuality(snap)).toBe("UNAVAILABLE");
  });
  test("one good + one failed source still yields an OK snapshot from the good one", () => {
    const snap = buildScrapedSnapshot(SEC, [quote({ source: "A" }), quote({ source: "B", fetchError: "timeout" })], { now: NOW });
    expect(snap.quality).toBe("OK");
    expect(snap.price).toBe(1435);
  });
});

describe("mode authority ceiling (scraped snapshot cannot BUY on its own)", () => {
  test("SCRAPED_SNAPSHOT caps at WAIT; a BUY is lowered", () => {
    expect(modeAuthorityCeiling("SCRAPED_SNAPSHOT")).toBe("WAIT");
    expect(capActionByMode("BUY_CANDIDATE", "SCRAPED_SNAPSHOT")).toBe("WAIT");
    expect(capActionByMode("AVOID_NEW_ENTRY", "SCRAPED_SNAPSHOT")).toBe("AVOID_NEW_ENTRY"); // lower stays
  });
  test("richer modes lift the ceiling", () => {
    expect(capActionByMode("BUY_CANDIDATE", "INTRADAY_CANDLES")).toBe("BUY_CANDIDATE");
    expect(capActionByMode("BUY_CANDIDATE", "STREAMING")).toBe("BUY_CANDIDATE");
  });
});

describe("async orchestration", () => {
  test("mapWithConcurrency never exceeds the limit and preserves order", async () => {
    let live = 0, peak = 0;
    const worker = async (n: number) => {
      live++; peak = Math.max(peak, live);
      await Promise.resolve();
      live--;
      return n * 2;
    };
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], worker, 3);
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBeLessThanOrEqual(3);
  });
  test("withRetry retries then succeeds; backoff is deterministic with injected rng", async () => {
    let calls = 0;
    const slept: number[] = [];
    const r = await withRetry(async () => { if (++calls < 3) throw new Error("fail"); return "ok"; }, {
      retries: 3, baseDelayMs: 100, maxDelayMs: 1000, jitter: true, rng: () => 0.5, sleep: async (ms) => { slept.push(ms); },
    });
    expect(r).toBe("ok");
    expect(calls).toBe(3);
    expect(slept).toEqual([backoffDelay(0, { retries: 3, baseDelayMs: 100, maxDelayMs: 1000, jitter: true, rng: () => 0.5 }), backoffDelay(1, { retries: 3, baseDelayMs: 100, maxDelayMs: 1000, jitter: true, rng: () => 0.5 })]);
  });
  test("withRetry rethrows after exhausting attempts", async () => {
    await expect(withRetry(async () => { throw new Error("always"); }, { retries: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: false, sleep: async () => {} })).rejects.toThrow("always");
  });
});

describe("ScrapingMarketProvider — swappable, bounded, honest", () => {
  const source = (name: string, price: number | null, extra: Partial<RawPriceQuote> = {}): PriceSource => ({
    name,
    fetch: async (s) => quote({ source: name, price, securityId: s.securityId, ticker: s.ticker, ...extra }),
  });

  test("mode is SCRAPED_SNAPSHOT and fetchUniverse returns one snapshot per input", async () => {
    const p = new ScrapingMarketProvider([source("A", 1435)], { now: () => NOW });
    expect(p.mode).toBe("SCRAPED_SNAPSHOT");
    const snaps = await p.fetchUniverse([SEC, { securityId: "s2", ticker: "TCS.NS" }]);
    expect(snaps).toHaveLength(2);
    expect(snaps[0].mode).toBe("SCRAPED_SNAPSHOT");
  });
  test("a source that always throws is absorbed as a FAILED quote, not a crash", async () => {
    const flaky: PriceSource = { name: "X", fetch: async () => { throw new Error("network"); } };
    const p = new ScrapingMarketProvider([flaky], { now: () => NOW, retry: { retries: 0, baseDelayMs: 1, maxDelayMs: 1, jitter: false, sleep: async () => {} }, scheduler: () => () => {} });
    const snap = await p.fetchStock(SEC);
    expect(snap.quality).toBe("FAILED");
    expect(snapshotToDataQuality(snap)).toBe("UNAVAILABLE");
    expect(p.health().state).toBe("DISCONNECTED");
  });
  test("provenance rows carry a rawHash + parsingVersion per source", () => {
    const rows = buildProvenanceRows([quote({ source: "A" }), quote({ source: "B", price: 1436 })], "scrape-v1", "SCRAPED_SNAPSHOT");
    expect(rows).toHaveLength(2);
    expect(rows[0].rawHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].parsingVersion).toBe("scrape-v1");
    expect(rows[0].rawHash).not.toBe(rows[1].rawHash); // different payloads ⇒ different hashes
  });
});
