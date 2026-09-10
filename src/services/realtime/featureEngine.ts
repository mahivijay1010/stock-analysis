/**
 * IncrementalFeatureEngine (reviewer #6) — numerical chart state the backend
 * "reads" (EMA/RSI/ATR/VWAP/relVol/range). Two entry points that MUST agree:
 *
 *  - computeFeatures(bars)  : PURE full recompute from scratch (reference).
 *  - IncrementalFeatureEngine: O(1)-ish per completed bar, for 151 stocks every
 *    checkpoint without re-scanning history.
 *
 * The recurrences are written so the incremental path performs the SAME float
 * operations in the SAME order as the full recompute — the parity test asserts
 * engine.snapshot() === computeFeatures(sameBars) exactly. relVol keeps its
 * bounded window as an array summed fresh (not a running sum with subtraction)
 * precisely so the two paths stay bit-identical.
 */

import { CompletedBar, LiveFeatures } from "./types";

const DAY_MS = 86_400_000;
const REL_VOL_WINDOW = 20;

function emaStep(prev: number, price: number, n: number): number {
  const k = 2 / (n + 1);
  return prev + k * (price - prev);
}
function typical(b: CompletedBar): number {
  return (b.high + b.low + b.close) / 3;
}
function trueRange(b: CompletedBar, prevClose: number | null): number {
  if (prevClose == null) return b.high - b.low;
  return Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
}

/** Reference implementation: recompute all features over the full bar series. */
export function computeFeatures(bars: CompletedBar[]): LiveFeatures {
  const empty: LiveFeatures = {
    ema9: null, ema21: null, ema50: null, rsi14: null, atr14: null,
    vwap: null, vwapDistancePct: null, relativeVolume: null, rangePct: null,
    lastClose: null, completedBars: 0,
  };
  if (bars.length === 0) return empty;

  // EMAs — seeded on the first close, same recurrence throughout.
  const ema = (n: number): number => {
    let e = bars[0].close;
    for (let i = 1; i < bars.length; i++) e = emaStep(e, bars[i].close, n);
    return e;
  };

  // RSI(14) Wilder — needs ≥15 closes (14 deltas).
  let rsi14: number | null = null;
  if (bars.length >= 15) {
    let gain = 0, loss = 0;
    for (let i = 1; i <= 14; i++) {
      const d = bars[i].close - bars[i - 1].close;
      if (d >= 0) gain += d; else loss += -d;
    }
    let avgGain = gain / 14, avgLoss = loss / 14;
    for (let i = 15; i < bars.length; i++) {
      const d = bars[i].close - bars[i - 1].close;
      avgGain = (avgGain * 13 + (d > 0 ? d : 0)) / 14;
      avgLoss = (avgLoss * 13 + (d < 0 ? -d : 0)) / 14;
    }
    rsi14 = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  // ATR(14) Wilder — needs ≥14 bars.
  let atr14: number | null = null;
  if (bars.length >= 14) {
    let sum = 0;
    for (let i = 0; i < 14; i++) sum += trueRange(bars[i], i === 0 ? null : bars[i - 1].close);
    let atr = sum / 14;
    for (let i = 14; i < bars.length; i++) atr = (atr * 13 + trueRange(bars[i], bars[i - 1].close)) / 14;
    atr14 = atr;
  }

  // VWAP — cumulative over the CURRENT session (day of the last bar).
  const lastDay = Math.floor(bars[bars.length - 1].startAt / DAY_MS);
  let pv = 0, vol = 0;
  for (const b of bars) {
    if (Math.floor(b.startAt / DAY_MS) !== lastDay) continue;
    pv += typical(b) * b.volume;
    vol += b.volume;
  }
  const vwap = vol > 0 ? pv / vol : null;

  const last = bars[bars.length - 1];
  const window = bars.slice(Math.max(0, bars.length - REL_VOL_WINDOW));
  const avgVol = window.reduce((s, b) => s + b.volume, 0) / window.length;
  const relativeVolume = avgVol > 0 ? last.volume / avgVol : null;

  return {
    ema9: ema(9), ema21: ema(21), ema50: ema(50),
    rsi14, atr14,
    vwap,
    vwapDistancePct: vwap != null && vwap > 0 ? ((last.close - vwap) / vwap) * 100 : null,
    relativeVolume,
    rangePct: last.open > 0 ? ((last.high - last.low) / last.open) * 100 : null,
    lastClose: last.close,
    completedBars: bars.length,
  };
}

/** Incremental engine — same math, maintained as bars complete. */
export class IncrementalFeatureEngine {
  private count = 0;
  private e9: number | null = null;
  private e21: number | null = null;
  private e50: number | null = null;
  private prevClose: number | null = null;

  private rsiSeedGain = 0;
  private rsiSeedLoss = 0;
  private avgGain: number | null = null;
  private avgLoss: number | null = null;

  private atr: number | null = null;
  private atrSeedSum = 0;

  private vwapDay: number | null = null;
  private vwapPv = 0;
  private vwapVol = 0;

  private volWindow: number[] = [];
  private last: CompletedBar | null = null;

  addBar(b: CompletedBar): void {
    const first = this.count === 0;
    // EMAs.
    if (first) { this.e9 = b.close; this.e21 = b.close; this.e50 = b.close; }
    else {
      this.e9 = emaStep(this.e9!, b.close, 9);
      this.e21 = emaStep(this.e21!, b.close, 21);
      this.e50 = emaStep(this.e50!, b.close, 50);
    }

    // RSI(14): accumulate the 14-delta seed, then Wilder.
    if (this.prevClose != null) {
      const d = b.close - this.prevClose;
      const deltaIndex = this.count; // delta i corresponds to bar index i (1-based over deltas)
      if (deltaIndex <= 14) {
        if (d >= 0) this.rsiSeedGain += d; else this.rsiSeedLoss += -d;
        if (deltaIndex === 14) { this.avgGain = this.rsiSeedGain / 14; this.avgLoss = this.rsiSeedLoss / 14; }
      } else {
        this.avgGain = (this.avgGain! * 13 + (d > 0 ? d : 0)) / 14;
        this.avgLoss = (this.avgLoss! * 13 + (d < 0 ? -d : 0)) / 14;
      }
    }

    // ATR(14): seed sum over first 14 TRs, then Wilder.
    const tr = trueRange(b, this.prevClose);
    if (this.count < 14) {
      this.atrSeedSum += tr;
      if (this.count === 13) this.atr = this.atrSeedSum / 14;
    } else {
      this.atr = (this.atr! * 13 + tr) / 14;
    }

    // VWAP: reset per session day.
    const day = Math.floor(b.startAt / DAY_MS);
    if (this.vwapDay !== day) { this.vwapDay = day; this.vwapPv = 0; this.vwapVol = 0; }
    this.vwapPv += typical(b) * b.volume;
    this.vwapVol += b.volume;

    // relVol window (bounded array, summed fresh → bit-identical to full recompute).
    this.volWindow.push(b.volume);
    if (this.volWindow.length > REL_VOL_WINDOW) this.volWindow.shift();

    this.prevClose = b.close;
    this.last = b;
    this.count += 1;
  }

  snapshot(): LiveFeatures {
    if (this.count === 0 || !this.last) {
      return { ema9: null, ema21: null, ema50: null, rsi14: null, atr14: null, vwap: null, vwapDistancePct: null, relativeVolume: null, rangePct: null, lastClose: null, completedBars: 0 };
    }
    const rsi14 = this.count >= 15 && this.avgGain != null && this.avgLoss != null
      ? (this.avgLoss === 0 ? 100 : 100 - 100 / (1 + this.avgGain / this.avgLoss))
      : null;
    const atr14 = this.count >= 14 ? this.atr : null;
    const vwap = this.vwapVol > 0 ? this.vwapPv / this.vwapVol : null;
    const avgVol = this.volWindow.reduce((s, v) => s + v, 0) / this.volWindow.length;
    const relativeVolume = avgVol > 0 ? this.last.volume / avgVol : null;
    return {
      ema9: this.e9, ema21: this.e21, ema50: this.e50,
      rsi14, atr14, vwap,
      vwapDistancePct: vwap != null && vwap > 0 ? ((this.last.close - vwap) / vwap) * 100 : null,
      relativeVolume,
      rangePct: this.last.open > 0 ? ((this.last.high - this.last.low) / this.last.open) * 100 : null,
      lastClose: this.last.close,
      completedBars: this.count,
    };
  }
}
