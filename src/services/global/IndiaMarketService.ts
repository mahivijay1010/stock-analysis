/**
 * IndiaMarketService — gathers point-in-time inputs for the India Market
 * Diagnosis and persists one row per session into india_market_days.
 *
 * Sources (all already in the system, nothing new is fetched per-symbol):
 *   breadth / turnover   nse_delivery (whole EQ universe, one set-based query)
 *   NIFTY / BANKNIFTY / India VIX / USD/INR   Yahoo daily bars via GlobalMarketDataService
 *   sector relative strength                  the equal-weight sector proxies
 *   authoritative regime                      shortterm/RegimeService (unchanged, still the gate input)
 */

import { AppDataSource } from "../../config/database";
import { regimeService } from "../shortterm/RegimeService";
import { GlobalMarketDataService, globalMarketDataService } from "./GlobalMarketDataService";
import { INDIA_SECTOR_PROXIES, INDIA_TZ, instrumentByKey, localToUtc } from "./globalUniverse";
import { BreadthDay, computeIndiaDiagnosis, IndiaDiagnosis, IndiaInputs } from "./indiaMarket";

export class IndiaMarketService {
  constructor(private readonly data: GlobalMarketDataService = globalMarketDataService) {}

  /** Exchange-wide advances/declines and turnover per session (point-in-time by construction: LAG uses only prior rows). */
  async breadthDays(lookbackDays = 140): Promise<BreadthDay[]> {
    const rows: Array<{ d: string; adv: string; dec: string; n: string; turnover: string }> = await AppDataSource.query(
      `WITH px AS (
         SELECT symbol, trade_date, close_price,
                LAG(close_price) OVER (PARTITION BY symbol ORDER BY trade_date) AS prev,
                turnover_lacs
           FROM nse_delivery
          WHERE series = 'EQ' AND trade_date >= (SELECT MAX(trade_date) FROM nse_delivery) - $1::int
       )
       SELECT trade_date::text AS d,
              COUNT(*) FILTER (WHERE prev IS NOT NULL AND close_price > prev)::text AS adv,
              COUNT(*) FILTER (WHERE prev IS NOT NULL AND close_price < prev)::text AS dec,
              COUNT(*) FILTER (WHERE prev IS NOT NULL)::text AS n,
              COALESCE(SUM(turnover_lacs * 1e5), 0)::text AS turnover
         FROM px GROUP BY trade_date ORDER BY trade_date`,
      [lookbackDays]
    );
    // The first session in the window has no LAG for anyone; drop rows with no counted symbols.
    return rows
      .map((r) => ({ date: r.d, advances: Number(r.adv), declines: Number(r.dec), counted: Number(r.n), turnoverInr: Number(r.turnover) }))
      .filter((r) => r.counted > 100);
  }

  private async bars(key: string): Promise<Array<{ date: string; close: number }> | null> {
    const inst = instrumentByKey(key);
    if (!inst) return null;
    const s = await this.data.series(inst, "2y").catch(() => null);
    return s ? s.points.map((p) => ({ date: p.date, close: p.value })) : null;
  }

  /** Sector-proxy 20-session return minus NIFTY's, as of `upTo`. */
  private sectorRel(proxies: Array<{ key: string; points: Array<{ date: string; value: number }> }>, nifty: Array<{ date: string; close: number }>, upTo: string): Array<{ sector: string; name: string; relPct: number }> | null {
    const slice = (pts: Array<{ date: string; value: number }>) => pts.filter((p) => p.date <= upTo);
    const r20 = (pts: Array<{ date: string; value: number }>): number | null => {
      const s = slice(pts);
      const n = s.length;
      return n > 20 && s[n - 21].value > 0 ? ((s[n - 1].value - s[n - 21].value) / s[n - 21].value) * 100 : null;
    };
    const nf = nifty.filter((p) => p.date <= upTo);
    const nret = nf.length > 20 && nf[nf.length - 21].close > 0 ? ((nf[nf.length - 1].close - nf[nf.length - 21].close) / nf[nf.length - 21].close) * 100 : null;
    if (nret == null) return null;
    const out: Array<{ sector: string; name: string; relPct: number }> = [];
    for (const p of proxies) {
      const r = r20(p.points);
      if (r == null) continue;
      const meta = INDIA_SECTOR_PROXIES.find((x) => x.key === p.key);
      out.push({ sector: p.key, name: meta?.name ?? p.key, relPct: Math.round((r - nret) * 100) / 100 });
    }
    return out.length >= 5 ? out : null;
  }

  /** Diagnose the latest closed session (or `upTo`), optionally persisting the day row. */
  async diagnose(opts: { persist?: boolean; upTo?: string } = {}): Promise<IndiaDiagnosis | null> {
    const breadthAll = await this.breadthDays();
    const breadth = opts.upTo ? breadthAll.filter((b) => b.date <= (opts.upTo as string)) : breadthAll;
    if (!breadth.length) return null;
    const sessionDate = breadth[breadth.length - 1].date;
    const clip = (s: Array<{ date: string; close: number }> | null) => (s ? s.filter((p) => p.date <= sessionDate) : null);
    const [nifty, bankNifty, indiaVix, usdInr, proxies, regime] = await Promise.all([
      this.bars("NIFTY"),
      this.bars("BANKNIFTY"),
      this.bars("INDIAVIX"),
      this.bars("USDINR"),
      this.data.sectorProxySeries().catch(() => []),
      regimeService.detect().catch(() => null),
    ]);
    if (!nifty) return null;
    const inputs: IndiaInputs = {
      breadth,
      nifty: clip(nifty) as Array<{ date: string; close: number }>,
      bankNifty: clip(bankNifty),
      indiaVix: clip(indiaVix),
      usdInr: clip(usdInr),
      sectorRelStrength20: this.sectorRel(proxies, nifty, sessionDate),
      authoritativeRegime: regime ? { regime: regime.regime, reasons: regime.reasons } : null,
    };
    const d = computeIndiaDiagnosis(inputs);
    if (d && opts.persist !== false) await this.persist(d);
    return d;
  }

  private async persist(d: IndiaDiagnosis): Promise<void> {
    await AppDataSource.query(
      `INSERT INTO india_market_days (india_session_date, state, score, components, coverage, feature_cutoff_utc)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)
       ON CONFLICT (india_session_date) DO UPDATE SET state = EXCLUDED.state, score = EXCLUDED.score, components = EXCLUDED.components,
         coverage = EXCLUDED.coverage, feature_cutoff_utc = EXCLUDED.feature_cutoff_utc, computed_at = now()`,
      [d.sessionDate, d.state, d.score, JSON.stringify(d.components), JSON.stringify(d.coverage), localToUtc(INDIA_TZ, d.sessionDate, "15:30")]
    );
  }

  /** Point-in-time backfill: one diagnosis per session, each using only data ≤ that session. */
  async backfill(days = 120): Promise<{ written: number }> {
    const breadthAll = await this.breadthDays(days + 40);
    const [nifty, bankNifty, indiaVix, usdInr, proxies] = await Promise.all([
      this.bars("NIFTY"),
      this.bars("BANKNIFTY"),
      this.bars("INDIAVIX"),
      this.bars("USDINR"),
      this.data.sectorProxySeries().catch(() => []),
    ]);
    if (!nifty) return { written: 0 };
    // The authoritative regime is live-only; historical rows carry null there (stated, not reconstructed loosely).
    let written = 0;
    const sessions = breadthAll.slice(-days).map((b) => b.date);
    for (const sd of sessions) {
      const clip = (s: Array<{ date: string; close: number }> | null) => (s ? s.filter((p) => p.date <= sd) : null);
      const d = computeIndiaDiagnosis({
        breadth: breadthAll.filter((b) => b.date <= sd),
        nifty: clip(nifty) as Array<{ date: string; close: number }>,
        bankNifty: clip(bankNifty),
        indiaVix: clip(indiaVix),
        usdInr: clip(usdInr),
        sectorRelStrength20: this.sectorRel(proxies, nifty, sd),
        authoritativeRegime: null,
      });
      if (!d) continue;
      await this.persist(d);
      written += 1;
    }
    return { written };
  }

  async history(limit = 60): Promise<Array<{ date: string; state: string; score: number }>> {
    const rows: Array<{ d: string; state: string; score: string }> = await AppDataSource.query(
      `SELECT india_session_date::text AS d, state, score::text FROM india_market_days ORDER BY india_session_date DESC LIMIT $1`,
      [Math.min(500, limit)]
    );
    return rows.map((r) => ({ date: r.d, state: r.state, score: Number(r.score) })).reverse();
  }

  async latestStored(): Promise<{ date: string; state: string; score: number } | null> {
    const h = await this.history(1);
    return h[0] ?? null;
  }
}

export const indiaMarketService = new IndiaMarketService();
