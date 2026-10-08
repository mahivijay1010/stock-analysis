/**
 * GlobalMarketDataService — fetches daily series for the global universe
 * (Yahoo chart, memory-cached 1h; nothing is written to stocks/stock_history),
 * builds observations with returns/volatility/freshness per instrument and
 * timezone, upserts them into global_market_observations, and builds the
 * Indian sector proxies (equal-weight by NSE industry) from exchange closes.
 */

import { AppDataSource } from "../../config/database";
import { fetchChart } from "../market/yahoo";
import { Bar } from "../market/types";
import { DailySeries } from "./globalRelationships";
import { GLOBAL_UNIVERSE, GlobalInstrument, INDIA_SECTOR_PROXIES, localToUtc, marketStatusAt, observationFreshness, partsIn } from "./globalUniverse";

export interface GlobalObservation {
  instrument: string;
  name: string;
  assetClass: string;
  region: string;
  sessionDate: string;
  exchangeTz: string;
  localCloseAt: string;
  utcCloseAt: string;
  marketStatus: string;
  price: number;
  return1d: number | null;
  return5d: number | null;
  return20d: number | null;
  chg5bps: number | null;
  chg20bps: number | null;
  volatility20: number | null;
  volume: number | null;
  source: string;
  sourceTimestamp: string | null;
  freshness: "FRESH" | "DELAYED" | "STALE";
  dataQuality: number;
  isYield: boolean;
}

const r4 = (v: number): number => Math.round(v * 10000) / 10000;
const CACHE_TTL_MS = 60 * 60_000;

export class GlobalMarketDataService {
  private cache = new Map<string, { at: number; bars: Bar[] }>();
  private sectorCache: { at: number; series: DailySeries[] } | null = null;

  async bars(inst: GlobalInstrument, range: "1y" | "2y" | "5y" = "2y"): Promise<Bar[]> {
    if (!inst.yahoo) return [];
    const k = `${inst.yahoo}:${range}`;
    const hit = this.cache.get(k);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.bars;
    const res = await fetchChart(inst.yahoo, range);
    // Yahoo stamps bars in IST already (unixToISTDateString); for non-IST exchanges re-derive the LOCAL session date from the bar timestamp when present.
    const bars = res.bars.filter((b) => b.close > 0);
    this.cache.set(k, { at: Date.now(), bars });
    return bars;
  }

  /** Daily series (adjusted close or close) for one instrument, keyed for the studies. */
  async series(inst: GlobalInstrument, range: "2y" | "5y" = "2y"): Promise<DailySeries | null> {
    const bars = await this.bars(inst, range).catch(() => []);
    if (!bars.length) return null;
    return { key: inst.key, points: bars.map((b) => ({ date: b.date, value: inst.isYield ? b.close : (b.adjustedClose ?? b.close) })), isYield: inst.isYield, sameDayUsable: inst.closesBeforeIndiaClose };
  }

  /** Observation for the latest completed session of an instrument (as of `now`). */
  observationFromBars(inst: GlobalInstrument, bars: Bar[], now: Date): GlobalObservation | null {
    if (bars.length < 2) return null;
    const status = marketStatusAt(inst, now);
    // While a session is OPEN, Yahoo's last bar is partial — drop it so only completed sessions count.
    const todayLocal = partsIn(inst.tz, now).date;
    const completed = status === "OPEN" || status === "PRE_OPEN" ? bars.filter((b) => b.date < todayLocal) : bars;
    if (completed.length < 2) return null;
    const n = completed.length;
    const last = completed[n - 1];
    const v = (b: Bar) => (inst.isYield ? b.close : (b.adjustedClose ?? b.close));
    const ret = (k: number) => (n > k && v(completed[n - 1 - k]) > 0 ? r4(((v(last) - v(completed[n - 1 - k])) / v(completed[n - 1 - k])) * 100) : null);
    const bps = (k: number) => (n > k ? r4((v(last) - v(completed[n - 1 - k])) * 100) : null);
    const lr: number[] = [];
    for (let i = Math.max(1, n - 20); i < n; i++) if (v(completed[i - 1]) > 0 && v(completed[i]) > 0) lr.push(Math.log(v(completed[i]) / v(completed[i - 1])));
    const m = lr.length ? lr.reduce((a, b) => a + b, 0) / lr.length : 0;
    const vol = lr.length > 1 ? Math.sqrt(lr.reduce((a, x) => a + (x - m) ** 2, 0) / (lr.length - 1)) * Math.sqrt(252) * 100 : null;
    const closeUtc = localToUtc(inst.tz, last.date, inst.localClose);
    const freshness = observationFreshness(inst, last.date, now);
    const quality = Math.max(0, Math.min(100, (n >= 250 ? 60 : (n / 250) * 60) + (freshness === "FRESH" ? 40 : freshness === "DELAYED" ? 20 : 0)));
    return {
      instrument: inst.key,
      name: inst.name,
      assetClass: inst.assetClass,
      region: inst.region,
      sessionDate: last.date,
      exchangeTz: inst.tz,
      localCloseAt: `${last.date}T${inst.localClose}:00 ${inst.tz}`,
      utcCloseAt: closeUtc.toISOString(),
      marketStatus: status,
      price: r4(v(last)),
      return1d: inst.isYield ? null : ret(1),
      return5d: inst.isYield ? null : ret(5),
      return20d: inst.isYield ? null : ret(20),
      chg5bps: inst.isYield ? bps(5) : null,
      chg20bps: inst.isYield ? bps(20) : null,
      volatility20: vol != null ? r4(vol) : null,
      volume: last.volume > 0 ? last.volume : null,
      source: "yahoo-chart",
      sourceTimestamp: closeUtc.toISOString(),
      freshness,
      dataQuality: Math.round(quality * 10) / 10,
      isYield: !!inst.isYield,
    };
  }

  /** Fetch + observe every instrument; missing sources are reported, never invented. */
  async observeAll(now = new Date()): Promise<{ observations: GlobalObservation[]; missing: Array<{ instrument: string; reason: string }> }> {
    const observations: GlobalObservation[] = [];
    const missing: Array<{ instrument: string; reason: string }> = [];
    const queue = [...GLOBAL_UNIVERSE];
    const worker = async () => {
      for (;;) {
        const inst = queue.shift();
        if (!inst) return;
        if (!inst.yahoo) {
          missing.push({ instrument: inst.key, reason: "no configured source" });
          continue;
        }
        try {
          const o = this.observationFromBars(inst, await this.bars(inst), now);
          if (o) observations.push(o);
          else missing.push({ instrument: inst.key, reason: "fewer than 2 completed sessions" });
        } catch (err) {
          missing.push({ instrument: inst.key, reason: err instanceof Error ? err.message : String(err) });
        }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    await this.persist(observations);
    return { observations: observations.sort((a, b) => a.instrument.localeCompare(b.instrument)), missing };
  }

  private async persist(obs: GlobalObservation[]): Promise<void> {
    if (!obs.length) return;
    const values: unknown[] = [];
    const tuples: string[] = [];
    obs.forEach((o, i) => {
      const b = i * 17;
      tuples.push(`(${Array.from({ length: 17 }, (_, k) => `$${b + k + 1}`).join(",")})`);
      values.push(o.instrument, o.assetClass, o.region, o.sessionDate, o.exchangeTz, new Date(o.utcCloseAt), new Date(o.utcCloseAt), o.price, o.return1d, o.return5d, o.return20d, o.volatility20, o.volume, o.source, o.sourceTimestamp ? new Date(o.sourceTimestamp) : null, o.freshness, o.dataQuality);
    });
    await AppDataSource.query(
      `INSERT INTO global_market_observations (instrument, asset_class, region, session_date, exchange_tz, local_close_at, utc_close_at, price, return_1d, return_5d, return_20d, volatility_20, volume, source, source_timestamp, freshness, data_quality)
       VALUES ${tuples.join(",")}
       ON CONFLICT (instrument, session_date) DO UPDATE SET price = EXCLUDED.price, return_1d = EXCLUDED.return_1d, return_5d = EXCLUDED.return_5d, return_20d = EXCLUDED.return_20d, volatility_20 = EXCLUDED.volatility_20,
         volume = EXCLUDED.volume, freshness = EXCLUDED.freshness, data_quality = EXCLUDED.data_quality, fetched_at = now()`,
      values
    );
  }

  /** Equal-weight Indian sector proxies from exchange closes (tier A/B, by NSE industry). */
  async sectorProxySeries(): Promise<DailySeries[]> {
    if (this.sectorCache && Date.now() - this.sectorCache.at < CACHE_TTL_MS) return this.sectorCache.series;
    const rows: Array<{ industry: string; d: string; r: string }> = await AppDataSource.query(
      `WITH m AS (SELECT symbol, industry FROM security_master WHERE is_tradable AND industry IS NOT NULL),
            px AS (SELECT d.symbol, m.industry, d.trade_date, d.close_price,
                          LAG(d.close_price) OVER (PARTITION BY d.symbol ORDER BY d.trade_date) AS prev
                     FROM nse_delivery d JOIN m ON m.symbol = d.symbol WHERE d.series = 'EQ' AND d.trade_date >= CURRENT_DATE - 800)
       SELECT industry, trade_date::text AS d, AVG(close_price / prev - 1)::text AS r FROM px WHERE prev > 0 AND close_price / prev BETWEEN 0.5 AND 2 GROUP BY industry, trade_date ORDER BY industry, trade_date`
    );
    const byInd = new Map<string, Array<{ date: string; r: number }>>();
    for (const x of rows) byInd.set(x.industry, [...(byInd.get(x.industry) ?? []), { date: x.d, r: Number(x.r) }]);
    const series: DailySeries[] = [];
    for (const p of INDIA_SECTOR_PROXIES) {
      const dates = new Map<string, number[]>();
      for (const ind of p.industries) for (const x of byInd.get(ind) ?? []) dates.set(x.date, [...(dates.get(x.date) ?? []), x.r]);
      if (!dates.size) continue;
      let level = 100;
      const points = [...dates.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, rs]) => {
        level *= 1 + rs.reduce((a, b) => a + b, 0) / rs.length;
        return { date, value: level };
      });
      series.push({ key: p.key, points, sameDayUsable: true });
    }
    this.sectorCache = { at: Date.now(), series };
    return series;
  }
}

export const globalMarketDataService = new GlobalMarketDataService();
