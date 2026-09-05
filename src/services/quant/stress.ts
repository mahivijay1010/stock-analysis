/**
 * V7 Module A4 — portfolio stress (PURE: no DB, no HTTP).
 *
 * Two REAL-data methods (honest triage: replaces the crossed-out TimeGAN idea):
 *  (a) worstIndexWindows — the worst non-overlapping 21-trading-day windows of
 *      the actual index history; callers map them onto a portfolio via each
 *      stock's measured beta.
 *  (b) blockBootstrapDrawdown — resample 21-day CONTIGUOUS blocks of the
 *      date-aligned real return matrix (same block across all stocks, which
 *      preserves both autocorrelation and cross-stock correlation), track the
 *      worst point of each portfolio path, report P5/P1 drawdowns. Seeded
 *      mulberry32 → bit-for-bit reproducible.
 */

import { Bar } from "./types";
import { mulberry32 } from "./montecarlo";

export interface IndexWindow {
  startDate: string;
  endDate: string;
  indexReturnPct: number; // window return of the index, in %
}

function round2(x: number): number {
  const r = Math.round(x * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

/**
 * Worst `count` NON-overlapping windows of `windowLen` trading days, by simple
 * close-to-close return. Overlapping echoes of the same crash are suppressed
 * (greedy pick, then exclusion) so the scenarios are distinct events.
 */
export function worstIndexWindows(
  indexBars: Bar[],
  opts?: { windowLen?: number; count?: number }
): IndexWindow[] {
  const windowLen = opts?.windowLen ?? 21;
  const count = opts?.count ?? 5;
  const n = indexBars.length;
  if (n < windowLen + 1 || count <= 0) return [];

  const all: Array<{ start: number; ret: number }> = [];
  for (let start = 0; start + windowLen < n; start++) {
    const a = indexBars[start].close;
    const b = indexBars[start + windowLen].close;
    if (!(a > 0)) continue;
    all.push({ start, ret: b / a - 1 });
  }
  all.sort((x, y) => x.ret - y.ret); // worst first

  const picked: Array<{ start: number; ret: number }> = [];
  for (const w of all) {
    if (picked.length >= count) break;
    const overlaps = picked.some(
      (p) => Math.abs(p.start - w.start) < windowLen
    );
    if (!overlaps) picked.push(w);
  }

  return picked
    .sort((a, b) => a.ret - b.ret)
    .map((w) => ({
      startDate: indexBars[w.start].date,
      endDate: indexBars[w.start + windowLen].date,
      indexReturnPct: round2(w.ret * 100),
    }));
}

export interface BlockBootstrapResult {
  p5DrawdownPct: number; // ≤ 0
  p1DrawdownPct: number; // ≤ p5
  blocks: number;
  blockLen: number;
  observations: number; // aligned return days available for resampling
}

/** Linear-interpolated percentile of an ASCENDING-sorted array (p in 0..100). */
function percentileSorted(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const idx = (p / 100) * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/**
 * Block-bootstrap portfolio drawdown.
 *
 * @param returnsMatrix date-aligned daily returns: returnsMatrix[t][i] is the
 *   return (fraction) of stock i on aligned day t. Every row must have the
 *   same length as `weights`.
 * @param weights portfolio weights (normalized internally; must sum > 0).
 *
 * Each of `blocks` iterations picks ONE random contiguous window of
 * `blockLen` days and walks the weighted portfolio through those REAL days,
 * recording the worst point vs entry (≤ 0 by construction). Throws when there
 * are not enough aligned days — never fabricates a distribution.
 */
export function blockBootstrapDrawdown(
  returnsMatrix: number[][],
  weights: number[],
  opts?: { blocks?: number; blockLen?: number; seed?: number }
): BlockBootstrapResult {
  const blocks = opts?.blocks ?? 2000;
  const blockLen = opts?.blockLen ?? 21;
  const seed = opts?.seed ?? 20260901;

  const T = returnsMatrix.length;
  const k = weights.length;
  if (T < blockLen + 5) {
    throw new Error(
      `blockBootstrapDrawdown needs at least ${blockLen + 5} aligned return days, got ${T}`
    );
  }
  const wSum = weights.reduce((s, w) => s + w, 0);
  if (!(wSum > 0)) throw new Error("blockBootstrapDrawdown: weights must sum > 0");
  const w = weights.map((x) => x / wSum);

  const rand = mulberry32(seed);
  const maxStart = T - blockLen;
  const drawdowns: number[] = new Array(blocks);

  for (let b = 0; b < blocks; b++) {
    const start = Math.floor(rand() * (maxStart + 1));
    // Weighted portfolio path through the block; per-stock compounding.
    const value: number[] = new Array(k).fill(1);
    let worst = 0; // vs entry; entry point itself is 0
    for (let d = 0; d < blockLen; d++) {
      const row = returnsMatrix[start + d];
      let pv = 0;
      for (let i = 0; i < k; i++) {
        value[i] *= 1 + row[i];
        pv += w[i] * value[i];
      }
      const ret = pv - 1;
      if (ret < worst) worst = ret;
    }
    drawdowns[b] = worst;
  }

  drawdowns.sort((a, b) => a - b);
  return {
    p5DrawdownPct: round2(percentileSorted(drawdowns, 5) * 100),
    p1DrawdownPct: round2(percentileSorted(drawdowns, 1) * 100),
    blocks,
    blockLen,
    observations: T,
  };
}

/**
 * 1-year beta vs an index — cov(stock, index) / var(index) over overlapping
 * daily returns. Returns null with fewer than 100 overlapping observations
 * (an honest "not enough data", never a made-up 1.0). Mirrors the analyze()
 * beta so the stress test and the Analyze tab quote the same number.
 */
export function beta1yVsIndex(bars: Bar[], indexBars: Bar[]): number | null {
  if (!indexBars || indexBars.length < 2) return null;
  const idxByDate = new Map(indexBars.map((b) => [b.date, b.close]));
  const window = bars.slice(-260);
  const paired: Array<{ s: number; n: number }> = [];
  for (const b of window) {
    const n = idxByDate.get(b.date);
    if (n !== undefined && b.close > 0 && n > 0) paired.push({ s: b.close, n });
  }
  const sRet: number[] = [];
  const nRet: number[] = [];
  for (let i = 1; i < paired.length; i++) {
    sRet.push(paired[i].s / paired[i - 1].s - 1);
    nRet.push(paired[i].n / paired[i - 1].n - 1);
  }
  if (sRet.length < 100) return null;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const mS = mean(sRet);
  const mN = mean(nRet);
  let cov = 0;
  let varN = 0;
  for (let i = 0; i < sRet.length; i++) {
    cov += (sRet[i] - mS) * (nRet[i] - mN);
    varN += (nRet[i] - mN) ** 2;
  }
  if (varN === 0) return null;
  const beta = cov / varN;
  return Number.isFinite(beta) ? Number(beta.toFixed(3)) : null;
}

/**
 * Date-align daily returns across stocks: only days present in EVERY series
 * survive, so the block bootstrap preserves real cross-stock co-movement.
 * Returns [alignedDates, returnsMatrix].
 */
export function alignDailyReturns(
  barsPerStock: Bar[][]
): { dates: string[]; matrix: number[][] } {
  if (barsPerStock.length === 0) return { dates: [], matrix: [] };
  const maps = barsPerStock.map(
    (bars) => new Map(bars.map((b) => [b.date, b.close]))
  );
  // Dates present in every series, chronological (driven by the first stock).
  const common = barsPerStock[0]
    .map((b) => b.date)
    .filter((d) => maps.every((m) => m.has(d)));

  const dates: string[] = [];
  const matrix: number[][] = [];
  for (let t = 1; t < common.length; t++) {
    const row: number[] = [];
    let ok = true;
    for (const m of maps) {
      const prev = m.get(common[t - 1])!;
      const cur = m.get(common[t])!;
      if (!(prev > 0)) {
        ok = false;
        break;
      }
      row.push(cur / prev - 1);
    }
    if (ok) {
      dates.push(common[t]);
      matrix.push(row);
    }
  }
  return { dates, matrix };
}
