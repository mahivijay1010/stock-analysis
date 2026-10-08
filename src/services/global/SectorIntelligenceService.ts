/**
 * SectorIntelligenceService — gathers per-sector inputs (proxy series, NIFTY,
 * constituent breadth/turnover from the exchange feed, the measured global
 * impact) and persists one point-in-time regime row per sector per session.
 */

import { AppDataSource } from "../../config/database";
import { GlobalMarketDataService, globalMarketDataService } from "./GlobalMarketDataService";
import { INDIA_SECTOR_PROXIES, instrumentByKey } from "./globalUniverse";
import { computeSectorRegime, SectorBreadthDay, SectorRegime } from "./sectorIntelligence";

export class SectorIntelligenceService {
  constructor(private readonly data: GlobalMarketDataService = globalMarketDataService) {}

  /** Constituent breadth/turnover per sector proxy per session (tier A/B tradable, grouped by NSE industry). */
  async sectorBreadth(lookbackDays = 80): Promise<Map<string, SectorBreadthDay[]>> {
    const rows: Array<{ industry: string; d: string; adv: string; dec: string; n: string; turnover: string }> = await AppDataSource.query(
      `WITH px AS (
         SELECT d.symbol, m.industry, d.trade_date, d.close_price,
                LAG(d.close_price) OVER (PARTITION BY d.symbol ORDER BY d.trade_date) AS prev,
                d.turnover_lacs
           FROM nse_delivery d
           JOIN security_master m ON m.symbol = d.symbol AND m.is_tradable AND m.industry IS NOT NULL
          WHERE d.series = 'EQ' AND d.trade_date >= (SELECT MAX(trade_date) FROM nse_delivery) - $1::int
       )
       SELECT industry, trade_date::text AS d,
              COUNT(*) FILTER (WHERE prev IS NOT NULL AND close_price > prev)::text AS adv,
              COUNT(*) FILTER (WHERE prev IS NOT NULL AND close_price < prev)::text AS dec,
              COUNT(*) FILTER (WHERE prev IS NOT NULL)::text AS n,
              COALESCE(SUM(turnover_lacs * 1e5), 0)::text AS turnover
         FROM px GROUP BY industry, trade_date ORDER BY industry, trade_date`,
      [lookbackDays]
    );
    const byIndustry = new Map<string, SectorBreadthDay[]>();
    for (const r of rows) {
      byIndustry.set(r.industry, [...(byIndustry.get(r.industry) ?? []), { date: r.d, advances: Number(r.adv), declines: Number(r.dec), counted: Number(r.n), turnoverInr: Number(r.turnover) }]);
    }
    // Merge industries into the proxy keys.
    const out = new Map<string, SectorBreadthDay[]>();
    for (const p of INDIA_SECTOR_PROXIES) {
      const byDate = new Map<string, SectorBreadthDay>();
      for (const ind of p.industries) {
        for (const d of byIndustry.get(ind) ?? []) {
          const cur = byDate.get(d.date);
          byDate.set(d.date, cur ? { date: d.date, advances: cur.advances + d.advances, declines: cur.declines + d.declines, counted: cur.counted + d.counted, turnoverInr: cur.turnoverInr + d.turnoverInr } : d);
        }
      }
      const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).filter((d) => d.counted > 0);
      if (days.length) out.set(p.key, days);
    }
    return out;
  }

  /** Diagnose every sector for the latest closed session (or `upTo`), persisting the rows. */
  async diagnose(opts: { persist?: boolean; upTo?: string } = {}): Promise<SectorRegime[]> {
    const [proxies, breadthBy, niftySeries] = await Promise.all([
      this.data.sectorProxySeries(),
      this.sectorBreadth(),
      this.data.series(instrumentByKey("NIFTY")!, "2y"),
    ]);
    if (!niftySeries) return [];
    const nifty = niftySeries.points.map((p) => ({ date: p.date, close: p.value }));
    // Global impact: the latest stored snapshot's sector labels (not recomputed here).
    let impacts = new Map<string, { label: "TAILWIND" | "NEUTRAL" | "HEADWIND" | "STRESS"; reason: string }>();
    try {
      const rows: Array<{ sectors: Array<Record<string, unknown>> | null }> = await AppDataSource.query(`SELECT sectors FROM global_market_snapshots ORDER BY cutoff_utc DESC LIMIT 1`);
      for (const s of rows[0]?.sectors ?? []) impacts.set(String(s.sector), { label: s.label as "TAILWIND" | "NEUTRAL" | "HEADWIND" | "STRESS", reason: String((s.reasons as string[] | undefined)?.[0] ?? "") });
    } catch {
      impacts = new Map();
    }
    const out: SectorRegime[] = [];
    for (const meta of INDIA_SECTOR_PROXIES) {
      const proxy = proxies.find((p) => p.key === meta.key);
      if (!proxy) continue;
      const upTo = opts.upTo ?? proxy.points[proxy.points.length - 1]?.date;
      if (!upTo) continue;
      const r = computeSectorRegime({
        sector: meta.key,
        name: meta.name,
        proxy: proxy.points.filter((p) => p.date <= upTo),
        nifty: nifty.filter((p) => p.date <= upTo),
        breadth: (breadthBy.get(meta.key) ?? []).filter((b) => b.date <= upTo),
        globalImpact: opts.upTo ? null : (impacts.get(meta.key) ?? null),
      });
      if (r) out.push(r);
    }
    if (opts.persist !== false && out.length) await this.persist(out);
    return out;
  }

  private async persist(rows: SectorRegime[]): Promise<void> {
    const values: unknown[] = [];
    const tuples: string[] = [];
    rows.forEach((r) => {
      const b = values.length;
      tuples.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5}::jsonb)`);
      values.push(r.sector, r.sessionDate, r.state, r.score, JSON.stringify(r.components));
    });
    await AppDataSource.query(
      `INSERT INTO sector_regime_days (sector, india_session_date, state, score, components) VALUES ${tuples.join(",")}
       ON CONFLICT (sector, india_session_date) DO UPDATE SET state = EXCLUDED.state, score = EXCLUDED.score, components = EXCLUDED.components, computed_at = now()`,
      values
    );
  }

  /** Point-in-time backfill (global impact is null historically — stated, not reconstructed). */
  async backfill(days = 120): Promise<{ written: number }> {
    const proxies = await this.data.sectorProxySeries();
    const anchor = proxies.find((p) => p.key === "SEC_FIN") ?? proxies[0];
    if (!anchor) return { written: 0 };
    const sessions = anchor.points.slice(-days).map((p) => p.date);
    let written = 0;
    for (const d of sessions) {
      const rows = await this.diagnose({ persist: true, upTo: d });
      written += rows.length;
    }
    return { written };
  }

  async latestStored(): Promise<Array<{ sector: string; date: string; state: string; score: number; components: Array<Record<string, unknown>> }>> {
    const rows: Array<{ sector: string; d: string; state: string; score: string; components: Array<Record<string, unknown>> }> = await AppDataSource.query(
      `SELECT DISTINCT ON (sector) sector, india_session_date::text AS d, state, score::text, components FROM sector_regime_days ORDER BY sector, india_session_date DESC`
    );
    return rows.map((r) => ({ sector: r.sector, date: r.d, state: r.state, score: Number(r.score), components: r.components }));
  }

  async history(days = 60): Promise<Map<string, Array<{ date: string; state: string }>>> {
    const rows: Array<{ sector: string; d: string; state: string }> = await AppDataSource.query(
      `SELECT sector, india_session_date::text AS d, state FROM sector_regime_days WHERE india_session_date >= (SELECT MAX(india_session_date) FROM sector_regime_days) - $1::int ORDER BY sector, india_session_date`,
      [days]
    );
    const out = new Map<string, Array<{ date: string; state: string }>>();
    for (const r of rows) out.set(r.sector, [...(out.get(r.sector) ?? []), { date: r.d, state: r.state }]);
    return out;
  }
}

export const sectorIntelligenceService = new SectorIntelligenceService();
