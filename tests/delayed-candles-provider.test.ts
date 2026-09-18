/**
 * DelayedCandlesProvider (docs/intraday-study-notes.md §4 item 6) — the first
 * intraday data path, and the honesty contract around it: DELAYED_CANDLES caps
 * at WAIT, the forming candle is dropped by the clock, freshness is judged
 * from the newest COMPLETE candle, and every snapshot passes the same
 * validation firewall as a scraped quote. All against fixture payloads.
 */

import { parseIntradayChartPayload, INTRADAY_INTERVAL_MS } from "../src/services/market/yahoo";
import {
  DelayedCandlesProvider,
  IntradayCandleFetcher,
  aggregateSession,
  completeCandlesOnly,
  istDateOfMs,
  seriesToRawQuote,
} from "../src/services/realtime/intradayCandlesProvider";
import { capActionByMode, modeAuthorityCeiling, snapshotToDataQuality, Security } from "../src/services/realtime/marketDataProvider";
import { validateQuote } from "../src/services/realtime/snapshotValidation";

const SEC: Security = { securityId: "s1", ticker: "RELIANCE.NS" };
const FIVE_M = INTRADAY_INTERVAL_MS["5m"];

// 2026-09-17 09:15 IST = 03:45 UTC. Build a session of 5m candles from that open.
const SESSION_OPEN_MS = Date.UTC(2026, 8, 17, 3, 45);
const NEXT_SESSION_OPEN_MS = Date.UTC(2026, 8, 18, 3, 45);

function candles(startMs: number, n: number, base = 1400) {
  const ts: number[] = [];
  const open: number[] = [];
  const high: number[] = [];
  const low: number[] = [];
  const close: number[] = [];
  const volume: number[] = [];
  for (let i = 0; i < n; i++) {
    const o = base + i;
    ts.push((startMs + i * FIVE_M) / 1000);
    open.push(o);
    high.push(o + 2);
    low.push(o - 1);
    close.push(o + 1);
    volume.push(1000 + i);
  }
  return { ts, open, high, low, close, volume };
}

function payload(parts: ReturnType<typeof candles>[], meta: Record<string, unknown> = {}) {
  const merge = <K extends keyof ReturnType<typeof candles>>(k: K) => parts.flatMap((p) => p[k] as unknown[]);
  return {
    chart: {
      result: [
        {
          meta: { symbol: "RELIANCE.NS", dataGranularity: "5m", chartPreviousClose: 1390, ...meta },
          timestamp: merge("ts"),
          indicators: { quote: [{ open: merge("open"), high: merge("high"), low: merge("low"), close: merge("close"), volume: merge("volume") }] },
        },
      ],
      error: null,
    },
  };
}

const fixtureFetcher = (data: unknown, name = "fixture"): IntradayCandleFetcher => ({
  name,
  fetch: async (s) => parseIntradayChartPayload(data, s.ticker),
});

describe("parseIntradayChartPayload — pure, never invents", () => {
  test("parses candles ascending with ms startAt; null OHLC rows are skipped; duplicate starts collapse", () => {
    const p = payload([candles(SESSION_OPEN_MS, 3)]);
    // inject a null-close row and a duplicate timestamp
    p.chart.result[0].timestamp.push(SESSION_OPEN_MS / 1000 + 3 * 300, SESSION_OPEN_MS / 1000);
    p.chart.result[0].indicators.quote[0].open.push(1403, 9999);
    p.chart.result[0].indicators.quote[0].high.push(1405, 9999);
    p.chart.result[0].indicators.quote[0].low.push(1402, 9999);
    p.chart.result[0].indicators.quote[0].close.push(null as unknown as number, 9999);
    p.chart.result[0].indicators.quote[0].volume.push(10, 10);
    const r = parseIntradayChartPayload(p, "RELIANCE.NS");
    expect(r.candles.map((c) => c.startAt)).toEqual([SESSION_OPEN_MS, SESSION_OPEN_MS + FIVE_M, SESSION_OPEN_MS + 2 * FIVE_M]);
    expect(r.candles[0].open).toBe(9999); // duplicate startAt: latest wins (documented)
    expect(r.meta.dataGranularity).toBe("5m");
  });

  test("vendor error or empty result throws rather than returning an empty-looking success", () => {
    expect(() => parseIntradayChartPayload({ chart: { error: { description: "No data found" } } }, "X.NS")).toThrow(/No data found/);
    expect(() => parseIntradayChartPayload({ chart: { result: [] } }, "X.NS")).toThrow(/no result/);
  });
});

describe("completeCandlesOnly — the intraday partial-bar guard", () => {
  const c = parseIntradayChartPayload(payload([candles(SESSION_OPEN_MS, 4)]), "RELIANCE.NS").candles;
  test("a candle is complete only when startAt + interval <= asOf", () => {
    const midThird = SESSION_OPEN_MS + 2 * FIVE_M + 120_000; // 2 minutes into the 3rd candle
    const r = completeCandlesOnly(c, FIVE_M, midThird);
    expect(r.complete.length).toBe(2);
    expect(r.dropped).toBe(2);
    const exactlyClosed = SESSION_OPEN_MS + 3 * FIVE_M;
    expect(completeCandlesOnly(c, FIVE_M, exactlyClosed).complete.length).toBe(3);
  });
  test("after the session everything is complete", () => {
    expect(completeCandlesOnly(c, FIVE_M, SESSION_OPEN_MS + 10 * FIVE_M).dropped).toBe(0);
  });

  test("Yahoo's synthetic 'last quote' row (observed live 2026-09-18: off-grid timestamp, volume 0, flat OHLC) is dropped even when the clock would call it closed", () => {
    // Real shape seen: regularMarketTime 1789716132 (07:22:12Z) with a row at exactly that second.
    const offGridStart = SESSION_OPEN_MS + 4 * FIVE_M + 132_000; // 2m12s into the 5th candle
    const withMarker = [...c, { startAt: offGridStart, open: 1243.6, high: 1243.6, low: 1243.6, close: 1243.6, volume: 0 }];
    // Give the clock plenty of time so rule 1 alone would NOT drop the marker …
    const lateClock = SESSION_OPEN_MS + 20 * FIVE_M;
    const r = completeCandlesOnly(withMarker, FIVE_M, lateClock);
    // … and confirm the grid rule still rejects it while all 4 real candles survive.
    expect(r.complete.length).toBe(4);
    expect(r.dropped).toBe(1);
    expect(r.complete.every((x) => x.startAt % FIVE_M === 0)).toBe(true);
  });

  test("15m candles are grid-aligned from the 09:15 IST open (minute 225 of the UTC day)", () => {
    const fifteen = INTRADAY_INTERVAL_MS["15m"];
    expect(SESSION_OPEN_MS % fifteen).toBe(0);
    expect(SESSION_OPEN_MS % FIVE_M).toBe(0);
  });
});

describe("aggregateSession — IST day aggregate + VWAP", () => {
  const two = parseIntradayChartPayload(payload([candles(SESSION_OPEN_MS, 3, 1400), candles(NEXT_SESSION_OPEN_MS, 2, 1500)]), "RELIANCE.NS").candles;
  test("groups by IST calendar date, not UTC", () => {
    expect(istDateOfMs(SESSION_OPEN_MS)).toBe("2026-09-17");
    const d1 = aggregateSession(two, FIVE_M, "2026-09-17")!;
    const d2 = aggregateSession(two, FIVE_M, "2026-09-18")!;
    expect(d1.candleCount).toBe(3);
    expect(d2.candleCount).toBe(2);
    expect(d1.open).toBe(1400);
    expect(d1.close).toBe(1403); // last candle close = 1402 + 1
    expect(d1.high).toBe(1404); // 1402 + 2
    expect(d1.low).toBe(1399); // 1400 − 1
    expect(d1.volume).toBe(1000 + 1001 + 1002);
    expect(d1.lastEndAt).toBe(SESSION_OPEN_MS + 3 * FIVE_M);
  });
  test("VWAP is typical-price × volume weighted; null when no volume; null for a date with no candles", () => {
    const d1 = aggregateSession(two, FIVE_M, "2026-09-17")!;
    // typical prices: (1402+1399+1401)/3=1400.667, (1403+1400+1402)/3=1401.667, (1404+1401+1403)/3=1402.667
    const expected = (1400.6667 * 1000 + 1401.6667 * 1001 + 1402.6667 * 1002) / 3003;
    expect(d1.vwap).toBeCloseTo(expected, 2);
    const zeroVol = two.slice(0, 1).map((c) => ({ ...c, volume: 0 }));
    expect(aggregateSession(zeroVol, FIVE_M, "2026-09-17")!.vwap).toBeNull();
    expect(aggregateSession(two, FIVE_M, "2026-09-19")).toBeNull();
  });
});

describe("seriesToRawQuote — feeds the existing firewall honestly", () => {
  const parsed = parseIntradayChartPayload(payload([candles(SESSION_OPEN_MS, 3)]), "RELIANCE.NS");
  const series = { securityId: "s1", ticker: "RELIANCE.NS", interval: "5m" as const, intervalMs: FIVE_M, candles: parsed.candles, droppedForming: 0, asOf: 0, fetchedAt: 0, source: "fixture" };
  test("price = newest complete close, sourceTimestamp = its END, session OHLCV, previousClose from meta", () => {
    const q = seriesToRawQuote(SEC, series, parsed.meta, 123);
    expect(q.price).toBe(1403);
    expect(q.sourceTimestamp).toBe(SESSION_OPEN_MS + 3 * FIVE_M);
    expect(q.open).toBe(1400);
    expect(q.dayHigh).toBe(1404);
    expect(q.dayLow).toBe(1399);
    expect(q.volume).toBe(3003);
    expect(q.previousClose).toBe(1390);
    expect(q.changePct).toBeCloseTo(((1403 - 1390) / 1390) * 100, 6);
    expect(validateQuote(q, "RELIANCE.NS").quality).toBe("OK");
  });
  test("an empty series yields a price-less quote the firewall labels PARSER_ERROR — not a guessed price", () => {
    const q = seriesToRawQuote(SEC, { ...series, candles: [] }, parsed.meta, 123);
    expect(q.price).toBeNull();
    expect(validateQuote(q, "RELIANCE.NS").quality).toBe("PARSER_ERROR");
  });
});

describe("DELAYED_CANDLES authority ceiling", () => {
  test("caps at WAIT like a scraped snapshot; INTRADAY_CANDLES (real-time) stays reserved and lifts", () => {
    expect(modeAuthorityCeiling("DELAYED_CANDLES")).toBe("WAIT");
    expect(capActionByMode("BUY_CANDIDATE", "DELAYED_CANDLES")).toBe("WAIT");
    expect(capActionByMode("AVOID_NEW_ENTRY", "DELAYED_CANDLES")).toBe("AVOID_NEW_ENTRY");
    expect(modeAuthorityCeiling("INTRADAY_CANDLES")).toBe("BUY_CANDIDATE");
  });
});

describe("DelayedCandlesProvider end-to-end on fixtures", () => {
  test("drops the forming candle using min(clock, vendor regularMarketTime); snapshot is DELAYED_CANDLES and never HEALTHY when stale", async () => {
    const vendorAsOfSec = (SESSION_OPEN_MS + 4 * FIVE_M + 60_000) / 1000; // vendor says: 1 min into candle #5
    const data = payload([candles(SESSION_OPEN_MS, 5)], { regularMarketTime: vendorAsOfSec });
    const ourClock = SESSION_OPEN_MS + 4 * FIVE_M + 20 * 60_000; // we are 20 min later than the vendor's clock
    const p = new DelayedCandlesProvider(fixtureFetcher(data), { now: () => ourClock, retry: { retries: 0, baseDelayMs: 1, maxDelayMs: 1, jitter: false } });

    const { series } = await p.fetchCandles(SEC);
    expect(series.candles.length).toBe(4); // 5th is forming per the VENDOR clock even though our clock has passed its end
    expect(series.droppedForming).toBe(1);
    expect(series.asOf).toBe(vendorAsOfSec * 1000);

    const snap = await p.fetchStock(SEC);
    expect(snap.mode).toBe("DELAYED_CANDLES");
    expect(snap.quality).toBe("OK");
    expect(snap.price).toBe(1404); // candle #4 close = 1403 + 1
    expect(snap.sourceTimestamp).toBe(SESSION_OPEN_MS + 4 * FIVE_M);
    // 20 min old by our clock ⇒ STALE ⇒ DEGRADED ⇒ no new entry. The truth about a delayed feed.
    expect(snap.freshness).toBe("STALE");
    expect(snapshotToDataQuality(snap)).toBe("DEGRADED");
    expect(snap.notes.join(" ")).toMatch(/DELAYED 5m candles/);
    expect(snap.notes.join(" ")).toMatch(/ceiling WAIT/);
    expect(capActionByMode("BUY_CANDIDATE", snap.mode)).toBe("WAIT");
  });

  test("a recently-closed candle is FRESH — but the mode ceiling still forbids BUY", async () => {
    const data = payload([candles(SESSION_OPEN_MS, 3)], { regularMarketTime: (SESSION_OPEN_MS + 3 * FIVE_M + 30_000) / 1000 });
    const clock = SESSION_OPEN_MS + 3 * FIVE_M + 60_000; // newest complete candle closed 1 min ago
    const p = new DelayedCandlesProvider(fixtureFetcher(data), { now: () => clock, retry: { retries: 0, baseDelayMs: 1, maxDelayMs: 1, jitter: false } });
    const snap = await p.fetchStock(SEC);
    expect(snap.freshness).toBe("FRESH");
    expect(snapshotToDataQuality(snap)).toBe("HEALTHY");
    expect(capActionByMode("BUY_CANDIDATE", snap.mode)).toBe("WAIT"); // freshness alone never lifts a delayed feed
  });

  test("vendor failure (e.g. HTTP 429) ⇒ FAILED snapshot, health DISCONNECTED — never a stale price dressed as current", async () => {
    const failing: IntradayCandleFetcher = { name: "fixture", fetch: async () => { throw new Error("Yahoo request failed (HTTP 429)"); } };
    const p = new DelayedCandlesProvider(failing, { now: () => 1, retry: { retries: 0, baseDelayMs: 1, maxDelayMs: 1, jitter: false } });
    const [snap] = await p.fetchUniverse([SEC]);
    expect(snap.quality).toBe("FAILED");
    expect(snap.freshness).toBe("FAILED");
    expect(snap.price).toBeNull();
    expect(snapshotToDataQuality(snap)).toBe("UNAVAILABLE");
    expect(p.health().state).toBe("DISCONNECTED");
  });

  test("per-ticker cache: a second fetch inside the TTL does not hit the vendor; after the TTL it does", async () => {
    let calls = 0;
    const data = payload([candles(SESSION_OPEN_MS, 3)], { regularMarketTime: (SESSION_OPEN_MS + 3 * FIVE_M) / 1000 });
    const counting: IntradayCandleFetcher = { name: "fixture", fetch: async (s) => { calls++; return parseIntradayChartPayload(data, s.ticker); } };
    let clock = SESSION_OPEN_MS + 3 * FIVE_M;
    const p = new DelayedCandlesProvider(counting, { now: () => clock, cacheTtlMs: 60_000, retry: { retries: 0, baseDelayMs: 1, maxDelayMs: 1, jitter: false } });
    await p.fetchStock(SEC);
    await p.fetchStock(SEC);
    expect(calls).toBe(1);
    clock += 61_000;
    await p.fetchStock(SEC);
    expect(calls).toBe(2);
  });

  test("fetchUniverse de-duplicates tickers and returns one snapshot per input in order", async () => {
    const data = payload([candles(SESSION_OPEN_MS, 3)], { regularMarketTime: (SESSION_OPEN_MS + 3 * FIVE_M) / 1000 });
    const p = new DelayedCandlesProvider(fixtureFetcher(data), { now: () => SESSION_OPEN_MS + 3 * FIVE_M, retry: { retries: 0, baseDelayMs: 1, maxDelayMs: 1, jitter: false } });
    const snaps = await p.fetchUniverse([SEC, { securityId: "s1b", ticker: "RELIANCE.NS" }]);
    expect(snaps.length).toBe(2);
    expect(snaps[0]).toBe(snaps[1]);
    expect(p.health().subscribed).toBe(1);
    expect(p.health().state).toBe("CONNECTED");
  });
});
