/**
 * SecurityDataCoverageService — per-security coverage flags, timestamps and a
 * coverageScore, computed from what is actually stored:
 *   price / close-only depth   nse_delivery (EQ feed) and stock_history (OHLCV)
 *   fundamentals               intelligence_metrics, financial_facts
 *   financial results          financial_facts with a period_end
 *   corporate actions          stock_history split/dividend, stock_knowledge CORPORATE_ACTION
 *   announcements              structured_market_events
 *   news                       stock_knowledge NEWS facts
 *   technical features         ≥ 200 OHLCV bars (features.ts needs SMA200)
 * coverageScore is informational; it never decides tradability.
 */

import { AppDataSource } from "../../config/database";

export const COVERAGE_VERSION = "coverage-v1";
export const COVERAGE_WEIGHTS = { price: 15, ohlcv: 20, depth: 15, fundamentals: 15, results: 10, corporateActions: 5, announcements: 5, news: 5, technical: 10 } as const;

export interface CoverageRow {
  symbol: string;
  priceAvailable: boolean;
  ohlcvAvailable: boolean;
  closeOnly: boolean;
  historicalDepthSessions: number;
  fundamentalsAvailable: boolean;
  financialResultsAvailable: boolean;
  corporateActionsAvailable: boolean;
  announcementAvailable: boolean;
  newsAvailable: boolean;
  technicalFeaturesAvailable: boolean;
  lastPriceTimestamp: string | null;
  lastFundamentalTimestamp: string | null;
  lastNewsTimestamp: string | null;
  lastEventTimestamp: string | null;
  coverageScore: number;
}

/** Pure scoring so it can be tested without a database. */
export function scoreCoverage(c: Omit<CoverageRow, "coverageScore" | "symbol">): number {
  let s = 0;
  if (c.priceAvailable) s += COVERAGE_WEIGHTS.price;
  if (c.ohlcvAvailable) s += COVERAGE_WEIGHTS.ohlcv;
  s += COVERAGE_WEIGHTS.depth * Math.min(1, c.historicalDepthSessions / 250);
  if (c.fundamentalsAvailable) s += COVERAGE_WEIGHTS.fundamentals;
  if (c.financialResultsAvailable) s += COVERAGE_WEIGHTS.results;
  if (c.corporateActionsAvailable) s += COVERAGE_WEIGHTS.corporateActions;
  if (c.announcementAvailable) s += COVERAGE_WEIGHTS.announcements;
  if (c.newsAvailable) s += COVERAGE_WEIGHTS.news;
  if (c.technicalFeaturesAvailable) s += COVERAGE_WEIGHTS.technical;
  return Math.round(s * 10) / 10;
}

export class SecurityDataCoverageService {
  /** Recompute coverage for every security in one pass of set-based SQL (no per-symbol queries). */
  async recomputeAll(): Promise<{ computed: number; withOhlcv: number; withFundamentals: number; withNews: number; withEvents: number; withResults: number; withTechnical: number }> {
    const rows: Array<Record<string, unknown>> = await AppDataSource.query(`
      WITH deliv AS (
        SELECT symbol, COUNT(*) AS sessions, MAX(trade_date) AS last_d FROM nse_delivery WHERE series = 'EQ' GROUP BY symbol
      ),
      hist AS (
        SELECT s.ticker, COUNT(*) AS bars, MAX(h.trading_date) AS last_d,
               BOOL_OR(h.split_factor IS NOT NULL AND h.split_factor <> 1) OR BOOL_OR(h.dividend IS NOT NULL AND h.dividend > 0) AS has_ca
          FROM stock_history h JOIN stocks s ON s.id = h.stock_id GROUP BY s.ticker
      ),
      metrics AS (
        SELECT ticker, MAX(calculated_at) AS last_m FROM intelligence_metrics GROUP BY ticker
      ),
      facts AS (
        SELECT ticker, MAX(period_end) AS last_p, MAX(created_at) AS last_c FROM financial_facts GROUP BY ticker
      ),
      events AS (
        SELECT ticker, MAX(announced_at) AS last_e FROM structured_market_events GROUP BY ticker
      ),
      know AS (
        SELECT symbol,
               MAX(observed_at) FILTER (WHERE source_kind = 'NEWS') AS last_news,
               BOOL_OR(kind = 'CORPORATE_ACTION') AS has_ca,
               BOOL_OR(kind IN ('EVENT','RESULTS','REGULATORY')) AS has_event
          FROM stock_knowledge GROUP BY symbol
      )
      SELECT m.symbol, m.yahoo_ticker,
             d.sessions, d.last_d AS deliv_last,
             h.bars, h.last_d AS hist_last, h.has_ca AS hist_ca,
             me.last_m, f.last_p, f.last_c, e.last_e, k.last_news, k.has_ca AS know_ca, k.has_event
        FROM security_master m
        LEFT JOIN deliv d ON d.symbol = m.symbol
        LEFT JOIN hist h ON h.ticker = m.yahoo_ticker
        LEFT JOIN metrics me ON me.ticker = m.yahoo_ticker OR me.ticker = m.symbol
        LEFT JOIN facts f ON f.ticker = m.yahoo_ticker OR f.ticker = m.symbol
        LEFT JOIN events e ON e.ticker = m.yahoo_ticker OR e.ticker = m.symbol
        LEFT JOIN know k ON k.symbol = m.symbol`);
    const out = { computed: 0, withOhlcv: 0, withFundamentals: 0, withNews: 0, withEvents: 0, withResults: 0, withTechnical: 0 };
    const batch: string[] = [];
    const params: unknown[] = [];
    const flush = async () => {
      if (!batch.length) return;
      await AppDataSource.query(
        `INSERT INTO security_data_coverage (symbol, price_available, ohlcv_available, close_only, historical_depth_sessions, fundamentals_available, financial_results_available,
           corporate_actions_available, announcement_available, news_available, technical_features_available, last_price_timestamp, last_fundamental_timestamp, last_news_timestamp, last_event_timestamp, coverage_score, detail, computed_at)
         VALUES ${batch.join(",")}
         ON CONFLICT (symbol) DO UPDATE SET price_available = EXCLUDED.price_available, ohlcv_available = EXCLUDED.ohlcv_available, close_only = EXCLUDED.close_only,
           historical_depth_sessions = EXCLUDED.historical_depth_sessions, fundamentals_available = EXCLUDED.fundamentals_available, financial_results_available = EXCLUDED.financial_results_available,
           corporate_actions_available = EXCLUDED.corporate_actions_available, announcement_available = EXCLUDED.announcement_available, news_available = EXCLUDED.news_available,
           technical_features_available = EXCLUDED.technical_features_available, last_price_timestamp = EXCLUDED.last_price_timestamp, last_fundamental_timestamp = EXCLUDED.last_fundamental_timestamp,
           last_news_timestamp = EXCLUDED.last_news_timestamp, last_event_timestamp = EXCLUDED.last_event_timestamp, coverage_score = EXCLUDED.coverage_score, detail = EXCLUDED.detail, computed_at = now()`,
        params
      );
      batch.length = 0;
      params.length = 0;
    };
    for (const r of rows) {
      const sessions = Number(r.sessions ?? 0);
      const bars = Number(r.bars ?? 0);
      const c = {
        priceAvailable: sessions > 0 || bars > 0,
        ohlcvAvailable: bars > 0,
        closeOnly: sessions > 0 && bars === 0,
        historicalDepthSessions: Math.max(sessions, bars),
        fundamentalsAvailable: r.last_m != null || r.last_p != null,
        financialResultsAvailable: r.last_p != null,
        corporateActionsAvailable: r.hist_ca === true || r.know_ca === true,
        announcementAvailable: r.last_e != null || r.has_event === true,
        newsAvailable: r.last_news != null,
        technicalFeaturesAvailable: bars >= 200,
        lastPriceTimestamp: (r.hist_last ?? r.deliv_last) ? new Date(String(r.hist_last ?? r.deliv_last)).toISOString() : null,
        lastFundamentalTimestamp: r.last_m ? new Date(String(r.last_m)).toISOString() : r.last_c ? new Date(String(r.last_c)).toISOString() : null,
        lastNewsTimestamp: r.last_news ? new Date(String(r.last_news)).toISOString() : null,
        lastEventTimestamp: r.last_e ? new Date(String(r.last_e)).toISOString() : null,
      };
      const score = scoreCoverage(c);
      out.computed += 1;
      if (c.ohlcvAvailable) out.withOhlcv += 1;
      if (c.fundamentalsAvailable) out.withFundamentals += 1;
      if (c.newsAvailable) out.withNews += 1;
      if (c.announcementAvailable || c.corporateActionsAvailable) out.withEvents += 1;
      if (c.financialResultsAvailable) out.withResults += 1;
      if (c.technicalFeaturesAvailable) out.withTechnical += 1;
      const base = params.length;
      batch.push(`(${Array.from({ length: 17 }, (_, i) => `$${base + i + 1}`).join(",")}, now())`);
      params.push(r.symbol, c.priceAvailable, c.ohlcvAvailable, c.closeOnly, c.historicalDepthSessions, c.fundamentalsAvailable, c.financialResultsAvailable, c.corporateActionsAvailable, c.announcementAvailable, c.newsAvailable, c.technicalFeaturesAvailable, c.lastPriceTimestamp, c.lastFundamentalTimestamp, c.lastNewsTimestamp, c.lastEventTimestamp, score, JSON.stringify({ version: COVERAGE_VERSION, sessions, bars }));
      if (batch.length >= 300) await flush();
    }
    await flush();
    // data_status on the master: OK = OHLCV + ≥200 bars, PARTIAL = any price, NONE otherwise.
    await AppDataSource.query(`UPDATE security_master m SET data_status = CASE WHEN c.technical_features_available THEN 'OK' WHEN c.price_available THEN 'PARTIAL' ELSE 'NONE' END, updated_at = now()
      FROM security_data_coverage c WHERE c.symbol = m.symbol`);
    return out;
  }
}

export const securityDataCoverageService = new SecurityDataCoverageService();
