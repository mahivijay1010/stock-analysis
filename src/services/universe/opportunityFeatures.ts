/**
 * Stage-1 opportunity features — pure, cheap, computed from a close/volume
 * series (the exchange delivery feed covers every EQ symbol; it has no OHLC,
 * so ATR here is a close-to-close PROXY and is labelled as such). Every number
 * is descriptive. The technicalScore and liquidityScore are evidence
 * dimensions for ordering the research budget — never a prediction.
 *
 * Leakage rule: the series must end at the scan's as-of date; nothing after
 * `asOf` may be present. The caller slices; this module asserts.
 */

export interface SeriesPoint {
  date: string;
  close: number;
  volume: number;
  valueInr: number;
  delivPct: number | null;
}

export interface StageOneFeatures {
  asOf: string;
  price: number;
  sessions: number;
  r5Pct: number;
  r20Pct: number;
  r60Pct: number;
  r120Pct: number;
  relNifty20Pct: number | null;
  relNifty60Pct: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  distSma20Pct: number | null;
  distSma50Pct: number | null;
  distSma200Pct: number | null;
  trend: "UP" | "DOWN" | "SIDEWAYS" | "UNKNOWN";
  realizedVol20AnnPct: number;
  /** Mean |close-to-close move| over 14 sessions as % — a PROXY for ATR%, not true range. */
  atrProxyPct: number;
  gapPct: number; // last close-to-close move
  volumeRatio20: number | null; // last volume / 20-session mean
  relVolume5v60: number | null; // 5-session mean volume / 60-session mean
  medianValue20Inr: number;
  delivPct20: number | null;
  high52: number;
  low52: number;
  pos52wPct: number; // 0..100
  breakout55: boolean; // close ≥ prior 55-session high
  pullbackFrom20dHighPct: number; // ≤ 0
  maxDrawdown120Pct: number;
  closeOnly: true;
}

export type OpportunitySignal = "BREAKOUT" | "PULLBACK" | "MOMENTUM" | "UNUSUAL_VOLUME" | "GAP" | "MEAN_REVERSION" | "NEAR_52W_HIGH" | "HIGH_DELIVERY";

const r2 = (v: number): number => Math.round(v * 100) / 100;
const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a: number[]): number => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sma = (closes: number[], n: number): number | null => (closes.length >= n ? mean(closes.slice(-n)) : null);
const pct = (from: number, to: number): number => (from > 0 ? ((to - from) / from) * 100 : 0);

export function computeStageOneFeatures(series: SeriesPoint[], asOf: string, nifty: Map<string, number> | null): StageOneFeatures | null {
  const s = series.filter((p) => p.date <= asOf && p.close > 0);
  if (s.length < 60) return null;
  if (series.some((p) => p.date > asOf)) throw new Error(`leakage: series contains points after asOf ${asOf}`);
  const closes = s.map((p) => p.close);
  const n = closes.length;
  const last = s[n - 1];
  const retN = (k: number) => (n > k ? pct(closes[n - 1 - k], closes[n - 1]) : 0);
  const lr: number[] = [];
  for (let i = Math.max(1, n - 20); i < n; i++) lr.push(Math.log(closes[i] / closes[i - 1]));
  const vol = Math.sqrt(lr.reduce((a, v) => a + (v - mean(lr)) ** 2, 0) / Math.max(1, lr.length - 1)) * Math.sqrt(252) * 100;
  const absMoves: number[] = [];
  for (let i = Math.max(1, n - 14); i < n; i++) absMoves.push(Math.abs(pct(closes[i - 1], closes[i])));
  const sma20 = sma(closes, 20), sma50 = sma(closes, 50), sma200 = sma(closes, 200);
  const dist = (m: number | null) => (m != null ? r2(pct(m, last.close)) : null);
  const trend: StageOneFeatures["trend"] =
    sma50 == null || sma200 == null ? "UNKNOWN" : last.close > sma50 && sma50 > sma200 ? "UP" : last.close < sma50 && sma50 < sma200 ? "DOWN" : "SIDEWAYS";
  const vols = s.map((p) => p.volume);
  const v20 = mean(vols.slice(-21, -1));
  const v60 = mean(vols.slice(-60));
  const v5 = mean(vols.slice(-5));
  const win252 = closes.slice(-252);
  const high52 = Math.max(...win252), low52 = Math.min(...win252);
  const prior55High = n > 56 ? Math.max(...closes.slice(-56, -1)) : Math.max(...closes.slice(0, -1));
  const high20 = Math.max(...closes.slice(-20));
  let peak = -Infinity, mdd = 0;
  for (const c of closes.slice(-120)) {
    peak = Math.max(peak, c);
    mdd = Math.min(mdd, pct(peak, c));
  }
  const niftyRel = (k: number): number | null => {
    if (!nifty) return null;
    const a = nifty.get(s[n - 1 - k]?.date ?? ""), b = nifty.get(last.date);
    if (a == null || b == null || a <= 0) return null;
    return r2(retN(k) - pct(a, b));
  };
  const deliv = s.slice(-20).map((p) => p.delivPct).filter((v): v is number => v != null);
  return {
    asOf: last.date,
    price: last.close,
    sessions: n,
    r5Pct: r2(retN(5)),
    r20Pct: r2(retN(20)),
    r60Pct: r2(retN(60)),
    r120Pct: r2(retN(120)),
    relNifty20Pct: niftyRel(20),
    relNifty60Pct: niftyRel(60),
    sma20: sma20 != null ? r2(sma20) : null,
    sma50: sma50 != null ? r2(sma50) : null,
    sma200: sma200 != null ? r2(sma200) : null,
    distSma20Pct: dist(sma20),
    distSma50Pct: dist(sma50),
    distSma200Pct: dist(sma200),
    trend,
    realizedVol20AnnPct: r2(vol),
    atrProxyPct: r2(mean(absMoves)),
    gapPct: r2(pct(closes[n - 2], closes[n - 1])),
    volumeRatio20: v20 > 0 ? r2(last.volume / v20) : null,
    relVolume5v60: v60 > 0 ? r2(v5 / v60) : null,
    medianValue20Inr: Math.round(median(s.slice(-20).map((p) => p.valueInr))),
    delivPct20: deliv.length ? r2(mean(deliv)) : null,
    high52: r2(high52),
    low52: r2(low52),
    pos52wPct: high52 > low52 ? r2(((last.close - low52) / (high52 - low52)) * 100) : 50,
    breakout55: last.close >= prior55High,
    pullbackFrom20dHighPct: r2(pct(high20, last.close)),
    maxDrawdown120Pct: r2(mdd),
    closeOnly: true,
  };
}

export function detectSignals(f: StageOneFeatures): OpportunitySignal[] {
  const out: OpportunitySignal[] = [];
  if (f.breakout55 && (f.volumeRatio20 ?? 0) >= 1.3) out.push("BREAKOUT");
  if (f.trend === "UP" && f.pullbackFrom20dHighPct <= -2 && f.pullbackFrom20dHighPct >= -9 && Math.abs(f.distSma20Pct ?? 99) <= 4) out.push("PULLBACK");
  if (f.trend === "UP" && (f.relNifty20Pct ?? 0) > 2 && f.r5Pct > 0 && (f.distSma20Pct ?? 99) <= 6) out.push("MOMENTUM");
  if ((f.volumeRatio20 ?? 0) >= 2.5) out.push("UNUSUAL_VOLUME");
  if (Math.abs(f.gapPct) >= 4) out.push("GAP");
  if (f.trend !== "UP" && (f.distSma200Pct ?? -99) > -8 && f.pullbackFrom20dHighPct < -8) out.push("MEAN_REVERSION");
  if (f.pos52wPct >= 90) out.push("NEAR_52W_HIGH");
  if ((f.delivPct20 ?? 0) >= 60) out.push("HIGH_DELIVERY");
  return out;
}

/** Descriptive technical evidence (0–100): trend structure, relative strength, orderly volatility, participation. Not a prediction. */
export function technicalScore(f: StageOneFeatures): number {
  let s = 0;
  if (f.trend === "UP") s += 30;
  else if (f.trend === "SIDEWAYS") s += 12;
  const rel = f.relNifty60Pct ?? 0;
  s += Math.max(0, Math.min(20, 10 + rel / 2));
  const vol = f.realizedVol20AnnPct;
  s += vol >= 18 && vol <= 45 ? 15 : vol < 18 ? 8 : vol <= 60 ? 6 : 0;
  s += Math.max(0, Math.min(15, (f.pos52wPct / 100) * 15));
  const vr = f.volumeRatio20 ?? 1;
  s += vr >= 1 && vr <= 3 ? 10 : vr > 3 ? 5 : 4;
  s += Math.max(0, Math.min(10, 10 + f.maxDrawdown120Pct / 4));
  return r2(Math.max(0, Math.min(100, s)));
}

export function liquidityScore(medianValue20Inr: number, delivPct20: number | null): number {
  let s = 0;
  if (medianValue20Inr >= 5e8) s = 70;
  else if (medianValue20Inr >= 1e8) s = 55;
  else if (medianValue20Inr >= 2e7) s = 35;
  else if (medianValue20Inr >= 5e6) s = 15;
  if (delivPct20 != null) s += Math.min(30, delivPct20 / 2);
  return r2(Math.min(100, s));
}

/** Risk dimension from the stage-1 view alone (higher = riskier). */
export function riskScore(f: StageOneFeatures): number {
  let s = 0;
  s += Math.min(40, Math.max(0, (f.realizedVol20AnnPct - 20) * 1.2));
  s += Math.min(25, Math.abs(f.maxDrawdown120Pct) / 2);
  s += Math.min(20, Math.abs(f.gapPct) * 3);
  if (f.trend === "DOWN") s += 15;
  return r2(Math.min(100, s));
}
