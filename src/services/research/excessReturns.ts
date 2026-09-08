/**
 * Excess-return targets (OpenAI-first upgrade, Part 5) — PURE decomposition:
 *
 *   stock return = market component + sector component + stock-specific residual
 *
 * The learning targets are RELATIVE:
 *   - h-session excess return vs NIFTY,
 *   - h-session excess return vs an equal-weight sector basket,
 *   - rolling-beta residual (stock − β·market) for diagnostics.
 *
 * Everything is date-aligned by TRADING SESSION (inner join on dates); missing
 * alignment produces null targets, never silent misalignment. No future data:
 * beta at t uses returns strictly ≤ t; forward returns use t→t+h only as
 * TARGETS (label side).
 */

export interface AlignedSeries {
  dates: string[];
  /** Simple returns per session, aligned to `dates` (index 0 = return into dates[0]). */
  stock: number[];
  market: number[];
  sector: (number | null)[];
}

/** Inner-join daily closes into aligned simple-return series. */
export function alignReturns(
  stockBars: Array<{ date: string; close: number }>,
  marketBars: Array<{ date: string; close: number }>,
  sectorIndex?: Map<string, number> | null // date -> sector basket "close" (equal-weight index level)
): AlignedSeries {
  const mkt = new Map(marketBars.map((b) => [b.date, b.close]));
  const dates: string[] = [];
  const stock: number[] = [];
  const market: number[] = [];
  const sector: (number | null)[] = [];
  let prevS: number | null = null;
  let prevM: number | null = null;
  let prevSec: number | null = null;
  for (const b of stockBars) {
    const m = mkt.get(b.date);
    if (m == null || !(m > 0) || !(b.close > 0)) continue;
    const sec = sectorIndex?.get(b.date) ?? null;
    if (prevS != null && prevM != null) {
      dates.push(b.date);
      stock.push(b.close / prevS - 1);
      market.push(m / prevM - 1);
      sector.push(sec != null && prevSec != null && prevSec > 0 ? sec / prevSec - 1 : null);
    }
    prevS = b.close;
    prevM = m;
    prevSec = sec ?? prevSec;
  }
  return { dates, stock, market, sector };
}

/** Rolling OLS beta of stock on market over `window` sessions ending at index i (inclusive). */
export function rollingBeta(aligned: AlignedSeries, i: number, window = 60): number | null {
  const start = i - window + 1;
  if (start < 0) return null;
  let sumM = 0;
  let sumS = 0;
  for (let k = start; k <= i; k++) {
    sumM += aligned.market[k];
    sumS += aligned.stock[k];
  }
  const meanM = sumM / window;
  const meanS = sumS / window;
  let cov = 0;
  let varM = 0;
  for (let k = start; k <= i; k++) {
    cov += (aligned.market[k] - meanM) * (aligned.stock[k] - meanS);
    varM += (aligned.market[k] - meanM) ** 2;
  }
  if (varM <= 1e-12) return null;
  return cov / varM;
}

/** Cumulative simple return over sessions (i, i+h] on a per-session return series. */
function cumForward(rets: number[], i: number, h: number): number | null {
  if (i + h >= rets.length + 1 && i + h > rets.length) return null;
  if (i + h > rets.length) return null;
  let c = 1;
  for (let k = i + 1; k <= i + h; k++) {
    if (k >= rets.length) return null;
    c *= 1 + rets[k];
  }
  return c - 1;
}

export interface ExcessTargets {
  /** date index i refers to the ANCHOR session; targets look strictly forward. */
  excessVsMarket: number | null;
  excessVsSector: number | null;
  /** stock_h − β_t·market_h with β estimated on data ≤ t (residual diagnostic). */
  betaResidual: number | null;
  rawStock: number | null;
  rawMarket: number | null;
}

/** Forward h-session targets anchored at index i (features may use ≤ i only). */
export function forwardExcessTargets(aligned: AlignedSeries, i: number, h: number, betaWindow = 60): ExcessTargets {
  const s = cumForward(aligned.stock, i, h);
  const m = cumForward(aligned.market, i, h);
  let sec: number | null = null;
  if (aligned.sector.every((x) => x != null) || aligned.sector[i] != null) {
    const secRets = aligned.sector.map((x) => x ?? 0);
    const anyNull = aligned.sector.slice(i + 1, i + 1 + h).some((x) => x == null);
    sec = anyNull ? null : cumForward(secRets, i, h);
  }
  const beta = rollingBeta(aligned, i, betaWindow);
  return {
    excessVsMarket: s != null && m != null ? s - m : null,
    excessVsSector: s != null && sec != null ? s - sec : null,
    betaResidual: s != null && m != null && beta != null ? s - beta * m : null,
    rawStock: s,
    rawMarket: m,
  };
}

/**
 * Equal-weight sector index levels from same-sector members' closes.
 * Point-in-time safe: the level at date d uses only that date's closes, and a
 * date is included only when ≥3 members traded (else null — stated, not padded).
 */
export function buildSectorIndex(
  membersBars: Array<Array<{ date: string; close: number }>>
): Map<string, number> {
  const byDate = new Map<string, number[]>();
  for (const bars of membersBars) {
    let prev: number | null = null;
    for (const b of bars) {
      if (!(b.close > 0)) continue;
      if (prev != null && prev > 0) {
        const r = b.close / prev - 1;
        const list = byDate.get(b.date) ?? [];
        list.push(r);
        byDate.set(b.date, list);
      }
      prev = b.close;
    }
  }
  const dates = Array.from(byDate.keys()).sort();
  const index = new Map<string, number>();
  let level = 100;
  for (const d of dates) {
    const rets = byDate.get(d)!;
    if (rets.length < 3) continue; // too thin to call it a sector move
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    level *= 1 + mean;
    index.set(d, level);
  }
  return index;
}
