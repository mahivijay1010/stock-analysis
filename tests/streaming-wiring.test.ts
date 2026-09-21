/**
 * Wiring the Upstox stream into the engine: instrument resolution
 * (Yahoo ticker → Upstox instrument key) and the push→pull bridge that lets
 * the snapshot-based orchestrator consume a tick feed.
 *
 * The honesty properties under test are the ones that matter for money:
 * a subscribed-but-silent security must never present a last known price as
 * current, and a mid-session join must not pass our first observed price off
 * as the session open.
 */

import { gzipSync } from "zlib";
import {
  NSE_EQ_SEGMENT,
  parseInstruments,
  resolveTickers,
  toTradingSymbol,
  UpstoxInstrumentService,
} from "../src/services/realtime/upstoxInstruments";
import {
  istSessionOpenMs,
  StreamingMarketProvider,
} from "../src/services/realtime/streamingMarketProvider";
import { MarketTick, ProviderHealth, RealtimeMarketProvider } from "../src/services/realtime/types";
import { capActionByMode, modeAuthorityCeiling, snapshotToDataQuality, Security } from "../src/services/realtime/marketDataProvider";

// ── instrument master fixtures (real shape, from the live file) ──────────────

const ROWS = [
  { segment: "NSE_EQ", instrument_type: "EQ", trading_symbol: "RELIANCE", instrument_key: "NSE_EQ|INE002A01018", name: "RELIANCE INDUSTRIES LTD", isin: "INE002A01018", exchange_token: "2885", lot_size: 1, tick_size: 10.0 },
  { segment: "NSE_EQ", instrument_type: "EQ", trading_symbol: "TCS", instrument_key: "NSE_EQ|INE467B01029", name: "TATA CONSULTANCY SERV LT", isin: "INE467B01029", exchange_token: "11536", lot_size: 1, tick_size: 5.0 },
  // Must be ignored: a derivative sharing the symbol, and another segment.
  { segment: "NSE_FO", instrument_type: "FUT", trading_symbol: "RELIANCE", instrument_key: "NSE_FO|45450", name: "RELIANCE FUT", isin: "", exchange_token: "45450" },
  { segment: "NSE_INDEX", instrument_type: "INDEX", trading_symbol: "NIFTY 50", instrument_key: "NSE_INDEX|Nifty 50", name: "NIFTY 50", isin: "" },
];

describe("instrument resolution", () => {
  test("toTradingSymbol strips the Yahoo exchange suffix", () => {
    expect(toTradingSymbol("RELIANCE.NS")).toBe("RELIANCE");
    expect(toTradingSymbol("reliance.ns")).toBe("RELIANCE");
    expect(toTradingSymbol("TATASTEEL.BO")).toBe("TATASTEEL");
    expect(toTradingSymbol("INFY")).toBe("INFY");
  });

  test("only NSE_EQ cash equities are kept — a same-symbol future is never mapped", () => {
    const m = parseInstruments(ROWS);
    expect(m.size).toBe(2);
    expect(m.get("RELIANCE")!.instrumentKey).toBe("NSE_EQ|INE002A01018"); // not NSE_FO|45450
    expect(m.has("NIFTY 50")).toBe(false);
    expect(NSE_EQ_SEGMENT).toBe("NSE_EQ");
  });

  test("a master with no usable equities throws rather than yielding an empty map", () => {
    expect(() => parseInstruments([ROWS[2]])).toThrow(/no NSE_EQ equities/);
    expect(() => parseInstruments({} as unknown)).toThrow(/not an array/);
  });

  test("unresolved tickers are REPORTED, never silently dropped", () => {
    const r = resolveTickers(["RELIANCE.NS", "TCS.NS", "DELISTEDCO.NS"], parseInstruments(ROWS), 123);
    expect(r.byTicker.get("RELIANCE.NS")).toBe("NSE_EQ|INE002A01018");
    expect(r.byTicker.size).toBe(2);
    expect(r.unresolved).toEqual(["DELISTEDCO.NS"]);
    expect(r.byInstrumentKey.get("NSE_EQ|INE002A01018")!.tradingSymbol).toBe("RELIANCE");
  });

  test("the service decompresses .json.gz, and caches within the TTL", async () => {
    let calls = 0;
    let clock = 1_000_000;
    const svc = new UpstoxInstrumentService(
      async () => { calls++; return gzipSync(Buffer.from(JSON.stringify(ROWS))); },
      () => clock,
      60_000
    );
    const a = await svc.resolve(["RELIANCE.NS"]);
    expect(a.byTicker.size).toBe(1);
    await svc.resolve(["TCS.NS"]);
    expect(calls).toBe(1); // served from cache
    clock += 61_000;
    await svc.resolve(["TCS.NS"]);
    expect(calls).toBe(2); // TTL expired ⇒ refetched
  });

  test("an already-decompressed body is tolerated (no magic-byte assumption)", async () => {
    const svc = new UpstoxInstrumentService(async () => Buffer.from(JSON.stringify(ROWS)), () => 0);
    expect((await svc.resolve(["TCS.NS"])).byTicker.get("TCS.NS")).toBe("NSE_EQ|INE467B01029");
  });
});

// ── push → pull bridge ───────────────────────────────────────────────────────

const KEY = "NSE_EQ|INE002A01018";
const SEC: Security = { securityId: KEY, ticker: "RELIANCE.NS" };
/** 2026-09-18 10:00 IST, comfortably inside the session. */
const T0 = Date.UTC(2026, 8, 18, 4, 30);

class FakeStream implements RealtimeMarketProvider {
  connected = false;
  subscribedKeys: string[] = [];
  private cb: ((t: MarketTick) => void) | null = null;
  async connect(): Promise<void> { this.connected = true; }
  async disconnect(): Promise<void> { this.connected = false; }
  async subscribe(ids: string[]): Promise<void> { this.subscribedKeys.push(...ids); }
  onTick(cb: (t: MarketTick) => void): void { this.cb = cb; }
  onError(): void { /* unused */ }
  health(): ProviderHealth { return { state: this.connected ? "CONNECTED" : "DISCONNECTED", lastTickAt: null, subscribed: this.subscribedKeys.length }; }
  push(t: MarketTick): void { this.cb?.(t); }
}

function tick(over: Partial<MarketTick> = {}): MarketTick {
  return { securityId: KEY, exchangeTimestamp: T0, receivedAt: T0, price: 1243.6, quantity: 10, ...over };
}

function makeBridge(now: () => number = () => T0) {
  const stream = new FakeStream();
  const provider = new StreamingMarketProvider(stream, { now });
  return { stream, provider };
}

describe("StreamingMarketProvider — push feed behind the pull interface", () => {
  test("declares STREAMING, the only mode that earns a BUY ceiling", () => {
    const { provider } = makeBridge();
    expect(provider.mode).toBe("STREAMING");
    expect(modeAuthorityCeiling(provider.mode)).toBe("BUY_CANDIDATE");
    expect(capActionByMode("BUY_CANDIDATE", provider.mode)).toBe("BUY_CANDIDATE");
  });

  test("start() connects and subscribes to the mapped instrument keys, idempotently", async () => {
    const { stream, provider } = makeBridge();
    const mapping = new Map([["RELIANCE.NS", KEY]]);
    await provider.start(mapping);
    await provider.start(mapping);
    expect(stream.connected).toBe(true);
    expect(stream.subscribedKeys).toEqual([KEY]); // not duplicated
    expect(provider.stats().started).toBe(true);
  });

  test("a security that has NEVER ticked is FAILED — not a fabricated price", async () => {
    const { provider } = makeBridge();
    await provider.start(new Map([["RELIANCE.NS", KEY]]));
    const snap = await provider.fetchStock(SEC);
    expect(snap.price).toBeNull();
    expect(snap.quality).toBe("FAILED");
    expect(snapshotToDataQuality(snap)).toBe("UNAVAILABLE");
    expect(snap.notes.join(" ")).toMatch(/no tick has ever been received/);
  });

  test("ticks accumulate into price/high/low/volume and a FRESH snapshot", async () => {
    const { stream, provider } = makeBridge();
    await provider.start(new Map([["RELIANCE.NS", KEY]]));
    stream.push(tick({ price: 1240, quantity: 5 }));
    stream.push(tick({ price: 1250, exchangeTimestamp: T0 + 1000, receivedAt: T0 + 1000, quantity: 7 }));
    stream.push(tick({ price: 1245, exchangeTimestamp: T0 + 2000, receivedAt: T0 + 2000, quantity: 3 }));

    const snap = await provider.fetchStock(SEC);
    expect(snap.price).toBe(1245);
    expect(snap.dayHigh).toBe(1250);
    expect(snap.dayLow).toBe(1240);
    expect(snap.volume).toBe(15);
    expect(snap.freshness).toBe("FRESH");
    expect(snapshotToDataQuality(snap)).toBe("HEALTHY");
    expect(snap.ticker).toBe("RELIANCE.NS"); // attributed back to the universe name
  });

  test("a silent security goes STALE — silence on a socket is treated as a dead feed", async () => {
    let clock = T0;
    const { stream, provider } = makeBridge(() => clock);
    await provider.start(new Map([["RELIANCE.NS", KEY]]));
    stream.push(tick());
    expect((await provider.fetchStock(SEC)).freshness).toBe("FRESH");
    clock = T0 + 120_000; // 2 minutes of silence
    const stale = await provider.fetchStock(SEC);
    expect(stale.freshness).toBe("STALE");
    expect(snapshotToDataQuality(stale)).toBe("DEGRADED"); // ⇒ no new entry
    expect(stale.notes.join(" ")).toMatch(/no tick for 120s/);
  });

  test("change % is withheld without an exchange previous close, then computed once supplied", async () => {
    const { stream, provider } = makeBridge();
    await provider.start(new Map([["RELIANCE.NS", KEY]]));
    stream.push(tick({ price: 1250 }));
    let snap = await provider.fetchStock(SEC);
    expect(snap.changePct).toBeNull();
    expect(snap.notes.join(" ")).toMatch(/change % withheld/);

    provider.setPreviousClose(KEY, 1200);
    snap = await provider.fetchStock(SEC);
    expect(snap.changePct).toBeCloseTo(((1250 - 1200) / 1200) * 100, 6);
  });

  test("joining mid-session is disclosed rather than passing our first tick off as the open", async () => {
    // Session opens 09:15 IST; first tick at 11:00 IST.
    const late = Date.UTC(2026, 8, 18, 5, 30);
    const { stream, provider } = makeBridge(() => late);
    await provider.start(new Map([["RELIANCE.NS", KEY]]));
    stream.push(tick({ exchangeTimestamp: late, receivedAt: late, price: 1300 }));
    const snap = await provider.fetchStock(SEC);
    expect(snap.open).toBe(1300);
    expect(snap.notes.join(" ")).toMatch(/NOT the exchange session values/);
  });

  test("invalid ticks are rejected by the validator and surfaced in health", async () => {
    const { stream, provider } = makeBridge();
    await provider.start(new Map([["RELIANCE.NS", KEY]]));
    stream.push(tick({ price: Number.NaN }));
    stream.push(tick({ securityId: "" }));
    expect(provider.stats().rejected).toBe(2);
    expect(provider.stats().accepted).toBe(0);
    expect(provider.health().reason).toMatch(/2 ticks rejected/);
    expect((await provider.fetchStock(SEC)).quality).toBe("FAILED"); // nothing valid ever arrived
  });

  test("ticks build 1-minute bars the feature engine can consume", async () => {
    const { stream, provider } = makeBridge();
    await provider.start(new Map([["RELIANCE.NS", KEY]]));
    stream.push(tick({ exchangeTimestamp: T0, receivedAt: T0, price: 100 }));
    stream.push(tick({ exchangeTimestamp: T0 + 30_000, receivedAt: T0 + 30_000, price: 110 }));
    // Crossing the minute boundary closes the first bar.
    stream.push(tick({ exchangeTimestamp: T0 + 61_000, receivedAt: T0 + 61_000, price: 105 }));
    const bars = provider.barsFor(KEY);
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({ open: 100, high: 110, low: 100, close: 110, complete: true });
  });

  test("fetchUniverse returns one snapshot per requested security, in order", async () => {
    const { stream, provider } = makeBridge();
    const other: Security = { securityId: "NSE_EQ|INE467B01029", ticker: "TCS.NS" };
    await provider.start(new Map([["RELIANCE.NS", KEY], ["TCS.NS", other.securityId]]));
    stream.push(tick());
    const snaps = await provider.fetchUniverse([SEC, other]);
    expect(snaps.map((s) => s.ticker)).toEqual(["RELIANCE.NS", "TCS.NS"]);
    expect(snaps[0].quality).toBe("OK");
    expect(snaps[1].quality).toBe("FAILED"); // never ticked — honestly unavailable
  });
});

describe("istSessionOpenMs", () => {
  test("resolves to 09:15 IST of the IST day containing the instant", () => {
    const open = istSessionOpenMs(Date.UTC(2026, 8, 18, 6, 0)); // 11:30 IST
    expect(new Date(open).toISOString()).toBe("2026-09-18T03:45:00.000Z"); // 09:15 IST
  });

  test("an instant just after IST midnight still maps to that IST day's open", () => {
    const justAfterIstMidnight = Date.UTC(2026, 8, 17, 19, 0); // 00:30 IST on the 18th
    expect(new Date(istSessionOpenMs(justAfterIstMidnight)).toISOString()).toBe("2026-09-18T03:45:00.000Z");
  });
});

/**
 * Rejection reasons must be attributable (docs/live-feed-runbook.md,
 * 2026-09-21 session).
 *
 * The first open-market session ran a steady ~19% rejection rate, which read
 * as a protocol fault against the pre-registered criterion. It was actually
 * Upstox re-sending unchanged LTP snapshots — correct DUPLICATE rejections.
 * Diagnosing that needed source reading and an offline validator replay,
 * because ingest() discarded the verdict. These tests pin the distinction so
 * a real fault can never again hide behind a benign duplicate count.
 */
describe("StreamingMarketProvider — rejections are attributable by reason", () => {
  test("a re-sent unchanged snapshot counts as DUPLICATE, not an unexplained rejection", async () => {
    const { stream, provider } = makeBridge();
    await provider.start(new Map([["RELIANCE.NS", KEY]]));

    stream.push(tick());
    stream.push(tick()); // byte-identical re-send
    stream.push(tick());

    const stats = provider.stats();
    expect(stats.accepted).toBe(1);
    expect(stats.rejected).toBe(2);
    expect(stats.rejectedByReason).toEqual({ DUPLICATE: 2 });
  });

  test("a stale tick is counted separately from a duplicate — they mean different things", async () => {
    const { stream, provider } = makeBridge();
    await provider.start(new Map([["RELIANCE.NS", KEY]]));

    stream.push(tick());
    // Pre-open snapshot shape: exchange timestamp far older than receivedAt.
    stream.push(tick({ exchangeTimestamp: T0 - 3 * 24 * 3600_000, price: 1200, quantity: 7 }));

    const stats = provider.stats();
    expect(stats.rejectedByReason.STALE).toBe(1);
    expect(stats.rejectedByReason.DUPLICATE).toBeUndefined();
  });

  test("health() names the reasons, so a duplicate rate cannot read as a fault", async () => {
    const { stream, provider } = makeBridge();
    await provider.start(new Map([["RELIANCE.NS", KEY]]));
    stream.push(tick());
    stream.push(tick());

    const reason = provider.health().reason ?? "";
    expect(reason).toMatch(/1 ticks rejected/);
    expect(reason).toMatch(/DUPLICATE 1/);
  });
});
