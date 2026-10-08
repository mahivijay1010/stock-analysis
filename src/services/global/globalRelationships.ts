/**
 * Empirical global → India relationships (pure).
 *
 * Shock studies: "when driver X moved by ≥ k over 5 sessions (as usable at
 * India's close on T), what did target Y do over the next h sessions?"
 * Sector sensitivities: correlation / beta of sector 5-session returns to
 * driver 5-session returns, lag-aligned by the same leakage rule.
 * Everything reports n and is marked displayable only above MIN_SHOCK_N /
 * MIN_CORR_N. Nothing here is a rule; it is evidence.
 */

import { wilsonLb95 } from "../evidence/selectivity";

export interface DailySeries {
  key: string;
  /** session date → level (price, index, yield %) — ascending by date */
  points: Array<{ date: string; value: number }>;
  isYield?: boolean;
  /** true when the instrument closes before India's close on the same date (Asia / India). */
  sameDayUsable: boolean;
}

export interface ShockDefinition {
  driver: string;
  label: string;
  window: number; // sessions
  threshold: number; // % for prices, bps for yields
  direction: "UP" | "DOWN";
}

export const SHOCKS: ShockDefinition[] = [
  { driver: "US10Y", label: "US10Y rises ≥ 25 bps / 5 sessions", window: 5, threshold: 25, direction: "UP" },
  { driver: "US10Y", label: "US10Y falls ≥ 20 bps / 5 sessions", window: 5, threshold: 20, direction: "DOWN" },
  { driver: "DXY", label: "DXY rises ≥ 1.5% / 5 sessions", window: 5, threshold: 1.5, direction: "UP" },
  { driver: "BRENT", label: "Brent rises ≥ 8% / 5 sessions", window: 5, threshold: 8, direction: "UP" },
  { driver: "BRENT", label: "Brent falls ≥ 8% / 5 sessions", window: 5, threshold: 8, direction: "DOWN" },
  { driver: "VIX", label: "VIX rises ≥ 30% / 5 sessions", window: 5, threshold: 30, direction: "UP" },
  { driver: "NDX", label: "Nasdaq 100 falls ≥ 4% / 5 sessions", window: 5, threshold: 4, direction: "DOWN" },
  { driver: "SPX", label: "S&P 500 falls ≥ 3% / 5 sessions", window: 5, threshold: 3, direction: "DOWN" },
  { driver: "SPX", label: "S&P 500 rises ≥ 3% / 5 sessions", window: 5, threshold: 3, direction: "UP" },
  { driver: "ASIA", label: "Asia (Nikkei+HSI avg) falls ≥ 4% / 5 sessions", window: 5, threshold: 4, direction: "DOWN" },
  { driver: "GOLD", label: "Gold rises ≥ 5% / 5 sessions", window: 5, threshold: 5, direction: "UP" },
  { driver: "USDINR", label: "USD/INR rises ≥ 1.5% / 5 sessions", window: 5, threshold: 1.5, direction: "UP" },
];
export const HORIZONS = [1, 3, 5, 10];
export const MIN_SHOCK_N = 20;
export const MIN_CORR_N = 100;
export const STUDY_VERSION = "global-relationships-v1";

export interface ShockStudyResult {
  driver: string;
  shock: string;
  target: string;
  horizon: number;
  n: number;
  meanPct: number | null;
  medianPct: number | null;
  winRatePct: number | null;
  wilsonLb95Pct: number | null;
  volPct: number | null;
  maxDrawdownPct: number | null;
  benchmarkMeanPct: number | null;
  benchmarkN: number;
  displayable: boolean;
  dates: string[];
  dataFrom: string | null;
  dataTo: string | null;
}

const r4 = (v: number): number => Math.round(v * 10000) / 10000;
const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
const median = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sd = (a: number[]): number => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((x, v) => x + (v - m) ** 2, 0) / (a.length - 1));
};

/** Latest driver session usable at India's close on indiaDate. */
export function usableIndex(driver: DailySeries, indiaDate: string, from = 0): number {
  let idx = -1;
  for (let i = from; i < driver.points.length; i++) {
    const d = driver.points[i].date;
    if (driver.sameDayUsable ? d <= indiaDate : d < indiaDate) idx = i;
    else break;
  }
  return idx;
}

/** Driver change over `window` sessions ending at the usable index (pct for prices, bps for yields). */
export function driverChange(driver: DailySeries, idx: number, window: number): number | null {
  if (idx < window) return null;
  const a = driver.points[idx - window].value, b = driver.points[idx].value;
  if (driver.isYield) return (b - a) * 100;
  return a > 0 ? ((b - a) / a) * 100 : null;
}

/** Forward return of target from India close T to T+h, in %. */
function forward(target: DailySeries, i: number, h: number): number | null {
  if (i + h >= target.points.length) return null;
  const a = target.points[i].value, b = target.points[i + h].value;
  return a > 0 ? ((b - a) / a) * 100 : null;
}
function maxDrawdownForward(target: DailySeries, i: number, h: number): number | null {
  if (i + h >= target.points.length) return null;
  const a = target.points[i].value;
  let mdd = 0;
  for (let k = 1; k <= h; k++) mdd = Math.min(mdd, ((target.points[i + k].value - a) / a) * 100);
  return mdd;
}

/**
 * Run one shock study against one target over all horizons. Events are
 * de-overlapped: after a trigger on T, the next trigger must be ≥ `window`
 * sessions later, so observations are not the same move counted five times.
 */
export function shockStudy(shock: ShockDefinition, driver: DailySeries, target: DailySeries, horizons = HORIZONS): ShockStudyResult[] {
  const triggers: number[] = [];
  let lastTrigger = -Infinity;
  let cursor = 0;
  for (let i = 0; i < target.points.length; i++) {
    const idx = usableIndex(driver, target.points[i].date, cursor);
    if (idx < 0) continue;
    cursor = Math.max(0, idx - shock.window - 1);
    const chg = driverChange(driver, idx, shock.window);
    if (chg == null) continue;
    const hit = shock.direction === "UP" ? chg >= shock.threshold : chg <= -shock.threshold;
    if (hit && i - lastTrigger >= shock.window) {
      triggers.push(i);
      lastTrigger = i;
    }
  }
  const out: ShockStudyResult[] = [];
  for (const h of horizons) {
    const rets: number[] = [];
    const mdds: number[] = [];
    const dates: string[] = [];
    for (const i of triggers) {
      const r = forward(target, i, h);
      if (r == null) continue;
      rets.push(r);
      dates.push(target.points[i].date);
      const m = maxDrawdownForward(target, i, h);
      if (m != null) mdds.push(m);
    }
    // Unconditional benchmark over the same horizon (all non-overlapping starts).
    const bench: number[] = [];
    for (let i = 0; i + h < target.points.length; i += h) {
      const r = forward(target, i, h);
      if (r != null) bench.push(r);
    }
    const n = rets.length;
    const wins = rets.filter((v) => v > 0).length;
    out.push({
      driver: shock.driver,
      shock: shock.label,
      target: target.key,
      horizon: h,
      n,
      meanPct: n ? r4(mean(rets)) : null,
      medianPct: n ? r4(median(rets)) : null,
      winRatePct: n ? r4((wins / n) * 100) : null,
      wilsonLb95Pct: n ? r4((wilsonLb95(wins, n) ?? 0) * 100) : null,
      volPct: n ? r4(sd(rets)) : null,
      maxDrawdownPct: mdds.length ? r4(mean(mdds)) : null,
      benchmarkMeanPct: bench.length ? r4(mean(bench)) : null,
      benchmarkN: bench.length,
      displayable: n >= MIN_SHOCK_N,
      dates,
      dataFrom: target.points[0]?.date ?? null,
      dataTo: target.points[target.points.length - 1]?.date ?? null,
    });
  }
  return out;
}

/** Composite driver (e.g. ASIA = equal-weight Nikkei + HSI) from member series. */
export function compositeSeries(key: string, members: DailySeries[], sameDayUsable: boolean): DailySeries {
  const dates = new Map<string, number[]>();
  for (const m of members) {
    let prev: number | null = null;
    for (const p of m.points) {
      if (prev != null && prev > 0) dates.set(p.date, [...(dates.get(p.date) ?? []), p.value / prev - 1]);
      prev = p.value;
    }
  }
  let level = 100;
  const points = [...dates.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, rs]) => {
    level *= 1 + mean(rs);
    return { date, value: level };
  });
  return { key, points, sameDayUsable };
}

export interface SensitivityResult {
  driver: string;
  target: string;
  n: number;
  correlation: number | null;
  beta: number | null;
  displayable: boolean;
  window: number;
  note: string;
}

/** Correlation/beta of target 5-session forward returns vs driver 5-session changes known at India close (lag-aligned). */
export function sectorSensitivity(driver: DailySeries, target: DailySeries, window = 5): SensitivityResult {
  const xs: number[] = [];
  const ys: number[] = [];
  let cursor = 0;
  for (let i = 0; i + window < target.points.length; i += window) {
    const idx = usableIndex(driver, target.points[i].date, cursor);
    if (idx < 0) continue;
    cursor = Math.max(0, idx - window - 1);
    const x = driverChange(driver, idx, window);
    const y = forward(target, i, window);
    if (x == null || y == null) continue;
    xs.push(x);
    ys.push(y);
  }
  const n = xs.length;
  if (n < 10) return { driver: driver.key, target: target.key, n, correlation: null, beta: null, displayable: false, window, note: "insufficient overlapping observations" };
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  const corr = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
  const beta = sxx > 0 ? sxy / sxx : null;
  return { driver: driver.key, target: target.key, n, correlation: corr != null ? r4(corr) : null, beta: beta != null ? r4(beta) : null, displayable: n >= MIN_CORR_N / window, window, note: `non-overlapping ${window}-session blocks; driver change known at India's close; measured association, not causation` };
}

export type Transmission = "TAILWIND" | "NEUTRAL" | "HEADWIND" | "STRESS";

/** Combine the active shocks' displayable 5-session NIFTY evidence into a transmission label with reasons. */
export function transmissionFromActiveShocks(active: Array<{ shock: ShockDefinition; study: ShockStudyResult | undefined }>): { label: Transmission; reasons: string[]; evidence: Array<{ shock: string; n: number; medianPct: number | null; winRatePct: number | null; benchmarkMeanPct: number | null }> } {
  const evidence = active.map((a) => ({ shock: a.shock.label, n: a.study?.n ?? 0, medianPct: a.study?.medianPct ?? null, winRatePct: a.study?.winRatePct ?? null, benchmarkMeanPct: a.study?.benchmarkMeanPct ?? null }));
  const usable = active.filter((a) => a.study && a.study.displayable);
  if (!active.length) return { label: "NEUTRAL", reasons: ["no global shock is active (all drivers inside their 5-session thresholds)"], evidence };
  if (!usable.length) return { label: "NEUTRAL", reasons: [`${active.length} shock(s) active but none has ≥ ${MIN_SHOCK_N} historical observations — no transmission claim is made`], evidence };
  let neg = 0, pos = 0;
  const reasons: string[] = [];
  for (const a of usable) {
    const s = a.study as ShockStudyResult;
    const edge = (s.medianPct as number) - (s.benchmarkMeanPct ?? 0);
    if (edge <= -0.5 || (s.winRatePct as number) < 40) neg += 1;
    else if (edge >= 0.5 && (s.winRatePct as number) > 55) pos += 1;
    reasons.push(`${s.shock}: NIFTY 5-session median ${s.medianPct}% vs unconditional ${s.benchmarkMeanPct}%, win rate ${s.winRatePct}% (n=${s.n})`);
  }
  const label: Transmission = neg >= 3 ? "STRESS" : neg > pos ? "HEADWIND" : pos > neg ? "TAILWIND" : "NEUTRAL";
  return { label, reasons, evidence };
}
