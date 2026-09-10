/**
 * FundamentalsPanelService — Stale-While-Revalidate (SWR) read-through cache
 * for scraped fundamentals. User actions drive freshness instead of a blind
 * universe loop.
 *
 *  - `<12h` old  → serve the stored values immediately (no scrape).
 *  - stale/missing → serve whatever is stored NOW (fast, possibly empty) AND
 *    trigger a background refresh for the next view.
 *
 * Single-flight: concurrent requests for the same ticker share one in-flight
 * refresh, so a burst of page views never fans out into duplicate scrapes.
 */

import { AppDataSource } from "../../config/database";
import { IntelligenceMetric } from "../../entities";
import { fundamentalsEngine, FundamentalsEngine } from "./FundamentalsEngine";
import { IntelligenceRepository } from "./IntelligenceRepository";

const FRESH_MS = 12 * 60 * 60 * 1000;

export interface PanelFundamentals {
  ticker: string;
  ratios: Record<string, { value: number; provider: string; asOf: string }>;
  ageMs: number | null;
  fresh: boolean;
  refreshTriggered: boolean;
}

export class FundamentalsPanelService {
  private inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly engine: FundamentalsEngine = fundamentalsEngine,
    private readonly repo: IntelligenceRepository = new IntelligenceRepository()
  ) {}

  private norm(ticker: string): string {
    return ticker.trim().toUpperCase().replace(/\.(NS|BO)$/i, "");
  }

  async get(ticker: string): Promise<PanelFundamentals> {
    const symbol = this.norm(ticker);
    const rows: Array<{ metric: string; value: string | null; methodology: string; calculated_at: string }> = await AppDataSource.query(
      `SELECT DISTINCT ON (metric) metric, value, methodology, calculated_at
         FROM intelligence_metrics
        WHERE ticker = $1 AND status = 'SCRAPED'
        ORDER BY metric, calculated_at DESC`,
      [symbol]
    ).catch(() => []);

    const ratios: PanelFundamentals["ratios"] = {};
    let newest = 0;
    for (const r of rows) {
      if (r.value == null) continue;
      const ts = new Date(r.calculated_at).getTime();
      newest = Math.max(newest, ts);
      ratios[r.metric] = { value: Number(r.value), provider: r.methodology.replace(/^SCRAPED_/, ""), asOf: r.calculated_at };
    }
    const ageMs = newest > 0 ? Date.now() - newest : null;
    const fresh = ageMs != null && ageMs < FRESH_MS;

    let refreshTriggered = false;
    if (!fresh) {
      refreshTriggered = true;
      void this.refreshInBackground(symbol); // fire-and-forget; serve stale now
    }
    return { ticker: symbol, ratios, ageMs, fresh, refreshTriggered };
  }

  /** Single-flight background refresh — persists scraped ratios for next view. */
  private refreshInBackground(symbol: string): Promise<void> {
    const existing = this.inflight.get(symbol);
    if (existing) return existing;
    const p = (async () => {
      try {
        const merged = await this.engine.getRatios(symbol);
        const metrics = this.engine.toMetricResults(merged);
        if (metrics.length > 0 && AppDataSource.isInitialized) await this.repo.saveMetrics(symbol, metrics);
      } catch {
        /* transient — next view retries */
      } finally {
        this.inflight.delete(symbol);
      }
    })();
    this.inflight.set(symbol, p);
    return p;
  }
}

export const fundamentalsPanelService = new FundamentalsPanelService();
