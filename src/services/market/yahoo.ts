/**
 * Raw Yahoo Finance HTTP client (Module 1).
 *
 * - Chart endpoint: daily bars + quote metadata.
 * - Search endpoint: name -> ticker resolution (filtering to Indian
 *   exchanges happens in MarketDataService).
 * - 10s timeout, 3 retries with exponential backoff on 429/5xx/network errors.
 * - Defensive parsing: Yahoo's timestamp/quote arrays can contain nulls.
 * - Unix timestamps are converted to YYYY-MM-DD in Asia/Kolkata.
 *
 * NEVER fabricates data: if Yahoo returns nothing usable, this module throws.
 */

import axios from "axios";
import { Bar } from "./types";

const BASE_URL = "https://query1.finance.yahoo.com";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3; // retries after the initial attempt
const BASE_BACKOFF_MS = 500; // 500ms -> 1s -> 2s

export type YahooRange =
  | "1d"
  | "5d"
  | "1mo"
  | "3mo"
  | "6mo"
  | "1y"
  | "2y"
  | "5y"
  | "10y"
  | "max";

/** Subset of chart `meta` fields we rely on (all optional — parsed defensively). */
export interface YahooChartMeta {
  currency?: string;
  symbol?: string;
  exchangeName?: string;
  fullExchangeName?: string;
  instrumentType?: string;
  longName?: string;
  shortName?: string;
  regularMarketPrice?: number;
  previousClose?: number;
  chartPreviousClose?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketVolume?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  regularMarketTime?: number; // unix seconds
  marketState?: string;
}

export interface YahooCorporateEvents {
  /** ex-date (YYYY-MM-DD IST) → split factor (e.g. 5 for a 1:5 split where numerator/denominator = 5/1). */
  splits: Record<string, number>;
  /** ex-date → dividend amount (₹ per share). */
  dividends: Record<string, number>;
}

export interface YahooChartResult {
  bars: Bar[];
  meta: YahooChartMeta;
  /** Phase 1: corporate-action events from Yahoo (empty maps when none). */
  events: YahooCorporateEvents;
}

export interface YahooSearchQuote {
  symbol: string;
  shortname?: string;
  longname?: string;
  exchange?: string; // "NSI" for NSE, "BSE" for Bombay
  exchDisp?: string;
  quoteType?: string;
}

const IST_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Convert unix seconds to a YYYY-MM-DD string in Asia/Kolkata. */
export function unixToISTDateString(unixSeconds: number): string {
  return IST_DATE_FORMATTER.format(new Date(unixSeconds * 1000));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  const status = err.response?.status;
  if (status === 429) return true;
  if (status !== undefined && status >= 500) return true;
  // No HTTP response at all: timeout / connection reset / DNS — worth retrying.
  if (err.response === undefined) return true;
  return false;
}

/** GET JSON with proper headers, timeout, and 3x exponential-backoff retry. */
async function getJson<T>(url: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }
    try {
      const response = await axios.get<T>(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
        timeout: REQUEST_TIMEOUT_MS,
      });
      return response.data;
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === MAX_RETRIES) {
        break;
      }
    }
  }
  if (axios.isAxiosError(lastError)) {
    const status = lastError.response?.status;
    throw new Error(
      `Yahoo request failed${status ? ` (HTTP ${status})` : ""}: ${lastError.message} [${url}]`
    );
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Yahoo request failed: ${String(lastError)} [${url}]`);
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Fetch daily bars + quote meta from the chart endpoint.
 * Null entries in the timestamp/OHLC arrays are skipped (Yahoo emits them
 * for holidays/suspensions). Bars are deduped by IST date and sorted ASC.
 */
export async function fetchChart(
  ticker: string,
  range: YahooRange,
  interval: "1d" = "1d"
): Promise<YahooChartResult> {
  // Phase 1: request split/dividend events and the adjusted-close series so
  // analytics can compute corporate-action-safe returns.
  const url = `${BASE_URL}/v8/finance/chart/${encodeURIComponent(
    ticker
  )}?range=${range}&interval=${interval}&events=div%2Csplit`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await getJson<any>(url);

  const chart = data?.chart;
  if (chart?.error) {
    const desc = chart.error.description || chart.error.code || "unknown error";
    throw new Error(`Yahoo chart error for ${ticker}: ${desc}`);
  }
  const result = chart?.result?.[0];
  if (!result || !result.meta) {
    throw new Error(`Yahoo chart returned no result for ${ticker}`);
  }

  const meta: YahooChartMeta = result.meta;
  const timestamps: unknown[] = Array.isArray(result.timestamp)
    ? result.timestamp
    : [];
  const quote = result.indicators?.quote?.[0] ?? {};
  const adj = result.indicators?.adjclose?.[0]?.adjclose;
  const adjcloses: unknown[] = Array.isArray(adj) ? adj : [];
  const opens: unknown[] = Array.isArray(quote.open) ? quote.open : [];
  const highs: unknown[] = Array.isArray(quote.high) ? quote.high : [];
  const lows: unknown[] = Array.isArray(quote.low) ? quote.low : [];
  const closes: unknown[] = Array.isArray(quote.close) ? quote.close : [];
  const volumes: unknown[] = Array.isArray(quote.volume) ? quote.volume : [];

  const barsByDate = new Map<string, Bar>();
  for (let i = 0; i < timestamps.length; i++) {
    const ts = toFiniteNumber(timestamps[i]);
    if (ts === null) continue;
    const open = toFiniteNumber(opens[i]);
    const high = toFiniteNumber(highs[i]);
    const low = toFiniteNumber(lows[i]);
    const close = toFiniteNumber(closes[i]);
    if (open === null || high === null || low === null || close === null) {
      continue; // skip null/partial bars — never invent values
    }
    // Indices (e.g. ^NSEI) report null/0 volume; treat missing volume as 0.
    const volume = toFiniteNumber(volumes[i]) ?? 0;
    const adjustedClose = toFiniteNumber(adjcloses[i]); // null when Yahoo omits it
    const date = unixToISTDateString(ts);
    barsByDate.set(date, { date, open, high, low, close, volume, adjustedClose });
  }

  const bars = Array.from(barsByDate.values()).sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );

  // Corporate-action events (ex-dates in IST). Absent sections ⇒ empty maps.
  const events: YahooCorporateEvents = { splits: {}, dividends: {} };
  const evSplits = result.events?.splits ?? {};
  for (const key of Object.keys(evSplits)) {
    const e = evSplits[key];
    const ts = toFiniteNumber(e?.date);
    const num = toFiniteNumber(e?.numerator);
    const den = toFiniteNumber(e?.denominator);
    if (ts !== null && num !== null && den !== null && den > 0) {
      events.splits[unixToISTDateString(ts)] = num / den;
    }
  }
  const evDivs = result.events?.dividends ?? {};
  for (const key of Object.keys(evDivs)) {
    const e = evDivs[key];
    const ts = toFiniteNumber(e?.date);
    const amount = toFiniteNumber(e?.amount);
    if (ts !== null && amount !== null && amount > 0) {
      events.dividends[unixToISTDateString(ts)] = amount;
    }
  }

  return { bars, meta, events };
}

// ── Intraday candles (docs/intraday-study-notes.md §4 item 6) ────────────────

export type YahooIntradayInterval = "5m" | "15m";
export type YahooIntradayRange = "1d" | "5d";

export const INTRADAY_INTERVAL_MS: Record<YahooIntradayInterval, number> = { "5m": 5 * 60_000, "15m": 15 * 60_000 };

/** One intraday OHLCV candle. `startAt` is the candle's opening ms epoch. */
export interface IntradayCandle {
  startAt: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface YahooIntradayChartResult {
  candles: IntradayCandle[];
  meta: YahooChartMeta & { dataGranularity?: string };
}

/**
 * PURE parser for a Yahoo v8 chart payload at an intraday interval — exported
 * so tests can feed fixture JSON without the network. Candles with any null
 * OHLC field are skipped (never invented); duplicates by startAt are collapsed
 * (latest wins); output is sorted ascending. The FORMING candle is NOT removed
 * here — that needs a clock, see realtime/intradayCandlesProvider.ts.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseIntradayChartPayload(data: any, ticker: string): YahooIntradayChartResult {
  const chart = data?.chart;
  if (chart?.error) {
    const desc = chart.error.description || chart.error.code || "unknown error";
    throw new Error(`Yahoo intraday chart error for ${ticker}: ${desc}`);
  }
  const result = chart?.result?.[0];
  if (!result || !result.meta) throw new Error(`Yahoo intraday chart returned no result for ${ticker}`);

  const timestamps: unknown[] = Array.isArray(result.timestamp) ? result.timestamp : [];
  const quote = result.indicators?.quote?.[0] ?? {};
  const opens: unknown[] = Array.isArray(quote.open) ? quote.open : [];
  const highs: unknown[] = Array.isArray(quote.high) ? quote.high : [];
  const lows: unknown[] = Array.isArray(quote.low) ? quote.low : [];
  const closes: unknown[] = Array.isArray(quote.close) ? quote.close : [];
  const volumes: unknown[] = Array.isArray(quote.volume) ? quote.volume : [];

  const byStart = new Map<number, IntradayCandle>();
  for (let i = 0; i < timestamps.length; i++) {
    const ts = toFiniteNumber(timestamps[i]);
    if (ts === null) continue;
    const open = toFiniteNumber(opens[i]);
    const high = toFiniteNumber(highs[i]);
    const low = toFiniteNumber(lows[i]);
    const close = toFiniteNumber(closes[i]);
    if (open === null || high === null || low === null || close === null) continue;
    const volume = toFiniteNumber(volumes[i]) ?? 0;
    byStart.set(ts * 1000, { startAt: ts * 1000, open, high, low, close, volume });
  }
  const candles = Array.from(byStart.values()).sort((a, b) => a.startAt - b.startAt);
  return { candles, meta: result.meta };
}

/**
 * Fetch intraday candles from the chart endpoint. Yahoo's NSE intraday data is
 * DELAYED and this function does nothing to hide that: callers must treat the
 * result as DELAYED_CANDLES (see realtime/marketDataProvider.ts). 1-minute
 * bars are deliberately not offered — Varsity reserves them for seasoned
 * scalpers, and the free feed's delay makes them noise anyway.
 */
export async function fetchIntradayChart(
  ticker: string,
  interval: YahooIntradayInterval = "5m",
  range: YahooIntradayRange = "5d"
): Promise<YahooIntradayChartResult> {
  const url = `${BASE_URL}/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=${interval}&includePrePost=false`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await getJson<any>(url);
  return parseIntradayChartPayload(data, ticker);
}

/** Raw Yahoo search (no filtering here — caller filters to Indian exchanges). */
export async function fetchSearch(query: string): Promise<YahooSearchQuote[]> {
  const url = `${BASE_URL}/v1/finance/search?q=${encodeURIComponent(
    query
  )}&quotesCount=15&newsCount=0`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await getJson<any>(url);
  const quotes: unknown[] = Array.isArray(data?.quotes) ? data.quotes : [];
  return quotes.filter(
    (q): q is YahooSearchQuote =>
      !!q && typeof (q as YahooSearchQuote).symbol === "string"
  );
}
