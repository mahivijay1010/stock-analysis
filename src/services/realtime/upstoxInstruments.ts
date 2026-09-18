/**
 * Upstox instrument resolver — maps this codebase's Yahoo-style tickers
 * ("RELIANCE.NS") to Upstox instrument keys ("NSE_EQ|INE002A01018").
 *
 * Without this the stream provider cannot be pointed at the universe at all:
 * nseUniverse.ts speaks Yahoo, the Upstox feed speaks instrument keys, and
 * nothing bridged them.
 *
 * Source: https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz
 * — keyless, ~2 MB gzipped (~37 MB raw, ~80k rows), refreshed daily around
 * 06:00 IST. Only NSE_EQ/EQ rows are kept (~2.6k), so the retained map is small.
 *
 * Honesty rules:
 *  - A ticker that does not resolve is REPORTED, never silently dropped: a
 *    partially-subscribed universe that looks complete is exactly the
 *    "silent partial universe" failure the orchestrator already guards against.
 *  - The cache is time-boxed (the vendor refreshes daily); a stale map would
 *    quietly mis-key a renamed symbol.
 *  - Fetching is injectable so the parsing/mapping contract is unit-tested
 *    against fixtures with no network.
 */

import { gunzipSync } from "zlib";

export const UPSTOX_NSE_INSTRUMENTS_URL = "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz";
export const NSE_EQ_SEGMENT = "NSE_EQ";
/** The vendor refreshes daily ~06:00 IST; re-read at most once every 12h. */
export const INSTRUMENT_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/** The subset of instrument-master fields this system relies on. */
export interface UpstoxInstrument {
  instrumentKey: string;
  tradingSymbol: string;
  name: string;
  isin: string;
  exchangeToken: string;
  lotSize: number | null;
  tickSize: number | null;
}

export interface InstrumentResolution {
  /** ticker (as given, e.g. "RELIANCE.NS") → instrument key. */
  byTicker: Map<string, string>;
  /** Tickers with no NSE_EQ match — surfaced, never hidden. */
  unresolved: string[];
  /** Instruments keyed by instrument key, for reverse lookup on a tick. */
  byInstrumentKey: Map<string, UpstoxInstrument>;
  fetchedAt: number;
}

/** "RELIANCE.NS" → "RELIANCE". Upstox trading symbols carry no exchange suffix. */
export function toTradingSymbol(ticker: string): string {
  return ticker.replace(/\.(NS|BO)$/i, "").toUpperCase().trim();
}

/**
 * PURE: parse the instrument-master JSON into the NSE cash-equity map.
 * Rows that are not NSE_EQ cash equities (futures, options, indices, ETFs
 * flagged otherwise) are ignored — subscribing to a derivative because it
 * shares a symbol prefix would be a silent, dangerous mis-key.
 */
export function parseInstruments(rows: unknown): Map<string, UpstoxInstrument> {
  if (!Array.isArray(rows)) throw new Error("Upstox instrument master is not an array");
  const bySymbol = new Map<string, UpstoxInstrument>();
  for (const raw of rows) {
    const r = raw as Record<string, unknown>;
    if (r.segment !== NSE_EQ_SEGMENT || r.instrument_type !== "EQ") continue;
    const instrumentKey = typeof r.instrument_key === "string" ? r.instrument_key : null;
    const tradingSymbol = typeof r.trading_symbol === "string" ? r.trading_symbol.toUpperCase().trim() : null;
    if (!instrumentKey || !tradingSymbol) continue;
    bySymbol.set(tradingSymbol, {
      instrumentKey,
      tradingSymbol,
      name: typeof r.name === "string" ? r.name : "",
      isin: typeof r.isin === "string" ? r.isin : "",
      exchangeToken: typeof r.exchange_token === "string" ? r.exchange_token : "",
      lotSize: typeof r.lot_size === "number" ? r.lot_size : null,
      tickSize: typeof r.tick_size === "number" ? r.tick_size : null,
    });
  }
  if (bySymbol.size === 0) throw new Error("Upstox instrument master contained no NSE_EQ equities — refusing a useless map");
  return bySymbol;
}

/** PURE: resolve tickers against an already-parsed symbol map. */
export function resolveTickers(tickers: string[], bySymbol: Map<string, UpstoxInstrument>, fetchedAt: number): InstrumentResolution {
  const byTicker = new Map<string, string>();
  const byInstrumentKey = new Map<string, UpstoxInstrument>();
  const unresolved: string[] = [];
  for (const ticker of tickers) {
    const inst = bySymbol.get(toTradingSymbol(ticker));
    if (!inst) {
      unresolved.push(ticker);
      continue;
    }
    byTicker.set(ticker, inst.instrumentKey);
    byInstrumentKey.set(inst.instrumentKey, inst);
  }
  return { byTicker, unresolved, byInstrumentKey, fetchedAt };
}

export type InstrumentFetcher = () => Promise<Buffer>;

const httpFetcher: InstrumentFetcher = async () => {
  const axios = (await import("axios")).default;
  const res = await axios.get<ArrayBuffer>(UPSTOX_NSE_INSTRUMENTS_URL, { responseType: "arraybuffer", timeout: 60_000 });
  return Buffer.from(res.data);
};

/**
 * Loads (and caches) the instrument master. The gzip body is decompressed
 * here so callers never deal with transport details.
 */
export class UpstoxInstrumentService {
  private cache: { bySymbol: Map<string, UpstoxInstrument>; fetchedAt: number } | null = null;

  constructor(
    private readonly fetcher: InstrumentFetcher = httpFetcher,
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = INSTRUMENT_CACHE_TTL_MS
  ) {}

  async load(force = false): Promise<Map<string, UpstoxInstrument>> {
    const now = this.now();
    if (!force && this.cache && now - this.cache.fetchedAt < this.ttlMs) return this.cache.bySymbol;
    const body = await this.fetcher();
    // The vendor serves .json.gz; tolerate an already-decompressed body too.
    const text = body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body).toString("utf8") : body.toString("utf8");
    const bySymbol = parseInstruments(JSON.parse(text));
    this.cache = { bySymbol, fetchedAt: now };
    return bySymbol;
  }

  async resolve(tickers: string[], force = false): Promise<InstrumentResolution> {
    const bySymbol = await this.load(force);
    return resolveTickers(tickers, bySymbol, this.cache?.fetchedAt ?? this.now());
  }
}

export const upstoxInstrumentService = new UpstoxInstrumentService();
