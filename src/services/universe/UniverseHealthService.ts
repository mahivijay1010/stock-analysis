/** Read-only universe health: counts, tiers, coverage, sync freshness, provider health, failures. */

import { AppDataSource } from "../../config/database";
import { universeIngestionService } from "./UniverseIngestionService";

export interface UniverseHealth {
  version: string;
  generatedAt: string;
  securities: { total: number; active: number; tradable: number; tierA: number; tierB: number; tierC: number; excluded: number; byType: Record<string, number>; byCapBucket: Record<string, number>; surveillance: number };
  coverage: { computedAt: string | null; price: number; ohlcv: number; closeOnly: number; fundamentals: number; financialResults: number; corporateActions: number; announcements: number; news: number; technicalFeatures: number; meanScore: number | null; tradableWithTechnical: number };
  freshness: { deliveryAsOf: string | null; ohlcvAsOf: string | null; masterSyncedAt: string | null; coverageComputedAt: string | null };
  syncRuns: Array<{ job: string; source: string; status: string; startedAt: string; finishedAt: string | null; counts: Record<string, unknown>; error: string | null }>;
  providers: Array<{ provider: string; state: string; lastSuccessAt: string | null; lastErrorAt: string | null; lastError: string | null; calls: number; failures: number }>;
  failedSymbols: Array<{ symbol: string; reason: string }>;
  retryQueue: Array<{ symbol: string; reason: string }>;
  recentChanges: Array<{ symbol: string; changeType: string; oldValue: string | null; newValue: string | null; observedAt: string }>;
  caveat: string;
}

export class UniverseHealthService {
  async health(): Promise<UniverseHealth> {
    const q = (sql: string, p: unknown[] = []) => AppDataSource.query(sql, p).catch(() => []) as Promise<Array<Record<string, unknown>>>;
    const [sec] = await q(`SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE is_active)::int active, COUNT(*) FILTER (WHERE is_tradable)::int tradable,
        COUNT(*) FILTER (WHERE liquidity_tier='A' AND is_active AND instrument_type='EQUITY')::int a, COUNT(*) FILTER (WHERE liquidity_tier='B' AND is_active AND instrument_type='EQUITY')::int b,
        COUNT(*) FILTER (WHERE liquidity_tier='C' AND is_active AND instrument_type='EQUITY')::int c, COUNT(*) FILTER (WHERE surveillance IS NOT NULL)::int surv,
        MAX(source_freshness_at) synced FROM security_master`);
    const types = await q(`SELECT instrument_type t, COUNT(*)::int n FROM security_master GROUP BY 1`);
    const caps = await q(`SELECT market_cap_bucket b, COUNT(*)::int n FROM security_master WHERE instrument_type='EQUITY' AND is_active GROUP BY 1`);
    const [cov] = await q(`SELECT COUNT(*) FILTER (WHERE price_available)::int price, COUNT(*) FILTER (WHERE ohlcv_available)::int ohlcv, COUNT(*) FILTER (WHERE close_only)::int close_only,
        COUNT(*) FILTER (WHERE fundamentals_available)::int fund, COUNT(*) FILTER (WHERE financial_results_available)::int results, COUNT(*) FILTER (WHERE corporate_actions_available)::int ca,
        COUNT(*) FILTER (WHERE announcement_available)::int ann, COUNT(*) FILTER (WHERE news_available)::int news, COUNT(*) FILTER (WHERE technical_features_available)::int tech,
        AVG(coverage_score)::float mean_score, MAX(computed_at) computed_at,
        COUNT(*) FILTER (WHERE technical_features_available AND symbol IN (SELECT symbol FROM security_master WHERE is_tradable))::int tradable_tech
        FROM security_data_coverage`);
    const [fresh] = await q(`SELECT (SELECT MAX(trade_date)::text FROM nse_delivery) deliv, (SELECT MAX(trading_date)::text FROM stock_history) ohlcv`);
    const runs = await q(`SELECT job, source, status, started_at, finished_at, counts, error FROM universe_sync_runs ORDER BY started_at DESC LIMIT 12`);
    const changes = await q(`SELECT symbol, change_type, old_value, new_value, observed_at::text FROM security_master_changes ORDER BY created_at DESC LIMIT 30`);
    const failed = await q(`SELECT m.symbol, 'tradable but no OHLCV bars stored' AS reason FROM security_master m JOIN security_data_coverage c ON c.symbol = m.symbol WHERE m.is_tradable AND NOT c.ohlcv_available ORDER BY m.liquidity_median_value_inr DESC NULLS LAST LIMIT 50`);
    const total = Number(sec?.total ?? 0);
    const a = Number(sec?.a ?? 0), b = Number(sec?.b ?? 0), c = Number(sec?.c ?? 0);
    return {
      version: "universe-health-v1",
      generatedAt: new Date().toISOString(),
      securities: {
        total,
        active: Number(sec?.active ?? 0),
        tradable: Number(sec?.tradable ?? 0),
        tierA: a,
        tierB: b,
        tierC: c,
        excluded: Math.max(0, total - a - b - c),
        byType: Object.fromEntries(types.map((t) => [String(t.t), Number(t.n)])),
        byCapBucket: Object.fromEntries(caps.map((t) => [String(t.b), Number(t.n)])),
        surveillance: Number(sec?.surv ?? 0),
      },
      coverage: {
        computedAt: cov?.computed_at ? new Date(String(cov.computed_at)).toISOString() : null,
        price: Number(cov?.price ?? 0),
        ohlcv: Number(cov?.ohlcv ?? 0),
        closeOnly: Number(cov?.close_only ?? 0),
        fundamentals: Number(cov?.fund ?? 0),
        financialResults: Number(cov?.results ?? 0),
        corporateActions: Number(cov?.ca ?? 0),
        announcements: Number(cov?.ann ?? 0),
        news: Number(cov?.news ?? 0),
        technicalFeatures: Number(cov?.tech ?? 0),
        meanScore: cov?.mean_score != null ? Math.round(Number(cov.mean_score) * 10) / 10 : null,
        tradableWithTechnical: Number(cov?.tradable_tech ?? 0),
      },
      freshness: {
        deliveryAsOf: fresh?.deliv ? String(fresh.deliv) : null,
        ohlcvAsOf: fresh?.ohlcv ? String(fresh.ohlcv) : null,
        masterSyncedAt: sec?.synced ? new Date(String(sec.synced)).toISOString() : null,
        coverageComputedAt: cov?.computed_at ? new Date(String(cov.computed_at)).toISOString() : null,
      },
      syncRuns: runs.map((r) => ({ job: String(r.job), source: String(r.source), status: String(r.status), startedAt: new Date(String(r.started_at)).toISOString(), finishedAt: r.finished_at ? new Date(String(r.finished_at)).toISOString() : null, counts: (r.counts as Record<string, unknown>) ?? {}, error: r.error ? String(r.error) : null })),
      providers: [universeIngestionService.providerHealth()],
      failedSymbols: failed.map((f) => ({ symbol: String(f.symbol), reason: String(f.reason) })),
      retryQueue: failed.slice(0, 20).map((f) => ({ symbol: String(f.symbol), reason: "queued for OHLCV backfill on the next broad scan" })),
      recentChanges: changes.map((c) => ({ symbol: String(c.symbol), changeType: String(c.change_type), oldValue: c.old_value ? String(c.old_value) : null, newValue: c.new_value ? String(c.new_value) : null, observedAt: String(c.observed_at) })),
      caveat: "Counts are what is stored, not what exists. Delivery data is close-only (no OHLC); OHLCV is stored only for securities the engines have fetched. Coverage never decides tradability.",
    };
  }
}

export const universeHealthService = new UniverseHealthService();
