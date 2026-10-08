/**
 * FundamentalsRotationService — Milestone 4: extend fundamentals coverage
 * beyond the 151-name rotation by refreshing the STALEST tier-A (then tier-B)
 * tradable securities each night through the existing FundamentalsEngine
 * (Screener → Trendlyne → Tickertape with sanity filters and per-field
 * provenance). Metrics land in intelligence_metrics exactly like the existing
 * rotation; a scraped market cap also fills security_master.market_cap_inr so
 * the cap bucket becomes value-based ('value:' source) instead of index-derived.
 * Rate-limited and budgeted; every run is recorded in universe_sync_runs.
 */

import { AppDataSource } from "../../config/database";
import { UniverseSyncRun } from "../../entities";
import { fundamentalsEngine } from "../intelligence/FundamentalsEngine";
import { IntelligenceRepository } from "../intelligence/IntelligenceRepository";
import { marketCapBucketFromValue } from "./universeClassification";

export const FUNDAMENTALS_ROTATION_BATCH = Number(process.env.FUNDAMENTALS_ROTATION_BATCH ?? 25);
const THROTTLE_MS = Number(process.env.FUNDAMENTALS_ROTATION_THROTTLE_MS ?? 1200);

/** Pure: order candidates stalest-first — never refreshed first, then oldest refresh, tier A before B. */
export function pickRotation(
  rows: Array<{ symbol: string; tier: string; lastFundamentalAt: string | null }>,
  batch: number
): string[] {
  const rank = (r: { tier: string; lastFundamentalAt: string | null }): [number, number] => [
    r.tier === "A" ? 0 : 1,
    r.lastFundamentalAt ? new Date(r.lastFundamentalAt).getTime() : -Infinity,
  ];
  return [...rows]
    .sort((a, b) => {
      const [ta, da] = rank(a);
      const [tb, db] = rank(b);
      return ta - tb || da - db || a.symbol.localeCompare(b.symbol);
    })
    .slice(0, Math.max(0, batch))
    .map((r) => r.symbol);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FundamentalsRotationService {
  private readonly repository = new IntelligenceRepository();

  async rotate(batch = FUNDAMENTALS_ROTATION_BATCH): Promise<Record<string, unknown>> {
    const runRepo = AppDataSource.getRepository(UniverseSyncRun);
    const run = await runRepo.save(runRepo.create({ job: "fundamentalsRotation", source: "screener/trendlyne/tickertape", status: "running", counts: {} }));
    try {
      const rows: Array<{ symbol: string; tier: string; last: string | null }> = await AppDataSource.query(
        `SELECT m.symbol, m.liquidity_tier AS tier, c.last_fundamental_timestamp::text AS last
           FROM security_master m LEFT JOIN security_data_coverage c ON c.symbol = m.symbol
          WHERE m.is_tradable AND m.instrument_type = 'EQUITY' AND m.liquidity_tier IN ('A','B')`
      );
      const picked = pickRotation(rows.map((r) => ({ symbol: r.symbol, tier: r.tier, lastFundamentalAt: r.last })), batch);
      let refreshed = 0;
      let metricsSaved = 0;
      let capsSet = 0;
      const failures: Array<{ symbol: string; error: string }> = [];
      for (const symbol of picked) {
        try {
          const merged = await fundamentalsEngine.getRatios(symbol);
          const metrics = fundamentalsEngine.toMetricResults(merged);
          if (metrics.length) {
            await this.repository.saveMetrics(`${symbol}.NS`, metrics);
            metricsSaved += metrics.length;
          }
          const capCr = merged.values.marketCap;
          if (capCr != null && Number.isFinite(capCr) && capCr > 0) {
            const capInr = capCr * 1e7;
            await AppDataSource.query(
              `UPDATE security_master SET market_cap_inr = $2, market_cap_bucket = $3, market_cap_source = $4, updated_at = now() WHERE symbol = $1`,
              [symbol, capInr, marketCapBucketFromValue(capInr), `value:${merged.fieldSources.marketCap ?? "scraped"}`]
            );
            capsSet += 1;
          }
          refreshed += 1;
        } catch (err) {
          failures.push({ symbol, error: (err instanceof Error ? err.message : String(err)).slice(0, 160) });
        }
        await sleep(THROTTLE_MS);
      }
      const counts = { picked: picked.length, refreshed, metricsSaved, capsSet, failures: failures.slice(0, 10) };
      run.status = failures.length === picked.length && picked.length > 0 ? "failed" : "success";
      run.finishedAt = new Date();
      run.counts = counts;
      run.error = failures.length ? `${failures.length} symbol(s) failed` : null;
      await runRepo.save(run);
      return counts;
    } catch (err) {
      run.status = "failed";
      run.finishedAt = new Date();
      run.error = (err instanceof Error ? err.message : String(err)).slice(0, 4000);
      await runRepo.save(run);
      throw err;
    }
  }
}

export const fundamentalsRotationService = new FundamentalsRotationService();
