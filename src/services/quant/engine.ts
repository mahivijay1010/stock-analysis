/**
 * Module 2 — quant analysis engine (pure functions, no DB/HTTP).
 * Implements the prediction methodology from REBUILD_SPEC.md exactly:
 *  - mu over last 250 daily returns, shrunk by 0.25; sigma = std dev of daily returns
 *  - composite weighted-signal score 0..100 (50 neutral), tilt = (score-50)/50
 *  - expectedReturnPct = (mu_shrunk*t + tilt*sigma*sqrt(t)*0.35)*100, clamped to ±2.5·sigma·sqrt(t)·100
 *  - 80% band = expected ± 1.2816·sigma·sqrt(t)·100
 *  - directionProb = Phi(expected/(sigma·sqrt(t)·100)) clamped to [0.05, 0.95]
 */

import {
  Bar,
  Horizon,
  HorizonPrediction,
  ProjectionRow,
  QuantAnalysis,
  Signal,
} from './types';
import {
  atr,
  bollinger,
  dailyReturns,
  macd,
  maxDrawdown,
  rsi,
  sma,
  stdDev,
} from './indicators';

export const HORIZONS: Horizon[] = [1, 3, 7, 15, 30];

/** Calendar-day horizon → trading-day offset. */
export const TRADING_DAY_OFFSETS: Record<Horizon, number> = {
  1: 1,
  3: 2,
  7: 5,
  15: 10,
  30: 21,
};

export const DEFAULT_PROJECTION_AMOUNTS = [1000, 10000, 100000, 1000000];

const Z_80 = 1.2816; // two-sided 80% normal band
const TILT_SCALE = 0.35;
const MU_SHRINK = 0.25;
const RETURN_CLAMP_SIGMAS = 2.5;
const MIN_SIGMA = 1e-6; // floor so a flat series never divides by zero / emits NaN

/** Standard normal CDF (Abramowitz & Stegun 26.2.17, |err| < 7.5e-8). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p =
    d *
    t *
    (0.31938153 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function round(x: number, dp: number): number {
  const f = Math.pow(10, dp);
  const r = Math.round(x * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

const round2 = (x: number) => round(x, 2);
const round4 = (x: number) => round(x, 4);

function fmtPct(x: number, dp = 1): string {
  return `${x >= 0 ? '+' : ''}${x.toFixed(dp)}%`;
}

function fmtInr(x: number): string {
  return `₹${x.toFixed(2)}`;
}

interface RawSignal extends Signal {
  value: number; // -1..1, bullish positive
}

function directionOf(value: number): Signal['direction'] {
  if (value > 0.15) return 'bullish';
  if (value < -0.15) return 'bearish';
  return 'neutral';
}

/** Trailing simple return in percent over the last k trading days. */
function trailingReturnPct(closes: number[], k: number): number | null {
  if (closes.length < k + 1) return null;
  const past = closes[closes.length - 1 - k];
  if (past <= 0) return null;
  return (closes[closes.length - 1] / past - 1) * 100;
}

/**
 * Full quantitative analysis of a daily bar series (chronological, oldest first).
 * Throws if fewer than 60 bars — never fabricates output from insufficient data.
 */
export function analyzeBars(bars: Bar[], opts?: { niftyBars?: Bar[] }): QuantAnalysis {
  if (!Array.isArray(bars) || bars.length < 60) {
    throw new Error(
      `analyzeBars requires at least 60 daily bars, got ${Array.isArray(bars) ? bars.length : 0}`
    );
  }

  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume);
  const price = closes[closes.length - 1];

  // --- Distribution parameters: last 250 daily returns ---
  const rets = dailyReturns(closes.slice(-251));
  const mu = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const muShrunk = mu * MU_SHRINK;
  let sigma = stdDev(rets) ?? 0;
  if (!Number.isFinite(sigma) || sigma < MIN_SIGMA) sigma = MIN_SIGMA;

  // --- Technicals ---
  const rsi14 = rsi(closes, 14);
  const macdV = macd(closes, 12, 26, 9);
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const boll = bollinger(closes, 20, 2);
  const atr14 = atr(bars, 14);
  const annualVolatilityPct = sigma * Math.sqrt(252) * 100;

  let week52: { high: number; low: number; positionPct: number } | null = null;
  if (bars.length >= 200) {
    const win = bars.slice(-252);
    const high = Math.max(...win.map((b) => b.high));
    const low = Math.min(...win.map((b) => b.low));
    const positionPct = high === low ? 50 : clamp(((price - low) / (high - low)) * 100, 0, 100);
    week52 = { high: round2(high), low: round2(low), positionPct: round2(positionPct) };
  }

  let volumeRatio20d: number | null = null;
  const vol20 = sma(volumes, 20);
  if (vol20 !== null && vol20 > 0) {
    volumeRatio20d = volumes[volumes.length - 1] / vol20;
  }

  const r5 = trailingReturnPct(closes, 5);
  const r20 = trailingReturnPct(closes, 20);
  const r60 = trailingReturnPct(closes, 60);

  const dd1y = maxDrawdown(closes.slice(-252));

  // --- Signals (weights sum to exactly 1.0) ---
  const signals: RawSignal[] = [];

  // 1) Trend: SMA20/50/200 alignment + price position (weight 0.20)
  {
    // Exact ties are neutral (0), not bearish — a flat series must score 50.
    const cmp = (a: number, b: number): number => (a > b ? 1 : a < b ? -1 : 0);
    const checks: number[] = [];
    if (sma20 !== null) checks.push(cmp(price, sma20));
    if (sma50 !== null) checks.push(cmp(price, sma50));
    if (sma20 !== null && sma50 !== null) checks.push(cmp(sma20, sma50));
    if (sma50 !== null && sma200 !== null) checks.push(cmp(sma50, sma200));
    const value = checks.length ? checks.reduce((a, b) => a + b, 0) / checks.length : 0;
    const parts = [
      `price ${fmtInr(price)}`,
      sma20 !== null ? `SMA20 ${fmtInr(sma20)}` : null,
      sma50 !== null ? `SMA50 ${fmtInr(sma50)}` : null,
      sma200 !== null ? `SMA200 ${fmtInr(sma200)}` : null,
    ].filter(Boolean);
    signals.push({
      name: 'Trend (SMA alignment)',
      value,
      weight: 0.2,
      direction: directionOf(value),
      detail: parts.join(' vs '),
    });
  }

  // 2) Momentum: 5/20/60d returns + RSI zone (weight 0.20)
  {
    const comps: number[] = [];
    if (r5 !== null) comps.push(clamp(r5 / 5, -1, 1));
    if (r20 !== null) comps.push(clamp(r20 / 10, -1, 1));
    if (r60 !== null) comps.push(clamp(r60 / 20, -1, 1));
    const retComp = comps.length ? comps.reduce((a, b) => a + b, 0) / comps.length : 0;
    let rsiComp = 0;
    if (rsi14 !== null) {
      if (rsi14 >= 70) rsiComp = -0.4; // overbought
      else if (rsi14 <= 30) rsiComp = 0.4; // oversold
      else rsiComp = (rsi14 - 50) / 50;
    }
    const value = clamp(0.7 * retComp + 0.3 * rsiComp, -1, 1);
    signals.push({
      name: 'Momentum (returns + RSI)',
      value,
      weight: 0.2,
      direction: directionOf(value),
      detail: `returns 5d ${r5 !== null ? fmtPct(r5) : 'n/a'}, 20d ${
        r20 !== null ? fmtPct(r20) : 'n/a'
      }, 60d ${r60 !== null ? fmtPct(r60) : 'n/a'}; RSI ${
        rsi14 !== null ? rsi14.toFixed(1) : 'n/a'
      }`,
    });
  }

  // 3) MACD: histogram + cross (weight 0.15)
  {
    let value = 0;
    let detail = 'MACD unavailable (insufficient history)';
    if (macdV) {
      const cross = macdV.line > macdV.signal ? 0.5 : macdV.line < macdV.signal ? -0.5 : 0;
      const histNorm = price > 0 ? clamp(macdV.histogram / (0.005 * price), -0.5, 0.5) : 0;
      value = clamp(cross + histNorm, -1, 1);
      detail = `MACD line ${macdV.line.toFixed(2)} vs signal ${macdV.signal.toFixed(
        2
      )} (histogram ${macdV.histogram >= 0 ? '+' : ''}${macdV.histogram.toFixed(2)})`;
    }
    signals.push({
      name: 'MACD',
      value,
      weight: 0.15,
      direction: directionOf(value),
      detail,
    });
  }

  // 4) Bollinger %B mean-reversion at extremes (weight 0.10)
  {
    let value = 0;
    let detail = 'Bollinger bands unavailable';
    if (boll) {
      const b = boll.percentB;
      if (b >= 1) value = -0.8;
      else if (b >= 0.9) value = -0.4;
      else if (b <= 0) value = 0.8;
      else if (b <= 0.1) value = 0.4;
      detail = `%B ${b.toFixed(2)} (band ${fmtInr(boll.lower)}–${fmtInr(boll.upper)})${
        b >= 0.9 ? ' — stretched near upper band' : b <= 0.1 ? ' — depressed near lower band' : ''
      }`;
    }
    signals.push({
      name: 'Bollinger mean-reversion',
      value,
      weight: 0.1,
      direction: directionOf(value),
      detail,
    });
  }

  // 5) Volume confirmation (weight 0.10)
  {
    let value = 0;
    let detail = 'Volume data unavailable';
    if (volumeRatio20d !== null) {
      const up = (r5 ?? 0) >= 0;
      if (volumeRatio20d >= 1.5) value = up ? 0.7 : -0.7;
      else if (volumeRatio20d >= 1.1) value = up ? 0.3 : -0.3;
      detail = `volume ${volumeRatio20d.toFixed(2)}x the 20-day average${
        volumeRatio20d >= 1.5 ? ` — confirms recent ${up ? 'up' : 'down'} move` : ''
      }`;
    }
    signals.push({
      name: 'Volume confirmation',
      value,
      weight: 0.1,
      direction: directionOf(value),
      detail,
    });
  }

  // 6) 52-week position (weight 0.10)
  {
    let value = 0;
    let detail = '52-week range unavailable (needs ~1y of bars)';
    if (week52) {
      value = clamp((week52.positionPct - 50) / 50, -1, 1);
      detail = `at ${week52.positionPct.toFixed(0)}% of 52-week range (low ${fmtInr(
        week52.low
      )}, high ${fmtInr(week52.high)})`;
    }
    signals.push({
      name: '52-week position',
      value,
      weight: 0.1,
      direction: directionOf(value),
      detail,
    });
  }

  // 7) Relative strength vs NIFTY (weight 0.10) — neutral if not provided
  let relDiff: number | null = null;
  {
    let value = 0;
    let detail = 'NIFTY comparison unavailable';
    const nifty = opts?.niftyBars;
    if (nifty && nifty.length >= 21) {
      const nCloses = nifty.map((b) => b.close);
      const k = Math.min(60, closes.length - 1, nCloses.length - 1);
      const sPct = trailingReturnPct(closes, k);
      const nPct = trailingReturnPct(nCloses, k);
      if (sPct !== null && nPct !== null) {
        relDiff = sPct - nPct;
        value = clamp(relDiff / 10, -1, 1);
        detail = `${k}-session return ${fmtPct(sPct)} vs NIFTY ${fmtPct(nPct)}`;
      }
    }
    signals.push({
      name: 'Relative strength vs NIFTY',
      value,
      weight: 0.1,
      direction: directionOf(value),
      detail,
    });
  }

  // 8) Volatility penalty (weight 0.05, value ≤ 0)
  {
    const value = -clamp(Math.max(0, annualVolatilityPct - 35) / 15, 0, 1);
    signals.push({
      name: 'Volatility penalty',
      value,
      weight: 0.05,
      direction: directionOf(value),
      detail: `annualized volatility ${annualVolatilityPct.toFixed(1)}%`,
    });
  }

  // --- Composite score ---
  const weighted = signals.reduce((s, x) => s + x.weight * x.value, 0); // in [-1, 1]
  const score = round(clamp(50 + 50 * weighted, 0, 100), 1);
  const tilt = (score - 50) / 50;

  // --- Risk level ---
  let riskLevel: QuantAnalysis['riskLevel'] =
    annualVolatilityPct < 20 ? 'LOW' : annualVolatilityPct <= 35 ? 'MEDIUM' : 'HIGH';
  if (dd1y !== null && dd1y < -40) {
    riskLevel = riskLevel === 'LOW' ? 'MEDIUM' : 'HIGH';
  }

  // --- Recommendation ---
  const trendSignal = signals[0];
  const bearishTrend = trendSignal.direction === 'bearish';
  let recommendation: QuantAnalysis['recommendation'];
  if (score <= 38) recommendation = 'AVOID';
  else if (score >= 62 && !(riskLevel === 'HIGH' && bearishTrend)) recommendation = 'BUY';
  else recommendation = 'HOLD';

  // --- Reasons (quote real numbers) ---
  const positive: string[] = [];
  const negative: string[] = [];
  if (rsi14 !== null) {
    if (rsi14 >= 70) negative.push(`RSI ${rsi14.toFixed(1)} — overbought`);
    else if (rsi14 <= 30) positive.push(`RSI ${rsi14.toFixed(1)} — oversold, rebound potential`);
    else if (rsi14 >= 55) positive.push(`RSI ${rsi14.toFixed(1)} — healthy bullish momentum`);
    else if (rsi14 <= 45) negative.push(`RSI ${rsi14.toFixed(1)} — weak momentum`);
  }
  if (sma50 !== null && sma50 > 0) {
    const d = (price / sma50 - 1) * 100;
    if (d >= 0)
      positive.push(
        `Price ${fmtInr(price)} is ${fmtPct(d)} above its 50-day average (${fmtInr(sma50)})`
      );
    else
      negative.push(
        `Price ${fmtInr(price)} is ${fmtPct(d)} below its 50-day average (${fmtInr(sma50)})`
      );
  }
  if (sma200 !== null && sma200 > 0) {
    const d = (price / sma200 - 1) * 100;
    if (d >= 0) positive.push(`Long-term uptrend: price ${fmtPct(d)} above the 200-day average`);
    else negative.push(`Long-term downtrend: price ${fmtPct(d)} below the 200-day average`);
  }
  if (macdV) {
    if (macdV.histogram > 0)
      positive.push(
        `MACD histogram +${macdV.histogram.toFixed(2)} — bullish momentum building`
      );
    else if (macdV.histogram < 0)
      negative.push(`MACD histogram ${macdV.histogram.toFixed(2)} — bearish momentum`);
  }
  if (r20 !== null) {
    if (r20 >= 3) positive.push(`${fmtPct(r20)} over the last 20 sessions`);
    else if (r20 <= -3) negative.push(`${fmtPct(r20)} over the last 20 sessions`);
  }
  if (week52) {
    if (week52.positionPct >= 80)
      positive.push(
        `Trading at ${week52.positionPct.toFixed(0)}% of its 52-week range — near highs`
      );
    else if (week52.positionPct <= 20)
      negative.push(
        `Trading at ${week52.positionPct.toFixed(0)}% of its 52-week range — near lows`
      );
  }
  if (volumeRatio20d !== null && volumeRatio20d >= 1.5) {
    const line = `Volume ${volumeRatio20d.toFixed(1)}x the 20-day average`;
    if ((r5 ?? 0) >= 0) positive.push(`${line} — buying interest`);
    else negative.push(`${line} — selling pressure`);
  }
  if (relDiff !== null) {
    if (relDiff >= 3) positive.push(`Outperforming NIFTY 50 by ${fmtPct(relDiff)} recently`);
    else if (relDiff <= -3) negative.push(`Underperforming NIFTY 50 by ${fmtPct(relDiff)} recently`);
  }
  if (annualVolatilityPct > 35)
    negative.push(`Annualized volatility ${annualVolatilityPct.toFixed(1)}% — high risk`);
  if (dd1y !== null && dd1y < -40)
    negative.push(`Max drawdown ${dd1y.toFixed(1)}% over the past year`);

  // --- Predictions ---
  const predictions: HorizonPrediction[] = HORIZONS.map((h) => {
    const t = TRADING_DAY_OFFSETS[h];
    const sqrtT = Math.sqrt(t);
    const raw = muShrunk * t + tilt * sigma * sqrtT * TILT_SCALE;
    const clampAbs = RETURN_CLAMP_SIGMAS * sigma * sqrtT;
    const expected = clamp(raw, -clampAbs, clampAbs) * 100; // pct
    const band = Z_80 * sigma * sqrtT * 100; // pct
    const low = expected - band;
    const high = expected + band;
    const directionProb = clamp(normalCdf(expected / (sigma * sqrtT * 100)), 0.05, 0.95);
    return {
      horizonDays: h,
      expectedReturnPct: round4(expected),
      low80Pct: round4(low),
      high80Pct: round4(high),
      expectedPrice: round2(price * (1 + expected / 100)),
      lowPrice: round2(price * (1 + low / 100)),
      highPrice: round2(price * (1 + high / 100)),
      directionProb: round4(directionProb),
    };
  });

  return {
    score,
    recommendation,
    riskLevel,
    signals: signals.map(({ name, direction, weight, detail }) => ({
      name,
      direction,
      weight,
      detail,
    })),
    reasons: { positive, negative },
    technicals: {
      rsi14: rsi14 === null ? null : round2(rsi14),
      macd: macdV
        ? {
            line: round4(macdV.line),
            signal: round4(macdV.signal),
            histogram: round4(macdV.histogram),
          }
        : null,
      sma20: sma20 === null ? null : round2(sma20),
      sma50: sma50 === null ? null : round2(sma50),
      sma200: sma200 === null ? null : round2(sma200),
      bollinger: boll
        ? {
            upper: round2(boll.upper),
            middle: round2(boll.middle),
            lower: round2(boll.lower),
            percentB: round4(boll.percentB),
          }
        : null,
      atr14: atr14 === null ? null : round4(atr14),
      annualVolatilityPct: round2(annualVolatilityPct),
      week52,
      volumeRatio20d: volumeRatio20d === null ? null : round4(volumeRatio20d),
      returns: {
        r5dPct: r5 === null ? null : round2(r5),
        r20dPct: r20 === null ? null : round2(r20),
        r60dPct: r60 === null ? null : round2(r60),
      },
    },
    predictions,
  };
}

/**
 * Investment projections: value = amount * (1 + returnPct/100), profit = expected - amount.
 * All values rounded to 2 decimals. Default amounts ₹1,000 / ₹10,000 / ₹1,00,000 / ₹10,00,000.
 */
export function buildProjections(
  currentPrice: number,
  predictions: HorizonPrediction[],
  amounts: number[] = DEFAULT_PROJECTION_AMOUNTS
): ProjectionRow[] {
  void currentPrice; // projections are notional-amount based; price kept for interface stability
  return amounts.map((amount) => ({
    amount,
    byHorizon: predictions.map((p) => {
      const expectedValue = round2(amount * (1 + p.expectedReturnPct / 100));
      return {
        horizonDays: p.horizonDays,
        expectedValue,
        lowValue: round2(amount * (1 + p.low80Pct / 100)),
        highValue: round2(amount * (1 + p.high80Pct / 100)),
        expectedProfit: round2(expectedValue - amount),
      };
    }),
  }));
}
