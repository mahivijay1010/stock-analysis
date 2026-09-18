/**
 * DelayedCandlesProvider — item 6 of docs/intraday-study-notes.md §4: the first
 * intraday data path, built on Yahoo's free, keyless, DELAYED 5m/15m chart
 * feed. It exists to make three things possible without pretending to be a
 * live feed: 15-minute context (Varsity: "at best 15 mins charts" for a
 * 1–2-trades-a-day trader), session VWAP, and — later — slippage MEASUREMENT
 * against actual intraday fills, which is the one thing that can calibrate
 * costs.ts's invented slippage constants.
 *
 * Honesty contract:
 *  - mode is DELAYED_CANDLES, whose authority ceiling is WAIT
 *    (marketDataProvider.modeAuthorityCeiling). Nothing produced here can lift
 *    a decision to BUY_CANDIDATE. INTRADAY_CANDLES is reserved for a genuine
 *    real-time feed a broker would provide.
 *  - The forming candle is dropped by the clock (`completeCandlesOnly`), the
 *    intraday twin of MarketDataService.dropPartialTodayBar. `asOf` is the
 *    EARLIER of our clock and the vendor's own regularMarketTime, so a candle
 *    the vendor has not finished publishing is never treated as closed.
 *  - The snapshot's sourceTimestamp is the newest COMPLETE candle's end — the
 *    last instant we know the price was true. Freshness is judged from that by
 *    the existing firewall (snapshotValidation.classifyFreshness); with a
 *    ~15-minute vendor delay it will usually read STALE, which is the truth.
 *  - Every snapshot goes through the SAME validation firewall as scraped
 *    quotes (buildScrapedSnapshot); only the mode label differs.
 *  - Fetching is injectable, so the parse/aggregate/freshness contract is
 *    unit-tested against fixture payloads with no network.
 */

import {
  MarketDataProvider,
  MarketDataMode,
  MarketSnapshot,
  RawPriceQuote,
  Security,
} from "./marketDataProvider";
import { buildScrapedSnapshot, BuildSnapshotOptions } from "./snapshotValidation";
import { mapWithConcurrency, withRetry, withTimeout, RetryOptions, Scheduler } from "./asyncUtils";
import { ProviderHealth } from "./types";
import {
  fetchIntradayChart,
  IntradayCandle,
  INTRADAY_INTERVAL_MS,
  unixToISTDateString,
  YahooIntradayChartResult,
  YahooIntradayInterval,
  YahooIntradayRange,
} from "../market/yahoo";

export type { IntradayCandle } from "../market/yahoo";

/** Vendor-agnostic candle fetcher; the Yahoo one is the default, tests inject fixtures. */
export interface IntradayCandleFetcher {
  name: string;
  fetch(security: Security, interval: YahooIntradayInterval, range: YahooIntradayRange): Promise<YahooIntradayChartResult>;
}

export const yahooIntradayFetcher: IntradayCandleFetcher = {
  name: "yahoo-intraday (free, delayed)",
  fetch: (s, interval, range) => fetchIntradayChart(s.ticker, interval, range),
};

/** A validated, complete-only candle series for one security. */
export interface IntradayCandleSeries {
  securityId: string;
  ticker: string;
  interval: YahooIntradayInterval;
  intervalMs: number;
  /** COMPLETE candles only, ascending. */
  candles: IntradayCandle[];
  /** How many trailing candles were dropped as still forming at `asOf`. */
  droppedForming: number;
  /** min(our clock, vendor regularMarketTime) — the instant the series is valid as of. */
  asOf: number;
  fetchedAt: number;
  source: string;
}

/** IST calendar date (YYYY-MM-DD) of a ms epoch. */
export function istDateOfMs(ms: number): string {
  return unixToISTDateString(ms / 1000);
}

/**
 * Drop every candle that has not fully closed by `asOf`, AND every row that is
 * not a real candle. PURE. Two rules:
 *  1. complete iff startAt + intervalMs <= asOf;
 *  2. startAt must sit on the interval grid. Observed live (2026-09-18,
 *     RELIANCE.NS 5m): Yahoo appends a synthetic "last quote" row whose
 *     timestamp is regularMarketTime (e.g. 07:22:12Z — not a 5-minute
 *     boundary), volume 0, OHLC all equal to the last trade. It is a price
 *     marker, not a candle; rule 1 happens to catch it only because its start
 *     equals asOf, so rule 2 makes the rejection explicit instead of lucky.
 *     NSE's 09:15 IST open is 03:45Z = minute 225, divisible by both 5 and 15,
 *     so genuine 5m/15m candles are always grid-aligned.
 */
export function completeCandlesOnly(candles: IntradayCandle[], intervalMs: number, asOf: number): { complete: IntradayCandle[]; dropped: number } {
  const complete = candles.filter((c) => c.startAt % intervalMs === 0 && c.startAt + intervalMs <= asOf);
  return { complete, dropped: candles.length - complete.length };
}

export interface SessionAggregate {
  istDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Volume-weighted average price over the session's complete candles (typical price × volume); null when no volume. */
  vwap: number | null;
  candleCount: number;
  firstStartAt: number;
  lastEndAt: number;
}

/**
 * Aggregate the complete candles of ONE IST session. PURE. Returns null when
 * no candle falls on that date — never a fabricated session.
 */
export function aggregateSession(candles: IntradayCandle[], intervalMs: number, istDate: string): SessionAggregate | null {
  const day = candles.filter((c) => istDateOfMs(c.startAt) === istDate);
  if (day.length === 0) return null;
  let high = -Infinity;
  let low = Infinity;
  let volume = 0;
  let pv = 0;
  for (const c of day) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
    volume += c.volume;
    pv += ((c.high + c.low + c.close) / 3) * c.volume;
  }
  return {
    istDate,
    open: day[0].open,
    high,
    low,
    close: day[day.length - 1].close,
    volume,
    vwap: volume > 0 ? pv / volume : null,
    candleCount: day.length,
    firstStartAt: day[0].startAt,
    lastEndAt: day[day.length - 1].startAt + intervalMs,
  };
}

/**
 * Map a complete-only series to the firewall's RawPriceQuote. PURE.
 *  - price = newest complete candle close
 *  - open/high/low/volume = the newest candle's IST session aggregate
 *  - previousClose = vendor meta (chartPreviousClose ?? previousClose) or null
 *  - sourceTimestamp = newest complete candle END (last instant price was true)
 * An empty series yields a PARSER_ERROR-shaped quote (price null) so the
 * firewall labels it honestly rather than this function guessing.
 */
export function seriesToRawQuote(
  security: Security,
  series: IntradayCandleSeries,
  meta: YahooIntradayChartResult["meta"] | null,
  fetchedAt: number
): RawPriceQuote {
  const last = series.candles[series.candles.length - 1];
  if (!last) {
    return { source: series.source, securityId: security.securityId, ticker: security.ticker, price: null, fetchedAt };
  }
  const session = aggregateSession(series.candles, series.intervalMs, istDateOfMs(last.startAt));
  const previousClose = finite(meta?.chartPreviousClose) ?? finite(meta?.previousClose) ?? null;
  const price = last.close;
  return {
    source: series.source,
    securityId: security.securityId,
    ticker: security.ticker,
    price,
    previousClose,
    open: session?.open ?? null,
    dayHigh: session?.high ?? null,
    dayLow: session?.low ?? null,
    volume: session?.volume ?? null,
    changePct: previousClose != null && previousClose > 0 ? ((price - previousClose) / previousClose) * 100 : null,
    sourceTimestamp: last.startAt + series.intervalMs,
    fetchedAt,
  };
}

function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export interface DelayedCandlesProviderOptions {
  interval: YahooIntradayInterval;
  range: YahooIntradayRange;
  concurrency: number;
  perFetchTimeoutMs: number;
  retry: RetryOptions;
  /** Per-ticker in-memory cache TTL — Yahoo 429s aggressively; a 5m candle cannot change inside its own interval anyway. */
  cacheTtlMs: number;
  build: Omit<BuildSnapshotOptions, "now">;
  now?: () => number;
  scheduler?: Scheduler;
}

export const DEFAULT_DELAYED_CANDLES_OPTIONS: DelayedCandlesProviderOptions = {
  interval: "5m",
  range: "5d",
  concurrency: 4,
  perFetchTimeoutMs: 10_000,
  retry: { retries: 2, baseDelayMs: 600, maxDelayMs: 5000, jitter: true },
  cacheTtlMs: 60_000,
  build: {},
};

export class DelayedCandlesProvider implements MarketDataProvider {
  readonly mode: MarketDataMode = "DELAYED_CANDLES";
  private readonly fetcher: IntradayCandleFetcher;
  private readonly opts: DelayedCandlesProviderOptions;
  private readonly cache = new Map<string, { at: number; result: YahooIntradayChartResult }>();
  private lastHealth: ProviderHealth = { state: "DISCONNECTED", lastTickAt: null, subscribed: 0 };

  constructor(fetcher: IntradayCandleFetcher = yahooIntradayFetcher, opts: Partial<DelayedCandlesProviderOptions> = {}) {
    this.fetcher = fetcher;
    this.opts = { ...DEFAULT_DELAYED_CANDLES_OPTIONS, ...opts };
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Raw vendor result, cached per ticker for cacheTtlMs. Throws on fetch failure. */
  private async fetchRaw(security: Security): Promise<YahooIntradayChartResult> {
    const key = `${security.ticker}|${this.opts.interval}|${this.opts.range}`;
    const hit = this.cache.get(key);
    const now = this.now();
    if (hit && now - hit.at < this.opts.cacheTtlMs) return hit.result;
    const result = await withRetry(
      () => withTimeout(this.fetcher.fetch(security, this.opts.interval, this.opts.range), this.opts.perFetchTimeoutMs, this.opts.scheduler),
      this.opts.retry
    );
    this.cache.set(key, { at: now, result });
    return result;
  }

  /**
   * The complete-only candle series — what an intraday MONITORING surface
   * consumes (15m context, VWAP, gap policy inputs). Throws when the vendor
   * fetch fails; callers decide how to degrade.
   */
  async fetchCandles(security: Security): Promise<{ series: IntradayCandleSeries; meta: YahooIntradayChartResult["meta"] }> {
    const fetchedAt = this.now();
    const raw = await this.fetchRaw(security);
    const intervalMs = INTRADAY_INTERVAL_MS[this.opts.interval];
    const vendorAsOf = finite(raw.meta.regularMarketTime);
    // Never treat a candle the vendor has not finished publishing as closed.
    const asOf = vendorAsOf != null ? Math.min(fetchedAt, vendorAsOf * 1000) : fetchedAt;
    const { complete, dropped } = completeCandlesOnly(raw.candles, intervalMs, asOf);
    return {
      series: {
        securityId: security.securityId,
        ticker: security.ticker,
        interval: this.opts.interval,
        intervalMs,
        candles: complete,
        droppedForming: dropped,
        asOf,
        fetchedAt,
        source: this.fetcher.name,
      },
      meta: raw.meta,
    };
  }

  async fetchStock(security: Security): Promise<MarketSnapshot> {
    const now = this.now();
    let quote: RawPriceQuote;
    let droppedForming = 0;
    try {
      const { series, meta } = await this.fetchCandles(security);
      droppedForming = series.droppedForming;
      quote = seriesToRawQuote(security, series, meta, now);
    } catch (err) {
      quote = {
        source: this.fetcher.name,
        securityId: security.securityId,
        ticker: security.ticker,
        price: null,
        fetchedAt: now,
        fetchError: err instanceof Error ? err.message : String(err),
      };
    }
    // Same firewall as scraped quotes; only the mode label is ours.
    const snap = buildScrapedSnapshot(security, [quote], { ...this.opts.build, now });
    snap.mode = this.mode;
    snap.notes.push(
      `DELAYED ${this.opts.interval} candles (${this.fetcher.name}); price = newest COMPLETE candle close` +
        (droppedForming > 0 ? `; ${droppedForming} forming candle(s) dropped` : "") +
        `; authority ceiling WAIT — a delayed candle cannot justify a live entry`
    );
    return snap;
  }

  async fetchUniverse(securities: Security[]): Promise<MarketSnapshot[]> {
    const seen = new Set<string>();
    const unique = securities.filter((s) => (seen.has(s.ticker) ? false : (seen.add(s.ticker), true)));
    const snapshots = await mapWithConcurrency(unique, (s) => this.fetchStock(s), this.opts.concurrency);
    const byTicker = new Map(snapshots.map((s) => [s.ticker, s]));
    const okCount = snapshots.filter((s) => s.quality === "OK").length;
    this.lastHealth = {
      state: okCount === 0 ? "DISCONNECTED" : okCount < snapshots.length ? "DEGRADED" : "CONNECTED",
      lastTickAt: this.now(),
      subscribed: unique.length,
      reason: okCount < snapshots.length ? `${snapshots.length - okCount}/${snapshots.length} snapshots not OK` : undefined,
    };
    return securities.map((s) => byTicker.get(s.ticker)!);
  }

  health(): ProviderHealth {
    return this.lastHealth;
  }
}
