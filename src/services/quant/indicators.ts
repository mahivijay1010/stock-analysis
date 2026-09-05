/**
 * Module 2 — pure technical-indicator functions.
 * All functions handle short input arrays by returning null (scalars) or
 * empty/null-padded arrays (series). No output is ever NaN.
 */

import { Bar } from './types';

/** Simple moving average of the LAST `period` values. Null if not enough data. */
export function sma(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

/** Full SMA series aligned to `values` (null until the window fills). */
export function smaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Full EMA series aligned to `values` (seeded with the SMA of the first `period` values). */
export function emaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Latest EMA value. Null if not enough data. */
export function ema(values: number[], period: number): number | null {
  const series = emaSeries(values, period);
  const last = series.length ? series[series.length - 1] : null;
  return last === undefined ? null : last;
}

/**
 * RSI with Wilder smoothing. Seed = simple average of the first `period` gains/losses,
 * then Wilder-smoothed through the end of the series. Null if fewer than period+1 values.
 * Flat series (no gains, no losses) → 50 (neutral), never NaN.
 */
export function rsi(values: number[], period = 14): number | null {
  if (period <= 0 || values.length < period + 1) return null;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gainSum += d;
    else lossSum -= d;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** MACD(12,26,9). Null if fewer than slow+signalPeriod-1 (=34 by default) values. */
export function macd(
  values: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9
): { line: number; signal: number; histogram: number } | null {
  if (values.length < slow + signalPeriod - 1) return null;
  const fastSeries = emaSeries(values, fast);
  const slowSeries = emaSeries(values, slow);
  const macdLine: number[] = [];
  for (let i = slow - 1; i < values.length; i++) {
    macdLine.push((fastSeries[i] as number) - (slowSeries[i] as number));
  }
  const signalSeries = emaSeries(macdLine, signalPeriod);
  const line = macdLine[macdLine.length - 1];
  const signal = signalSeries[signalSeries.length - 1];
  if (signal === null || signal === undefined) return null;
  return { line, signal, histogram: line - signal };
}

/**
 * Bollinger bands (20, 2) over the LAST `period` values, using population std dev
 * (the classic Bollinger definition). percentB is 0..1-ish: 0 = at lower band,
 * 1 = at upper band (can exceed [0,1] when price is outside the bands).
 * Degenerate flat window (upper === lower) → percentB 0.5, never NaN.
 */
export function bollinger(
  values: number[],
  period = 20,
  mult = 2
): { upper: number; middle: number; lower: number; percentB: number } | null {
  if (period <= 0 || values.length < period) return null;
  const win = values.slice(-period);
  const middle = win.reduce((a, b) => a + b, 0) / period;
  const variance = win.reduce((a, b) => a + (b - middle) * (b - middle), 0) / period;
  const sd = Math.sqrt(variance);
  const upper = middle + mult * sd;
  const lower = middle - mult * sd;
  const price = values[values.length - 1];
  const percentB = upper === lower ? 0.5 : (price - lower) / (upper - lower);
  return { upper, middle, lower, percentB };
}

/** ATR with Wilder smoothing. Needs at least period+1 bars (period true ranges). */
export function atr(bars: Bar[], period = 14): number | null {
  if (period <= 0 || bars.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const prevClose = bars[i - 1].close;
    trs.push(Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose)));
  }
  let value = 0;
  for (let i = 0; i < period; i++) value += trs[i];
  value /= period;
  for (let i = period; i < trs.length; i++) {
    value = (value * (period - 1) + trs[i]) / period;
  }
  return value;
}

/** Sample standard deviation (n-1 denominator). Null if fewer than 2 values. */
export function stdDev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Simple daily returns c[i]/c[i-1] - 1. Empty array if fewer than 2 closes. Skips non-positive denominators. */
export function dailyReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) out.push(closes[i] / closes[i - 1] - 1);
  }
  return out;
}

/** Maximum drawdown in percent (≤ 0, e.g. -33.33). Null if fewer than 2 closes. */
export function maxDrawdown(closes: number[]): number | null {
  if (closes.length < 2) return null;
  let peak = closes[0];
  let worst = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    if (peak > 0) worst = Math.min(worst, c / peak - 1);
  }
  return worst * 100;
}
