/**
 * Stock-selection signals and their cross-sectional scoring — PURE.
 *
 * Definitions are frozen by docs/stock-selection-preregistration.md
 * (registered 2026-10-01, before any signal was computed on this data).
 * Changing anything here is a methodology change: append it to that doc with
 * a date, and the sealed year is spent for the changed signal.
 *
 * Every signal is judged only on how it RANKS stocks within a formation date.
 * The market's direction cancels out exactly: a constant scores 50%.
 */

export type SignalKey = "sector-momentum" | "sector-reversal" | "earnings-drift";

export interface SignalSpec {
  key: SignalKey;
  horizon: number; // trading days
  minCohort: number;
  describe: string;
}

export const SIGNALS: SignalSpec[] = [
  { key: "sector-momentum", horizon: 21, minCohort: 20, describe: "12-1 month return minus its sector median" },
  { key: "sector-reversal", horizon: 5, minCohort: 20, describe: "minus (5-day return minus its sector median)" },
  { key: "earnings-drift", horizon: 21, minCohort: 8, describe: "announcement-reaction abnormal return [d0,d0+1], live 60 sessions" },
];

export const MIN_SECTOR_SIZE = 3;
export const BAD_DAILY_RETURN = 0.4;
export const EARNINGS_LIVE_SESSIONS = 60;
/** NSE close, IST minutes after midnight. A broadcast before this is priced into that day's close. */
export const NSE_CLOSE_MIN_IST = 15 * 60 + 30;

/** Aligned daily panel. close[t][i] is NaN where the stock has no bar. */
export interface Panel {
  dates: string[]; // YYYY-MM-DD ascending, trading sessions
  tickers: string[];
  sectors: Array<string | null>;
  close: number[][];
  /** Per ticker index: earnings broadcast instants (epoch ms). */
  events: number[][];
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Average ranks (ties share the mean rank). */
function ranks(xs: number[]): number[] {
  const idx = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(xs.length);
  let k = 0;
  while (k < idx.length) {
    let j = k;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[k][0]) j++;
    const avg = (k + j) / 2 + 1;
    for (let m = k; m <= j; m++) r[idx[m][1]] = avg;
    k = j + 1;
  }
  return r;
}

export function spearman(a: number[], b: number[]): number | null {
  if (a.length < 3) return null;
  const ra = ranks(a);
  const rb = ranks(b);
  const n = a.length;
  const ma = ra.reduce((s, x) => s + x, 0) / n;
  const mb = rb.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : null;
}

/** prefix[i][t] = number of bad daily returns for stock i in sessions 1..t. */
function badDayPrefix(p: Panel): number[][] {
  return p.tickers.map((_, i) => {
    const pre = new Array<number>(p.dates.length).fill(0);
    for (let t = 1; t < p.dates.length; t++) {
      const a = p.close[t - 1][i];
      const b = p.close[t][i];
      const bad = Number.isFinite(a) && Number.isFinite(b) && a > 0 && Math.abs(b / a - 1) > BAD_DAILY_RETURN ? 1 : 0;
      pre[t] = pre[t - 1] + bad;
    }
    return pre;
  });
}

const ret = (p: Panel, i: number, from: number, to: number): number | null => {
  if (from < 0 || to >= p.dates.length) return null;
  const a = p.close[from][i];
  const b = p.close[to][i];
  return Number.isFinite(a) && Number.isFinite(b) && a > 0 ? b / a - 1 : null;
};

/** First session index whose close is after `instant` (a broadcast before 15:30 IST counts that day). PURE. */
export function reactionSession(dates: string[], instant: number): number {
  const ist = new Date(instant + 5.5 * 3600_000);
  const day = ist.toISOString().slice(0, 10);
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const sameDayOk = minutes < NSE_CLOSE_MIN_IST;
  for (let t = 0; t < dates.length; t++) {
    if (dates[t] > day || (dates[t] === day && sameDayOk)) return t;
  }
  return -1;
}

/** Raw signal values at formation index t (before cohort selection); null where undefined. PURE. */
export function signalAt(p: Panel, key: SignalKey, t: number, ctx: SignalContext): Array<number | null> {
  const n = p.tickers.length;
  if (key === "earnings-drift") return ctx.earnings[t] ?? new Array(n).fill(null);

  const raw: Array<number | null> = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    raw[i] = key === "sector-momentum" ? ret(p, i, t - 252, t - 21) : ret(p, i, t - 5, t);
  }
  const valid = raw.map((v, i) => (v == null ? null : i)).filter((i): i is number => i != null);
  if (valid.length === 0) return raw;
  const uni = median(valid.map((i) => raw[i]!));
  const bySector = new Map<string, number[]>();
  for (const i of valid) {
    const s = p.sectors[i] ?? "";
    const g = bySector.get(s);
    if (g) g.push(raw[i]!);
    else bySector.set(s, [raw[i]!]);
  }
  const secMed = new Map<string, number>();
  for (const [s, g] of bySector) secMed.set(s, s && g.length >= MIN_SECTOR_SIZE ? median(g) : uni);
  return raw.map((v, i) => {
    if (v == null) return null;
    const rel = v - (secMed.get(p.sectors[i] ?? "") ?? uni);
    return key === "sector-reversal" ? -rel : rel;
  });
}

export interface SignalContext {
  bad: number[][];
  /** earnings[t][i] = live announcement abnormal return, or null. */
  earnings: Array<Array<number | null>>;
}

/** Precompute bad-day prefixes and the earnings signal grid. PURE. */
export function buildContext(p: Panel): SignalContext {
  const T = p.dates.length;
  const n = p.tickers.length;
  const earnings: Array<Array<number | null>> = Array.from({ length: T }, () => new Array(n).fill(null));
  // Universe median 2-day reaction return per d0 (computed lazily).
  const uniCache = new Map<number, number | null>();
  const uniMedian = (d0: number): number | null => {
    if (uniCache.has(d0)) return uniCache.get(d0)!;
    const rs: number[] = [];
    for (let i = 0; i < n; i++) {
      const r = ret(p, i, d0 - 1, d0 + 1);
      if (r != null) rs.push(r);
    }
    const m = rs.length >= 10 ? median(rs) : null;
    uniCache.set(d0, m);
    return m;
  };
  for (let i = 0; i < n; i++) {
    for (const instant of [...p.events[i]].sort((a, b) => a - b)) {
      const d0 = reactionSession(p.dates, instant);
      if (d0 < 1 || d0 + 1 >= T) continue;
      const r = ret(p, i, d0 - 1, d0 + 1);
      const m = uniMedian(d0);
      if (r == null || m == null) continue;
      const ab = r - m;
      // live from the close of d0+1 for EARNINGS_LIVE_SESSIONS sessions; a later event overwrites
      for (let t = d0 + 1; t <= Math.min(T - 1, d0 + 1 + EARNINGS_LIVE_SESSIONS); t++) earnings[t][i] = ab;
    }
  }
  return { bad: badDayPrefix(p), earnings };
}

export interface DateScore {
  t: number;
  date: string;
  n: number;
  ic: number | null;
  /** cross-sectional hits / calls at each tier (q = fraction in each tail; 0.5 = everything). */
  tiers: Record<string, { calls: number; hits: number }>;
  spread: number | null;
}

export const TIERS: Array<{ key: string; q: number }> = [
  { key: "all", q: 0.5 },
  { key: "tercile", q: 1 / 3 },
  { key: "quintile", q: 0.2 },
  { key: "decile", q: 0.1 },
];

/** Score one signal at formation index t. Returns null if the cohort is too small. PURE. */
export function scoreDate(p: Panel, spec: SignalSpec, t: number, ctx: SignalContext): DateScore | null {
  const h = spec.horizon;
  if (t + h >= p.dates.length) return null;
  const sig = signalAt(p, spec.key, t, ctx);
  const lookback = spec.key === "sector-momentum" ? 252 : spec.key === "sector-reversal" ? 5 : EARNINGS_LIVE_SESSIONS + 2;
  const s: number[] = [];
  const f: number[] = [];
  for (let i = 0; i < p.tickers.length; i++) {
    const v = sig[i];
    if (v == null) continue;
    const fwd = ret(p, i, t, t + h);
    if (fwd == null) continue;
    const lo = Math.max(0, t - lookback);
    if (ctx.bad[i][t + h] - ctx.bad[i][lo] > 0) continue; // a data error inside the window
    s.push(v);
    f.push(fwd);
  }
  if (s.length < spec.minCohort) return null;

  const mf = median(f);
  const order = s.map((_, k) => k).sort((a, b) => s[a] - s[b]);
  const tiers: DateScore["tiers"] = {};
  for (const tier of TIERS) {
    let calls = 0;
    let hits = 0;
    if (tier.q === 0.5) {
      const ms = median(s);
      for (let k = 0; k < s.length; k++) {
        const up = s[k] > ms;
        const rel = f[k] - mf;
        calls++;
        if ((up && rel > 0) || (!up && rel < 0)) hits++;
      }
    } else {
      const m = Math.max(1, Math.floor(s.length * tier.q));
      for (const k of order.slice(0, m)) {
        calls++;
        if (f[k] - mf < 0) hits++;
      }
      for (const k of order.slice(-m)) {
        calls++;
        if (f[k] - mf > 0) hits++;
      }
    }
    tiers[tier.key] = { calls, hits };
  }
  const m3 = Math.max(1, Math.floor(s.length / 3));
  const mean = (ks: number[]) => ks.reduce((a, k) => a + f[k], 0) / ks.length;
  return {
    t,
    date: p.dates[t],
    n: s.length,
    ic: spearman(s, f),
    tiers,
    spread: mean(order.slice(-m3)) - mean(order.slice(0, m3)),
  };
}

/** Every h-th scored date, starting from the first — so forward windows never overlap. PURE. */
export function nonOverlapping(scores: DateScore[], h: number): DateScore[] {
  const out: DateScore[] = [];
  let next = -Infinity;
  for (const d of scores) {
    if (d.t >= next) {
      out.push(d);
      next = d.t + h;
    }
  }
  return out;
}

export interface PeriodStats {
  dates: number;
  nonOverlappingDates: number;
  meanIc: number | null;
  icT: number | null;
  crossSectionalHitPct: number | null;
  meanSpreadPct: number | null;
  tiers: Array<{ key: string; calls: number; hitPct: number | null; lb95Pct: number | null }>;
}

/** Aggregate a period's date scores; all inference on non-overlapping dates. PURE. */
export function periodStats(scores: DateScore[], h: number): PeriodStats {
  const no = nonOverlapping(scores, h);
  const ics = no.map((d) => d.ic).filter((x): x is number => x != null);
  const meanIc = ics.length ? ics.reduce((a, b) => a + b, 0) / ics.length : null;
  const sd = ics.length > 1 && meanIc != null ? Math.sqrt(ics.reduce((a, x) => a + (x - meanIc) ** 2, 0) / (ics.length - 1)) : null;
  const icT = meanIc != null && sd && sd > 0 ? meanIc / (sd / Math.sqrt(ics.length)) : null;
  const tiers = TIERS.map((tier) => {
    const per = no.map((d) => d.tiers[tier.key]).filter((x) => x && x.calls > 0);
    const calls = per.reduce((a, x) => a + x.calls, 0);
    const hits = per.reduce((a, x) => a + x.hits, 0);
    const rates = per.map((x) => x.hits / x.calls);
    const mr = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null;
    const sdr = rates.length > 1 && mr != null ? Math.sqrt(rates.reduce((a, x) => a + (x - mr) ** 2, 0) / (rates.length - 1)) : null;
    return {
      key: tier.key,
      calls,
      hitPct: calls > 0 ? (hits / calls) * 100 : null,
      lb95Pct: mr != null && sdr != null ? (mr - (1.96 * sdr) / Math.sqrt(rates.length)) * 100 : null,
    };
  });
  const spreads = no.map((d) => d.spread).filter((x): x is number => x != null);
  return {
    dates: scores.length,
    nonOverlappingDates: no.length,
    meanIc,
    icT,
    crossSectionalHitPct: tiers[0].hitPct,
    meanSpreadPct: spreads.length ? (spreads.reduce((a, b) => a + b, 0) / spreads.length) * 100 : null,
    tiers,
  };
}
