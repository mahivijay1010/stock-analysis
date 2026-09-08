/**
 * Short-term feature engine (S3) — PURE, computed on COMPLETED daily bars
 * (adjusted-close policy) with the same zero-lookahead discipline as the
 * research layer: features at index i use bars ≤ i only.
 */

import { Bar } from "../market/types";
import { analysisCloses } from "../market/canonical";

export interface ShortTermFeatures {
  asOfDate: string;
  price: number;
  r1: number | null;
  r3: number | null;
  r5: number | null;
  r10: number | null;
  r20: number | null;
  relNifty5: number | null;
  relNifty20: number | null;
  relSector20: number | null;
  rsi14: number | null;
  macdHist: number | null;
  atr14: number | null;
  atrPct: number | null;
  adx14: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  ema20: number | null;
  distSma20Pct: number | null;
  distSma50Pct: number | null;
  distSma200Pct: number | null;
  week52Pct: number | null;
  gapPct: number | null;
  relVolume: number | null;
  volumeAccel: number | null; // 5d avg vs 20d avg
  volPriceConfirm: number | null; // corr(sign(ret), relVol) proxy over 10 bars
  realizedVol20AnnPct: number | null;
  drawdownFrom20dHighPct: number | null;
  breakoutDistPct: number | null; // distance to 20d high (negative = below)
  supportDistPct: number | null; // distance to nearest swing low (last 40 bars)
  resistanceDistPct: number | null; // distance to nearest swing high above
  trendPersist10: number | null;
  contraction: number | null; // ATR5/ATR20 — < 0.75 = volatility contraction
  advInr20: number | null; // 20d average daily traded value ₹
  zeroVolumeBars20: number;
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  if (gain + loss === 0) return 50;
  return 100 * (gain / (gain + loss));
}

function emaSeries(xs: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let e = xs[0];
  for (const x of xs) {
    e = x * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

function trueRanges(bars: Bar[], closes: number[]): number[] {
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    trs.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - closes[i - 1]), Math.abs(bars[i].low - closes[i - 1])));
  }
  return trs;
}

function atrAt(trs: number[], endIdx: number, period: number): number | null {
  // endIdx indexes trs (= bar index − 1)
  if (endIdx - period + 1 < 0) return null;
  return mean(trs.slice(endIdx - period + 1, endIdx + 1));
}

function adx14(bars: Bar[], closes: number[]): number | null {
  const n = bars.length;
  if (n < 30) return null;
  const period = 14;
  const dmPlus: number[] = [];
  const dmMinus: number[] = [];
  const trs = trueRanges(bars, closes);
  for (let i = 1; i < n; i++) {
    const up = bars[i].high - bars[i - 1].high;
    const dn = bars[i - 1].low - bars[i].low;
    dmPlus.push(up > dn && up > 0 ? up : 0);
    dmMinus.push(dn > up && dn > 0 ? dn : 0);
  }
  const dxs: number[] = [];
  for (let i = period - 1; i < trs.length; i++) {
    const trS = mean(trs.slice(i - period + 1, i + 1));
    if (trS <= 0) continue;
    const diP = (mean(dmPlus.slice(i - period + 1, i + 1)) / trS) * 100;
    const diM = (mean(dmMinus.slice(i - period + 1, i + 1)) / trS) * 100;
    if (diP + diM === 0) continue;
    dxs.push((Math.abs(diP - diM) / (diP + diM)) * 100);
  }
  if (dxs.length < period) return null;
  return mean(dxs.slice(-period));
}

/** Swing lows/highs: local extremes with 2-bar flanks over the last `window` bars. */
function swings(bars: Bar[], window: number): { lows: number[]; highs: number[] } {
  const start = Math.max(2, bars.length - window);
  const lows: number[] = [];
  const highs: number[] = [];
  for (let i = start; i < bars.length - 2; i++) {
    if (bars[i].low < bars[i - 1].low && bars[i].low < bars[i - 2].low && bars[i].low < bars[i + 1].low && bars[i].low < bars[i + 2].low)
      lows.push(bars[i].low);
    if (bars[i].high > bars[i - 1].high && bars[i].high > bars[i - 2].high && bars[i].high > bars[i + 1].high && bars[i].high > bars[i + 2].high)
      highs.push(bars[i].high);
  }
  return { lows, highs };
}

export function computeShortTermFeatures(
  bars: Bar[],
  niftyCloses: Map<string, number>,
  sectorIndex: Map<string, number> | null
): ShortTermFeatures | null {
  if (bars.length < 60) return null;
  const closes = analysisCloses(bars);
  const i = bars.length - 1;
  const price = closes[i];
  if (!(price > 0)) return null;

  const ret = (n: number): number | null => (i - n >= 0 && closes[i - n] > 0 ? closes[i] / closes[i - n] - 1 : null);
  const sma = (n: number): number | null => (i - n + 1 >= 0 ? mean(closes.slice(i - n + 1, i + 1)) : null);
  const dist = (v: number | null): number | null => (v != null && v > 0 ? ((price - v) / v) * 100 : null);

  const trs = trueRanges(bars, closes);
  const atr14v = atrAt(trs, i - 1, 14);
  const atr5 = atrAt(trs, i - 1, 5);
  const atr20 = atrAt(trs, i - 1, 20);

  const rets: number[] = [];
  for (let k = Math.max(1, i - 19); k <= i; k++) if (closes[k - 1] > 0) rets.push(closes[k] / closes[k - 1] - 1);
  const vol20 = rets.length >= 10 ? Math.sqrt(rets.reduce((a, r) => a + r * r, 0) / rets.length) * Math.sqrt(252) * 100 : null;

  const year = closes.slice(Math.max(0, i - 251), i + 1);
  const hi52 = Math.max(...year);
  const lo52 = Math.min(...year);
  const high20 = Math.max(...closes.slice(Math.max(0, i - 19), i + 1));

  const vols = bars.slice(Math.max(0, i - 20), i).map((b) => b.volume).filter((v) => v > 0);
  const volAvg20 = vols.length >= 10 ? mean(vols) : null;
  const vols5 = bars.slice(Math.max(0, i - 5), i).map((b) => b.volume).filter((v) => v > 0);
  const volAvg5 = vols5.length >= 3 ? mean(vols5) : null;
  const relVolume = volAvg20 != null && volAvg20 > 0 && bars[i].volume > 0 ? bars[i].volume / volAvg20 : null;

  // volume-price confirmation: do up-moves come with above-average volume?
  let vpc: number | null = null;
  if (volAvg20 != null && volAvg20 > 0) {
    let agree = 0;
    let count = 0;
    for (let k = i - 9; k <= i; k++) {
      if (k < 1 || bars[k].volume <= 0) continue;
      const up = closes[k] > closes[k - 1];
      const highVol = bars[k].volume > volAvg20;
      if (up === highVol) agree++;
      count++;
    }
    vpc = count >= 6 ? agree / count : null;
  }

  const niftyRet = (n: number): number | null => {
    const now = niftyCloses.get(bars[i].date);
    const then = niftyCloses.get(bars[i - n]?.date ?? "");
    return now != null && then != null && then > 0 ? now / then - 1 : null;
  };
  const sectorRet20 = (() => {
    if (!sectorIndex) return null;
    const now = sectorIndex.get(bars[i].date);
    const then = sectorIndex.get(bars[i - 20]?.date ?? "");
    return now != null && then != null && then > 0 ? now / then - 1 : null;
  })();

  const { lows, highs } = swings(bars, 40);
  const nearestSupport = lows.filter((l) => l < price).sort((a, b) => b - a)[0] ?? null;
  const nearestResistance = highs.filter((h) => h > price).sort((a, b) => a - b)[0] ?? null;

  const upDays = closes.slice(Math.max(1, i - 9), i + 1).filter((c, idx, arr) => (idx === 0 ? c > closes[Math.max(0, i - 10)] : c > arr[idx - 1])).length;

  const macd = (() => {
    if (closes.length < 35) return null;
    const e12 = emaSeries(closes, 12);
    const e26 = emaSeries(closes, 26);
    const line = e12.map((v, k) => v - e26[k]);
    const signal = emaSeries(line.slice(26), 9);
    return line[line.length - 1] - signal[signal.length - 1];
  })();

  const r5 = ret(5);
  const n5 = niftyRet(5);
  const r20 = ret(20);
  const n20 = niftyRet(20);

  return {
    asOfDate: bars[i].date,
    price,
    r1: ret(1),
    r3: ret(3),
    r5,
    r10: ret(10),
    r20,
    relNifty5: r5 != null && n5 != null ? r5 - n5 : null,
    relNifty20: r20 != null && n20 != null ? r20 - n20 : null,
    relSector20: r20 != null && sectorRet20 != null ? r20 - sectorRet20 : null,
    rsi14: rsi(closes),
    macdHist: macd,
    atr14: atr14v,
    atrPct: atr14v != null ? (atr14v / price) * 100 : null,
    adx14: adx14(bars, closes),
    sma20: sma(20),
    sma50: sma(50),
    sma200: sma(200),
    ema20: closes.length >= 20 ? emaSeries(closes, 20)[closes.length - 1] : null,
    distSma20Pct: dist(sma(20)),
    distSma50Pct: dist(sma(50)),
    distSma200Pct: dist(sma(200)),
    week52Pct: hi52 > lo52 ? ((price - lo52) / (hi52 - lo52)) * 100 : null,
    gapPct: bars[i].open > 0 && closes[i - 1] > 0 ? (bars[i].open / closes[i - 1] - 1) * 100 : null,
    relVolume,
    volumeAccel: volAvg5 != null && volAvg20 != null && volAvg20 > 0 ? volAvg5 / volAvg20 : null,
    volPriceConfirm: vpc,
    realizedVol20AnnPct: vol20,
    drawdownFrom20dHighPct: high20 > 0 ? ((price - high20) / high20) * 100 : null,
    breakoutDistPct: high20 > 0 ? ((price - high20) / high20) * 100 : null,
    supportDistPct: nearestSupport != null ? ((price - nearestSupport) / price) * 100 : null,
    resistanceDistPct: nearestResistance != null ? ((nearestResistance - price) / price) * 100 : null,
    trendPersist10: upDays / 10,
    contraction: atr5 != null && atr20 != null && atr20 > 0 ? atr5 / atr20 : null,
    advInr20: volAvg20 != null ? volAvg20 * price : null,
    zeroVolumeBars20: bars.slice(Math.max(0, i - 19), i + 1).filter((b) => !(b.volume > 0)).length,
  };
}
