/**
 * ScrapingMarketProvider — the CURRENT V1 MarketDataProvider (reviewer). It
 * orchestrates polling of ~151 stocks every 10 minutes: bounded concurrency,
 * per-source retry with backoff+jitter, timeouts, then the pure validation /
 * freshness / reconciliation layer → a normalized MarketSnapshot.
 *
 * The engine never learns it was scraped: swap this for a BrokerMarketProvider
 * implementing the same interface and nothing downstream changes. The concrete
 * HTML parsing lives in the injected PriceSource[] — this class holds only the
 * vendor-agnostic orchestration, so it is fully unit-testable with fake sources.
 */

import { createHash } from "crypto";
import { MarketDataProvider, MarketDataMode, MarketSnapshot, PriceSource, RawPriceQuote, Security } from "./marketDataProvider";
import { buildScrapedSnapshot, BuildSnapshotOptions } from "./snapshotValidation";
import { mapWithConcurrency, withRetry, withTimeout, RetryOptions, Scheduler } from "./asyncUtils";
import { ProviderHealth } from "./types";

export interface ScrapingProviderOptions {
  concurrency: number;
  perFetchTimeoutMs: number;
  retry: RetryOptions;
  build: Omit<BuildSnapshotOptions, "now">;
  now?: () => number;
  /** Injectable timeout scheduler so per-fetch timeouts are deterministic in tests. */
  scheduler?: Scheduler;
}

export const DEFAULT_SCRAPING_OPTIONS: ScrapingProviderOptions = {
  concurrency: 10,
  perFetchTimeoutMs: 8000,
  retry: { retries: 2, baseDelayMs: 400, maxDelayMs: 4000, jitter: true },
  build: {},
};

export class ScrapingMarketProvider implements MarketDataProvider {
  readonly mode: MarketDataMode = "SCRAPED_SNAPSHOT";
  private readonly sources: PriceSource[];
  private readonly opts: ScrapingProviderOptions;
  private lastHealth: ProviderHealth = { state: "DISCONNECTED", lastTickAt: null, subscribed: 0 };

  constructor(sources: PriceSource[], opts: Partial<ScrapingProviderOptions> = {}) {
    if (sources.length === 0) throw new Error("ScrapingMarketProvider needs at least one PriceSource");
    this.sources = sources;
    this.opts = { ...DEFAULT_SCRAPING_OPTIONS, ...opts };
  }

  async fetchStock(security: Security): Promise<MarketSnapshot> {
    const now = (this.opts.now ?? Date.now)();
    const quotes = await this.gather(security, now);
    return buildScrapedSnapshot(security, quotes, { ...this.opts.build, now });
  }

  async fetchUniverse(securities: Security[]): Promise<MarketSnapshot[]> {
    // De-duplicate by ticker within the cycle so one symbol isn't scraped twice.
    const seen = new Map<string, number>();
    const unique: Security[] = [];
    securities.forEach((s) => { if (!seen.has(s.ticker)) { seen.set(s.ticker, unique.length); unique.push(s); } });

    const snapshots = await mapWithConcurrency(unique, (s) => this.fetchStock(s), this.opts.concurrency);
    const byTicker = new Map(snapshots.map((s) => [s.ticker, s]));

    const okCount = snapshots.filter((s) => s.quality === "OK").length;
    const now = (this.opts.now ?? Date.now)();
    this.lastHealth = {
      state: okCount === 0 ? "DISCONNECTED" : okCount < snapshots.length ? "DEGRADED" : "CONNECTED",
      lastTickAt: now,
      subscribed: unique.length,
      reason: okCount < snapshots.length ? `${snapshots.length - okCount}/${snapshots.length} snapshots not OK` : undefined,
    };
    // Re-expand to the caller's original order (dupes share the same snapshot).
    return securities.map((s) => byTicker.get(s.ticker)!);
  }

  health(): ProviderHealth {
    return this.lastHealth;
  }

  /** One quote per source, each retried/timed independently; a source failure
   *  becomes a `fetchError` quote (validated as FAILED) rather than aborting. */
  private async gather(security: Security, now: number): Promise<RawPriceQuote[]> {
    return Promise.all(
      this.sources.map(async (src) => {
        try {
          return await withRetry(() => withTimeout(src.fetch(security), this.opts.perFetchTimeoutMs, this.opts.scheduler), this.opts.retry);
        } catch (err) {
          return {
            source: src.name,
            securityId: security.securityId,
            ticker: security.ticker,
            price: null,
            fetchedAt: now,
            fetchError: err instanceof Error ? err.message : String(err),
          } satisfies RawPriceQuote;
        }
      })
    );
  }
}

/**
 * Provenance rows for reproducibility (reviewer: store enough to know what
 * produced an evaluation — rawHash + parsingVersion + qualityStatus). PURE:
 * one row per raw source quote. Persisting them is the caller's job.
 */
export interface MarketSourceProvenance {
  ticker: string;
  source: string;
  sourceUrl: string | null;
  fetchedAt: number;
  sourceTimestamp: number | null;
  rawHash: string;
  price: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  changePct: number | null;
  parsingVersion: string;
  mode: MarketDataMode;
}

export function buildProvenanceRows(quotes: RawPriceQuote[], parsingVersion: string, mode: MarketDataMode): MarketSourceProvenance[] {
  return quotes.map((q) => ({
    ticker: q.ticker,
    source: q.source,
    sourceUrl: q.sourceUrl ?? null,
    fetchedAt: q.fetchedAt,
    sourceTimestamp: q.sourceTimestamp ?? null,
    rawHash: createHash("sha256").update(JSON.stringify(q)).digest("hex"),
    price: q.price,
    open: q.open ?? null,
    high: q.dayHigh ?? null,
    low: q.dayLow ?? null,
    volume: q.volume ?? null,
    changePct: q.changePct ?? null,
    parsingVersion,
    mode,
  }));
}
