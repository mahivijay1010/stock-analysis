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

export interface YahooChartResult {
  bars: Bar[];
  meta: YahooChartMeta;
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
  const url = `${BASE_URL}/v8/finance/chart/${encodeURIComponent(
    ticker
  )}?range=${range}&interval=${interval}`;
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
    const date = unixToISTDateString(ts);
    barsByDate.set(date, { date, open, high, low, close, volume });
  }

  const bars = Array.from(barsByDate.values()).sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );
  return { bars, meta };
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
