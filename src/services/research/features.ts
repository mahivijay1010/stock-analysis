/**
 * Zero-lookahead feature engineering (completion directive, Phase 3) — PURE.
 *
 * Every feature is computed strictly from bars[0..asOfIndex] (the prediction
 * day's completed close) and carries its own `availableAt` timestamp — the
 * close time of the latest session whose data it consumed. Backtests assert
 * `availableAt <= predictionTimestamp` for every feature, and the leakage
 * test suite asserts the stronger property: mutating any bar AFTER asOfIndex
 * must not change the feature vector at asOfIndex.
 *
 * Prices are the ANALYSIS series (adjustedClose ?? close, Phase 1) so
 * corporate actions cannot fabricate feature values. Missing inputs produce
 * value: null (never a silent 0).
 */

import { Bar } from "../market/types";
import { analysisCloses } from "../market/canonical";

export const FEATURE_VERSION = "features-v1";

export interface FeatureValue {
  value: number | null;
  /** ISO instant when this value became knowable (session close, 15:40 IST). */
  availableAt: string;
}

export interface FeatureVector {
  ticker: string;
  sessionDate: string; // as-of session (YYYY-MM-DD IST)
  predictionTimestamp: string; // ISO — that session's close
  featureVersion: string;
  features: Record<string, FeatureValue>;
}

/** Session close instant for an IST calendar date (15:40 = post-close settle). */
export function sessionCloseIso(date: string): string {
  return `${date}T15:40:00+05:30`;
}

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

function sma(xs: number[], n: number): number | null {
  if (xs.length < n) return null;
  let s = 0;
  for (let i = xs.length - n; i < xs.length; i++) s += xs[i];
  return s / n;
}

function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

function trailingReturn(closes: number[], n: number): number | null {
  if (closes.length < n + 1) return null;
  const prev = closes[closes.length - 1 - n];
  return prev > 0 ? closes[closes.length - 1] / prev - 1 : null;
}

function rsi14(closes: number[]): number | null {
  const n = 14;
  if (closes.length < n + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  if (gain + loss === 0) return 50;
  const rs = loss === 0 ? Infinity : gain / loss;
  return 100 - 100 / (1 + rs);
}

function atrPct(bars: Bar[], n = 14): number | null {
  if (bars.length < n + 1) return null;
  let sum = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    const prevClose = bars[i - 1].close;
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - prevClose),
      Math.abs(bars[i].low - prevClose)
    );
    sum += tr;
  }
  const price = bars[bars.length - 1].close;
  return price > 0 ? (sum / n / price) * 100 : null;
}

export interface FeatureContext {
  /** NIFTY bars up to (and including) the same as-of session — caller slices. */
  nifty?: Bar[] | null;
  /** India VIX bars up to the as-of session. */
  vix?: Bar[] | null;
  /** Sector 20d return (point-in-time) when the caller has it. */
  sectorReturn20?: number | null;
}

/**
 * Build the feature vector as of bars[asOfIndex]'s close. Throws when
 * asOfIndex is out of range — never silently uses a different day.
 */
export function buildFeatures(
  ticker: string,
  allBars: Bar[],
  asOfIndex: number,
  ctx: FeatureContext = {}
): FeatureVector {
  if (asOfIndex < 0 || asOfIndex >= allBars.length) {
    throw new Error(`buildFeatures: asOfIndex ${asOfIndex} out of range 0..${allBars.length - 1}`);
  }
  const bars = allBars.slice(0, asOfIndex + 1); // ← the ONLY window ever touched
  const sessionDate = bars[bars.length - 1].date;
  const predictionTimestamp = sessionCloseIso(sessionDate);
  const at = predictionTimestamp; // every stock feature becomes knowable at this close

  const closes = analysisCloses(bars);
  const price = closes[closes.length - 1];
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) rets.push(closes[i] / closes[i - 1] - 1);
  }

  const f: Record<string, FeatureValue> = {};
  const put = (name: string, value: number | null, availableAt: string = at) => {
    f[name] = { value: value != null && Number.isFinite(value) ? round6(value) : null, availableAt };
  };

  // ── stock: lagged returns / trend / momentum ──────────────────────────────
  for (const n of [1, 2, 3, 5, 10, 20, 60]) put(`ret_${n}d`, trailingReturn(closes, n));
  const s20 = sma(closes, 20);
  const s50 = sma(closes, 50);
  const s200 = sma(closes, 200);
  put("dist_sma20_pct", s20 != null && s20 > 0 ? ((price - s20) / s20) * 100 : null);
  put("dist_sma50_pct", s50 != null && s50 > 0 ? ((price - s50) / s50) * 100 : null);
  put("dist_sma200_pct", s200 != null && s200 > 0 ? ((price - s200) / s200) * 100 : null);
  put("rsi14", rsi14(closes));

  // MACD histogram (12/26/9 EMA), normalized by price.
  const ema = (xs: number[], n: number): number[] => {
    const k = 2 / (n + 1);
    const out: number[] = [];
    let prev = xs[0];
    for (const x of xs) {
      prev = x * k + prev * (1 - k);
      out.push(prev);
    }
    return out;
  };
  if (closes.length >= 35 && price > 0) {
    const macdLine = ema(closes, 12).map((v, i) => v - ema(closes, 26)[i]);
    const signal = ema(macdLine, 9);
    put("macd_hist_norm", (macdLine[macdLine.length - 1] - signal[signal.length - 1]) / price);
  } else put("macd_hist_norm", null);

  put("atr14_pct", atrPct(bars));
  const vol20 = stdev(rets.slice(-20));
  put("realized_vol20_ann_pct", vol20 != null ? vol20 * Math.sqrt(252) * 100 : null);

  // Bollinger %B (20, 2σ)
  const sd20 = stdev(closes.slice(-20));
  put(
    "bollinger_pct_b",
    s20 != null && sd20 != null && sd20 > 0 ? (price - (s20 - 2 * sd20)) / (4 * sd20) : null
  );

  // drawdown from 1y high; 52wk percentile
  const yearCloses = closes.slice(-252);
  const yearHigh = Math.max(...yearCloses);
  const yearLow = Math.min(...yearCloses);
  put("drawdown_from_1y_high_pct", yearHigh > 0 ? ((price - yearHigh) / yearHigh) * 100 : null);
  put(
    "week52_position_pct",
    yearHigh > yearLow ? ((price - yearLow) / (yearHigh - yearLow)) * 100 : null
  );

  // volume ratio (missing volume = null, never 0 — Phase 1 honesty)
  const vols = bars.slice(-21).map((b) => b.volume);
  const positive = vols.slice(0, -1).filter((v) => v > 0);
  const todayVol = vols[vols.length - 1];
  put(
    "volume_ratio_20d",
    positive.length >= 10 && todayVol > 0
      ? todayVol / (positive.reduce((a, b) => a + b, 0) / positive.length)
      : null
  );

  // gap: today's open vs yesterday's close (raw prices — same-scale pair)
  put(
    "gap_open_pct",
    bars.length >= 2 && bars[bars.length - 2].close > 0
      ? ((bars[bars.length - 1].open - bars[bars.length - 2].close) / bars[bars.length - 2].close) * 100
      : null
  );

  // ── market features (availableAt = the NIFTY/VIX session used) ───────────
  const nifty = (ctx.nifty ?? []).filter((b) => b.date <= sessionDate);
  if (nifty.length > 0) {
    const nAt = sessionCloseIso(nifty[nifty.length - 1].date);
    const nCloses = analysisCloses(nifty);
    put("nifty_ret_5d", trailingReturn(nCloses, 5), nAt);
    put("nifty_ret_20d", trailingReturn(nCloses, 20), nAt);
    const n50 = sma(nCloses, 50);
    const n200 = sma(nCloses, 200);
    const nPrice = nCloses[nCloses.length - 1];
    put("nifty_dist_sma50_pct", n50 != null && n50 > 0 ? ((nPrice - n50) / n50) * 100 : null, nAt);
    put("nifty_dist_sma200_pct", n200 != null && n200 > 0 ? ((nPrice - n200) / n200) * 100 : null, nAt);
    const nRets: number[] = [];
    for (let i = 1; i < nCloses.length; i++) if (nCloses[i - 1] > 0) nRets.push(nCloses[i] / nCloses[i - 1] - 1);
    const nVol = stdev(nRets.slice(-20));
    put("nifty_vol20_ann_pct", nVol != null ? nVol * Math.sqrt(252) * 100 : null, nAt);
    // relative strength: stock r20 − NIFTY r20 (pp)
    const stockR20 = trailingReturn(closes, 20);
    const niftyR20 = trailingReturn(nCloses, 20);
    put(
      "rel_strength_20d_pp",
      stockR20 != null && niftyR20 != null ? (stockR20 - niftyR20) * 100 : null,
      nAt
    );
  } else {
    for (const name of [
      "nifty_ret_5d",
      "nifty_ret_20d",
      "nifty_dist_sma50_pct",
      "nifty_dist_sma200_pct",
      "nifty_vol20_ann_pct",
      "rel_strength_20d_pp",
    ])
      put(name, null);
  }

  const vix = (ctx.vix ?? []).filter((b) => b.date <= sessionDate);
  if (vix.length > 0) {
    const vAt = sessionCloseIso(vix[vix.length - 1].date);
    const vCloses = vix.map((b) => b.close);
    const vNow = vCloses[vCloses.length - 1];
    put("vix_level", vNow, vAt);
    const year = vCloses.slice(-252);
    const below = year.filter((v) => v < vNow).length;
    put("vix_percentile_1y", year.length >= 60 ? (below / year.length) * 100 : null, vAt);
  } else {
    put("vix_level", null);
    put("vix_percentile_1y", null);
  }

  // sector (only when the caller supplies a point-in-time value)
  put("sector_ret_20d_pct", ctx.sectorReturn20 != null ? ctx.sectorReturn20 * 100 : null);

  return { ticker, sessionDate, predictionTimestamp, featureVersion: FEATURE_VERSION, features: f };
}

/** Hard leakage guard: every feature must be knowable at prediction time. */
export function assertNoLookahead(fv: FeatureVector): void {
  for (const [name, v] of Object.entries(fv.features)) {
    if (v.availableAt > fv.predictionTimestamp) {
      throw new Error(
        `LOOKAHEAD LEAK: feature "${name}" availableAt ${v.availableAt} > predictionTimestamp ${fv.predictionTimestamp}`
      );
    }
  }
}
