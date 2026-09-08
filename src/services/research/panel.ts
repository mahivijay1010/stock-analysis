/**
 * Cross-sectional panel dataset (OpenAI-first upgrade, Part 6) — stock × date
 * observations over the covered NSE universe, with EXCESS-RETURN targets
 * (Part 5) and strictly point-in-time features.
 *
 * LEAKAGE RULES (enforced by construction, tested in tests/panel-leakage.test.ts):
 *  - features at anchor index i use bars/returns with index ≤ i only;
 *  - targets use sessions (i, i+h] only;
 *  - Yahoo snapshot fundamentals are EXCLUDED — they are today's values with
 *    no point-in-time history (stated, not fudged); the only fundamental-ish
 *    features are event counts whose announcedAt is provably ≤ anchor;
 *  - splits are by DATE across the whole panel (purge = max horizon + embargo),
 *    so no ticker's test dates ever overlap another ticker's training labels.
 */

import { AppDataSource } from "../../config/database";
import { marketDataService } from "../market/MarketDataService";
import { NSE_UNIVERSE } from "../../data/nseUniverse";
import { alignReturns, buildSectorIndex, forwardExcessTargets, rollingBeta, AlignedSeries } from "./excessReturns";
import { Bar } from "../market/types";
import { analysisCloses } from "../market/canonical";

export const PANEL_VERSION = "panel-v2";
export const PANEL_HORIZONS_TD = [1, 5, 10, 21] as const;

export interface PanelRow {
  ticker: string;
  sector: string;
  date: string; // anchor session
  features: Record<string, number | null>;
  targets: Record<
    number,
    { excessVsMarket: number | null; excessVsSector: number | null; rawStock: number | null }
  >;
}

export interface PanelDataset {
  version: string;
  builtAt: string;
  rows: PanelRow[];
  featureNames: string[];
  dates: string[]; // unique sorted anchor dates
  skipped: Array<{ ticker: string; reason: string }>;
}

const WARMUP = 210; // sessions before the first anchor (sma200 + beta60 need ≤210)

function std(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

function trailingReturn(closes: number[], i: number, n: number): number | null {
  if (i - n < 0 || !(closes[i - n] > 0)) return null;
  return closes[i] / closes[i - n] - 1;
}

/** Per-anchor features from data ≤ i ONLY. `ci` = index into closes aligned with returns index i. */
function buildRowFeatures(
  closes: number[],
  bars: Bar[],
  aligned: AlignedSeries,
  i: number,
  sectorRets: Array<number | null>
): Record<string, number | null> {
  const ci = i + 1; // aligned.stock[k] is the return INTO closes[k+1]
  const price = closes[ci];
  const sma = (n: number): number | null => {
    if (ci - n + 1 < 0) return null;
    let s = 0;
    for (let k = ci - n + 1; k <= ci; k++) s += closes[k];
    return s / n;
  };
  const smaDist = (n: number): number | null => {
    const v = sma(n);
    return v != null && v > 0 ? (price - v) / v : null;
  };
  const year = closes.slice(Math.max(0, ci - 251), ci + 1);
  const hi = Math.max(...year);
  const lo = Math.min(...year);
  const rets20 = aligned.stock.slice(Math.max(0, i - 19), i + 1);
  const vol20 = std(rets20);
  const upDays10 = aligned.stock.slice(Math.max(0, i - 9), i + 1).filter((r) => r > 0).length;

  const vols = bars.slice(Math.max(0, ci - 20), ci).map((b) => b.volume).filter((v) => v > 0);
  const volAvg = vols.length >= 10 ? vols.reduce((a, b) => a + b, 0) / vols.length : null;
  const volToday = bars[ci]?.volume ?? 0;
  const prevClose = closes[ci - 1];
  const open = bars[ci]?.open ?? null;

  const niftySlice = (n: number): number | null => {
    if (i - n + 1 < 0) return null;
    let c = 1;
    for (let k = i - n + 1; k <= i; k++) c *= 1 + aligned.market[k];
    return c - 1;
  };
  const sectorSlice = (n: number): number | null => {
    if (i - n + 1 < 0) return null;
    let c = 1;
    for (let k = i - n + 1; k <= i; k++) {
      const r = sectorRets[k];
      if (r == null) return null;
      c *= 1 + r;
    }
    return c - 1;
  };

  return {
    r1: aligned.stock[i],
    r3: trailingReturn(closes, ci, 3),
    r5: trailingReturn(closes, ci, 5),
    r10: trailingReturn(closes, ci, 10),
    r20: trailingReturn(closes, ci, 20),
    r60: trailingReturn(closes, ci, 60),
    vol20Ann: vol20 != null ? vol20 * Math.sqrt(252) : null,
    drawdown252: hi > 0 ? price / hi - 1 : null,
    smaDist20: smaDist(20),
    smaDist50: smaDist(50),
    smaDist200: smaDist(200),
    week52Pct: hi > lo ? (price - lo) / (hi - lo) : null,
    volumeRatio20: volAvg != null && volAvg > 0 && volToday > 0 ? volToday / volAvg : null,
    gapPct: open != null && prevClose > 0 ? open / prevClose - 1 : null,
    trendPersist10: upDays10 / 10,
    beta60: rollingBeta(aligned, i, 60),
    niftyR5: niftySlice(5),
    niftyR20: niftySlice(20),
    sectorR5: sectorSlice(5),
    sectorR20: sectorSlice(20),
    relStrength20:
      trailingReturn(closes, ci, 20) != null && niftySlice(20) != null
        ? (trailingReturn(closes, ci, 20) as number) - (niftySlice(20) as number)
        : null,
  };
}

export async function buildPanelDataset(opts?: {
  tickers?: string[];
  log?: (m: string) => void;
}): Promise<PanelDataset> {
  const log = opts?.log ?? (() => undefined);
  const universe = opts?.tickers
    ? NSE_UNIVERSE.filter((u) => opts.tickers!.includes(u.ticker))
    : NSE_UNIVERSE;

  const nifty = await marketDataService.getNiftyBars("5y");
  const skipped: Array<{ ticker: string; reason: string }> = [];

  // Load all bars once; group by sector for the sector indexes.
  const barsByTicker = new Map<string, Bar[]>();
  for (const u of universe) {
    try {
      const bars = await marketDataService.getDailyBars(u.ticker, "5y");
      if (bars.length < WARMUP + 30) {
        skipped.push({ ticker: u.ticker, reason: `only ${bars.length} bars` });
        continue;
      }
      barsByTicker.set(u.ticker, bars);
    } catch (e) {
      skipped.push({ ticker: u.ticker, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  log(`bars loaded for ${barsByTicker.size}/${universe.length} tickers`);

  const bySector = new Map<string, string[]>();
  for (const u of universe) {
    if (!barsByTicker.has(u.ticker)) continue;
    const list = bySector.get(u.sector) ?? [];
    list.push(u.ticker);
    bySector.set(u.sector, list);
  }
  const sectorIndexBySector = new Map<string, Map<string, number>>();
  for (const [sector, members] of bySector) {
    const memberBars = members.map((t) => {
      const bars = barsByTicker.get(t)!;
      const closes = analysisCloses(bars);
      return bars.map((b, idx) => ({ date: b.date, close: closes[idx] }));
    });
    sectorIndexBySector.set(sector, buildSectorIndex(memberBars));
  }

  // panel-v2: universe breadth + advance/decline per DATE (point-in-time —
  // each date's value uses only that date's and prior closes).
  const breadthByDate = new Map<string, { above: number; total: number }>();
  const advDecByDate = new Map<string, { adv: number; dec: number }>();
  for (const [, bars] of barsByTicker) {
    const closes = analysisCloses(bars);
    let rollingSum = 0;
    for (let i = 0; i < bars.length; i++) {
      rollingSum += closes[i];
      if (i >= 50) rollingSum -= closes[i - 50];
      if (i >= 49) {
        const sma50 = rollingSum / 50;
        const b = breadthByDate.get(bars[i].date) ?? { above: 0, total: 0 };
        b.total++;
        if (closes[i] > sma50) b.above++;
        breadthByDate.set(bars[i].date, b);
      }
      if (i >= 1 && closes[i - 1] > 0) {
        const a = advDecByDate.get(bars[i].date) ?? { adv: 0, dec: 0 };
        if (closes[i] > closes[i - 1]) a.adv++;
        else if (closes[i] < closes[i - 1]) a.dec++;
        advDecByDate.set(bars[i].date, a);
      }
    }
  }
  const breadthAt = (date: string): number | null => {
    const b = breadthByDate.get(date);
    return b && b.total >= 20 ? b.above / b.total : null;
  };
  const advDeclineAt = (dates: string[], endIdx: number): number | null => {
    let adv = 0;
    let dec = 0;
    for (let k = Math.max(0, endIdx - 4); k <= endIdx; k++) {
      const a = advDecByDate.get(dates[k]);
      if (!a) return null;
      adv += a.adv;
      dec += a.dec;
    }
    return dec > 0 ? adv / dec : adv > 0 ? 5 : null;
  };

  // Point-in-time event counts (announcedAt ≤ anchor close) per ticker.
  const eventRows: Array<{ ticker: string; event_type: string; announced_on: string }> = await AppDataSource.query(
    `SELECT ticker, event_type, to_char(announced_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS announced_on
       FROM structured_market_events`
  ).catch(() => []);
  const eventsByTicker = new Map<string, Array<{ type: string; on: string }>>();
  for (const r of eventRows) {
    const list = eventsByTicker.get(r.ticker) ?? [];
    list.push({ type: r.event_type, on: r.announced_on });
    eventsByTicker.set(r.ticker, list);
  }

  const rows: PanelRow[] = [];
  const dateSet = new Set<string>();
  const maxH = Math.max(...PANEL_HORIZONS_TD);

  for (const u of universe) {
    const bars = barsByTicker.get(u.ticker);
    if (!bars) continue;
    const closes = analysisCloses(bars);
    const sectorIdx = sectorIndexBySector.get(u.sector) ?? null;
    const aligned = alignReturns(
      bars.map((b, idx) => ({ date: b.date, close: closes[idx] })),
      nifty.map((b) => ({ date: b.date, close: b.close })),
      sectorIdx
    );
    if (aligned.dates.length < WARMUP) {
      skipped.push({ ticker: u.ticker, reason: `only ${aligned.dates.length} aligned sessions` });
      continue;
    }
    const events = eventsByTicker.get(u.ticker.replace(/\.(NS|BO)$/, "")) ?? [];
    const closesByDate = new Map(bars.map((b, idx) => [b.date, idx]));

    for (let i = WARMUP; i < aligned.dates.length - maxH; i++) {
      const date = aligned.dates[i];
      const ci = closesByDate.get(date);
      if (ci == null) continue;
      const features = buildRowFeatures(closes, bars, aligned, i, aligned.sector);
      // point-in-time event features (dates are IST calendar days)
      const d10 = new Date(new Date(date).getTime() - 10 * 86400_000).toISOString().slice(0, 10);
      const d30 = new Date(new Date(date).getTime() - 30 * 86400_000).toISOString().slice(0, 10);
      features.eventCount10d = events.filter((e) => e.on <= date && e.on > d10).length;
      features.orderWinCount30d = events.filter((e) => e.type === "order_win" && e.on <= date && e.on > d30).length;
      features.breadthAboveSma50 = breadthAt(date);
      features.advDecline5 = advDeclineAt(aligned.dates, i);

      const targets: PanelRow["targets"] = {};
      for (const h of PANEL_HORIZONS_TD) {
        const t = forwardExcessTargets(aligned, i, h);
        targets[h] = { excessVsMarket: t.excessVsMarket, excessVsSector: t.excessVsSector, rawStock: t.rawStock };
      }
      rows.push({ ticker: u.ticker, sector: u.sector, date, features, targets });
      dateSet.add(date);
    }
  }

  const featureNames = rows.length > 0 ? Object.keys(rows[0].features) : [];
  log(`panel built: ${rows.length} rows × ${featureNames.length} features over ${dateSet.size} dates`);
  return {
    version: PANEL_VERSION,
    builtAt: new Date().toISOString(),
    rows,
    featureNames,
    dates: Array.from(dateSet).sort(),
    skipped,
  };
}

/** Date-grouped chronological split with purge+embargo (panel-wide, Part 6). */
export function splitPanelByDate(
  dates: string[],
  opts?: { trainFrac?: number; valFrac?: number; purgeTd?: number; embargoTd?: number }
): { train: Set<string>; val: Set<string>; test: Set<string> } {
  const trainFrac = opts?.trainFrac ?? 0.6;
  const valFrac = opts?.valFrac ?? 0.2;
  const purge = opts?.purgeTd ?? Math.max(...PANEL_HORIZONS_TD) + 2;
  const embargo = opts?.embargoTd ?? 3;
  const n = dates.length;
  const trainEnd = Math.floor(n * trainFrac);
  const valStart = trainEnd + purge + embargo;
  const valEnd = valStart + Math.floor(n * valFrac);
  const testStart = valEnd + purge + embargo;
  return {
    train: new Set(dates.slice(0, trainEnd)),
    val: new Set(dates.slice(valStart, valEnd)),
    test: new Set(dates.slice(testStart)),
  };
}
