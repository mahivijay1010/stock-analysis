/**
 * Canonical point-in-time market data (completion directive, Phase 1) — PURE
 * transforms over stored/fetched bars. One adjustment policy for everything:
 *
 *   analysis price series = adjustedClose ?? close
 *
 * so corporate actions stop fabricating return jumps wherever an adjusted
 * value exists, and the (already-shipped) >25%-jump detector keeps flagging
 * any residual unadjusted segment as a data-quality penalty rather than
 * letting it silently poison μ/σ/momentum/backtests.
 *
 * Honesty rules encoded here:
 *  - volume 0 on an equity session is treated as MISSING (null), never a real
 *    zero — providers record absent volume as 0 (audit §6).
 *  - duplicate session dates are deduped (latest fetch wins) and COUNTED.
 *  - nothing fabricates bars for weekends/holidays: absent sessions stay absent.
 *  - completed sessions only: the fetch/persist paths already drop the partial
 *    today-bar; isCompleteSession records that contract on every canonical bar.
 */

import { Bar } from "./types";

export interface CanonicalBar {
  ticker: string;
  sessionDate: string; // YYYY-MM-DD (IST)
  open: number;
  high: number;
  low: number;
  close: number;
  adjustedClose: number | null;
  volume: number | null; // null = missing/unreported (never a fabricated 0)
  splitFactor: number | null;
  dividend: number | null;
  source: string; // "yahoo" | "db-fresh" | "db-stale"
  fetchedAt: string; // ISO — when this representation was assembled
  isCompleteSession: boolean;
}

export interface CanonicalSeries {
  ticker: string;
  bars: CanonicalBar[];
  source: string;
  isStale: boolean;
  duplicatesRemoved: number;
  /** True when any |adjusted-return| > 25% remains — possible unadjusted CA. */
  suspectedUnadjustedBreak: boolean;
  lastSessionDate: string | null;
}

/** The one adjustment policy: adjusted when available, actual close otherwise. */
export function analysisCloses(bars: Array<Pick<Bar, "close" | "adjustedClose">>): number[] {
  return bars.map((b) => {
    const adj = b.adjustedClose;
    return adj != null && Number.isFinite(adj) && adj > 0 ? adj : b.close;
  });
}

/** Daily simple returns over the analysis price series (CA-safe where adjusted). */
export function adjustedDailyReturns(bars: Array<Pick<Bar, "close" | "adjustedClose">>): number[] {
  const closes = analysisCloses(bars);
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) rets.push(closes[i] / closes[i - 1] - 1);
  }
  return rets;
}

export function toCanonical(
  ticker: string,
  bars: Bar[],
  opts: {
    source: string;
    events?: { splits: Record<string, number>; dividends: Record<string, number> } | null;
    fetchedAt?: Date;
  }
): CanonicalSeries {
  const fetchedAt = (opts.fetchedAt ?? new Date()).toISOString();
  const byDate = new Map<string, Bar>();
  let duplicatesRemoved = 0;
  for (const b of bars) {
    if (byDate.has(b.date)) duplicatesRemoved++;
    byDate.set(b.date, b); // latest fetch wins — same rule as the DB reader
  }
  const sorted = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));

  const canonical: CanonicalBar[] = sorted.map((b) => ({
    ticker,
    sessionDate: b.date,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    adjustedClose:
      b.adjustedClose != null && Number.isFinite(b.adjustedClose) && b.adjustedClose > 0
        ? b.adjustedClose
        : null,
    // Equities never genuinely trade zero volume on a session — 0 = missing.
    volume: b.volume > 0 ? b.volume : null,
    splitFactor: opts.events?.splits[b.date] ?? null,
    dividend: opts.events?.dividends[b.date] ?? null,
    source: opts.source,
    fetchedAt,
    // The fetch/persist paths drop the partial today-bar before analytics see
    // it (T3 fix + persist guard), so every bar that reaches here is a
    // completed session by construction.
    isCompleteSession: true,
  }));

  const rets = adjustedDailyReturns(sorted);
  return {
    ticker,
    bars: canonical,
    source: opts.source,
    isStale: opts.source === "db-stale",
    duplicatesRemoved,
    suspectedUnadjustedBreak: rets.some((r) => Math.abs(r) > 0.25),
    lastSessionDate: canonical.length > 0 ? canonical[canonical.length - 1].sessionDate : null,
  };
}
