/**
 * ValuationService — reads the intelligence layer's cached fundamentals for a
 * set of tickers and computes the descriptive valuation/quality read, and runs
 * the (slow, bounded) background refresh that populates them. Isolated from the
 * radar's evidence base: valuation is a context panel, never a gate input.
 */

import { AppDataSource } from "../../config/database";
import { computeValuation, ValuationMetrics, ValuationResult } from "./valuationQuality";

const VAL_METRICS = ["pe_ratio", "book_value", "roe", "roce", "dcf", "promoter_holding", "promoter_holding_change_qoq", "operating_margin", "profit_growth_yoy", "debt_to_equity"];

interface MetricRow {
  ticker: string;
  metric: string;
  value: string | null;
  value_json: unknown;
  status: string;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

export interface ValuationRow extends ValuationResult {
  ticker: string;
  symbol: string;
  price: number | null;
  calculatedAt: string | null;
}

export class ValuationService {
  /** Valuation/quality for each ticker, from cached intelligence metrics +
   *  latest price. Names with no cached fundamentals return INSUFFICIENT_DATA. */
  async forTickers(tickers: string[]): Promise<Map<string, ValuationRow>> {
    const out = new Map<string, ValuationRow>();
    const symbols = [...new Set(tickers.map((t) => t.replace(/\.(NS|BO)$/i, "").toUpperCase()).filter(Boolean))];
    if (symbols.length === 0) return out;

    // intelligence_metrics stores BARE symbols (no .NS). Match both forms to be safe.
    const tickerForms = [...symbols, ...symbols.map((s) => `${s}.NS`)];
    const rows: MetricRow[] = await AppDataSource.query(
      `SELECT DISTINCT ON (ticker, metric) ticker, metric, value, value_json, status
         FROM intelligence_metrics
        WHERE ticker = ANY($1) AND metric = ANY($2)
        ORDER BY ticker, metric, (status = 'SCRAPED') ASC, calculated_at DESC`,
      [tickerForms, VAL_METRICS]
    );
    const byTicker = new Map<string, Map<string, MetricRow>>();
    for (const r of rows) {
      const key = r.ticker.replace(/\.(NS|BO)$/i, "").toUpperCase();
      const g = byTicker.get(key) ?? new Map();
      g.set(r.metric, r);
      byTicker.set(key, g);
    }

    // Latest close per symbol from nse_delivery (the sub-₹100 price source).
    const priceRows: Array<{ symbol: string; c: string }> = await AppDataSource.query(
      `SELECT DISTINCT ON (symbol) symbol, close_price c
         FROM nse_delivery WHERE series = 'EQ' AND symbol = ANY($1)
        ORDER BY symbol, trade_date DESC`,
      [symbols]
    );
    const priceBy = new Map(priceRows.map((p) => [p.symbol, num(p.c)]));

    for (const symbol of symbols) {
      const g = byTicker.get(symbol);
      const price = priceBy.get(symbol) ?? null;
      const dcfBase = this.dcfBase(g?.get("dcf"));
      const metrics: ValuationMetrics = {
        pe: num(g?.get("pe_ratio")?.value),
        bookValuePerShare: num(g?.get("book_value")?.value),
        roe: num(g?.get("roe")?.value),
        roce: num(g?.get("roce")?.value),
        deRatio: num(g?.get("debt_to_equity")?.value),
        dcfBaseIntrinsic: dcfBase,
        promoterHolding: num(g?.get("promoter_holding")?.value),
        promoterChangeQoq: num(g?.get("promoter_holding_change_qoq")?.value),
        operatingMargin: num(g?.get("operating_margin")?.value),
        profitGrowthYoy: num(g?.get("profit_growth_yoy")?.value),
      };
      out.set(symbol, { ticker: `${symbol}.NS`, symbol, price, calculatedAt: null, ...computeValuation(metrics, price) });
    }
    return out;
  }

  private dcfBase(row: MetricRow | undefined): number | null {
    if (!row || row.status !== "ESTIMATED" || row.value_json == null) return null;
    try {
      const parsed = typeof row.value_json === "string" ? JSON.parse(row.value_json) : row.value_json;
      const scenarios = (parsed as { scenarios?: Array<Record<string, unknown>> })?.scenarios;
      const base = scenarios?.find((s) => s.name === "base");
      return base ? num(base.intrinsicValuePerShare) : null;
    } catch {
      return null;
    }
  }

  /** Background refresh: fetch fundamentals for names missing cached valuation
   *  metrics. Bounded concurrency; each refresh is ~20–30s, so this is slow by
   *  nature — call it for a shortlist, not the whole 2,700. */
  async refreshUniverse(symbols: string[], opts: { limit?: number; concurrency?: number; onlyMissing?: boolean } = {}): Promise<{ attempted: number; refreshed: number; failed: number; skippedCached: number }> {
    const { intelligenceService } = await import("../intelligence/IntelligenceService");
    const limit = opts.limit ?? 50;
    const concurrency = Math.max(1, Math.min(4, opts.concurrency ?? 2));
    const uniq = [...new Set(symbols.map((s) => s.replace(/\.(NS|BO)$/i, "").toUpperCase()))];

    let candidates = uniq;
    let skippedCached = 0;
    if (opts.onlyMissing !== false) {
      const have = await this.forTickers(uniq);
      candidates = uniq.filter((s) => (have.get(s)?.verdict ?? "INSUFFICIENT_DATA") === "INSUFFICIENT_DATA");
      skippedCached = uniq.length - candidates.length;
    }
    candidates = candidates.slice(0, limit);

    let refreshed = 0;
    let failed = 0;
    let idx = 0;
    const worker = async (): Promise<void> => {
      while (idx < candidates.length) {
        const s = candidates[idx++];
        try {
          await intelligenceService.refreshTicker(`${s}.NS`);
          refreshed++;
        } catch {
          failed++;
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return { attempted: candidates.length, refreshed, failed, skippedCached };
  }
}

export const valuationService = new ValuationService();
