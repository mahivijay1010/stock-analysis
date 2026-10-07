/**
 * Market regime detector (regime-v1) — PURE.
 *
 * Small caps behave differently in different market states, so a single set of
 * gate thresholds across all regimes underperforms. This classifies the index
 * into one of five regimes from its own price action — trend (SMA alignment +
 * slope), realized volatility, and drawdown from the recent high. No forecast
 * is made: a regime is a description of the market we are IN, used to condition
 * thresholds, never to predict direction.
 */

import { Bar } from "../market/types";

export const REGIME_VERSION = "regime-v1";

export type Regime = "TREND_UP" | "TREND_DOWN" | "CHOPPY" | "HIGH_VOL" | "CRISIS";

export interface RegimeAssessment {
  version: string;
  regime: Regime;
  reasons: string[];
  /** −1..1: SMA-alignment trend score. */
  trendScore: number;
  /** Annualized realized vol over 20 sessions, %. */
  realizedVolPct: number | null;
  /** Drawdown from the trailing 120-session high, % (≤ 0). */
  drawdownPct: number | null;
  sampleBars: number;
}

export const REGIME_THRESHOLDS = {
  crisisDrawdownPct: -15,
  crisisVolPct: 28,
  highVolPct: 22,
  trendSlopeEps: 0.5, // % over 20 sessions to call a slope non-flat
} as const;

const sma = (xs: number[], n: number): number | null => {
  if (xs.length < n) return null;
  const s = xs.slice(xs.length - n);
  return s.reduce((a, b) => a + b, 0) / n;
};
const r2 = (x: number): number => Math.round(x * 100) / 100;

/** PURE: classify the regime from ascending index bars (needs ≥ 60 for a
 *  confident call; fewer ⇒ CHOPPY with a low-sample reason). */
export function classifyRegime(bars: Bar[]): RegimeAssessment {
  const closes = bars.map((b) => b.adjustedClose ?? b.close).filter((c) => c > 0);
  const base: RegimeAssessment = {
    version: REGIME_VERSION,
    regime: "CHOPPY",
    reasons: [],
    trendScore: 0,
    realizedVolPct: null,
    drawdownPct: null,
    sampleBars: closes.length,
  };
  if (closes.length < 60) return { ...base, reasons: [`insufficient history (${closes.length} < 60 bars) — defaulting to CHOPPY`] };

  const price = closes[closes.length - 1];
  const s20 = sma(closes, 20);
  const s50 = sma(closes, 50);
  const s200 = sma(closes, 200) ?? sma(closes, Math.min(120, closes.length)); // fall back to 120 when < 200 bars

  // Trend score: +1 per bullish alignment check, averaged to −1..1.
  const checks: number[] = [];
  if (s20 != null) checks.push(price > s20 ? 1 : -1);
  if (s50 != null) checks.push(price > s50 ? 1 : -1);
  if (s20 != null && s50 != null) checks.push(s20 > s50 ? 1 : -1);
  if (s50 != null && s200 != null) checks.push(s50 > s200 ? 1 : -1);
  const trendScore = checks.length ? r2(checks.reduce((a, b) => a + b, 0) / checks.length) : 0;

  // 20-session slope in %.
  const slopePct = closes.length >= 21 ? ((price / closes[closes.length - 21] - 1) * 100) : 0;

  // Realized vol (annualized) over 20 daily log returns.
  const rets: number[] = [];
  for (let i = closes.length - 20; i < closes.length; i++) if (i > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length);
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1);
  const realizedVolPct = rets.length >= 10 ? r2(Math.sqrt(variance) * Math.sqrt(252) * 100) : null;

  // Drawdown from trailing 120-session high.
  const window = closes.slice(Math.max(0, closes.length - 120));
  const peak = Math.max(...window);
  const drawdownPct = peak > 0 ? r2((price / peak - 1) * 100) : null;

  const T = REGIME_THRESHOLDS;
  const reasons: string[] = [];
  let regime: Regime;
  if (drawdownPct != null && drawdownPct <= T.crisisDrawdownPct && realizedVolPct != null && realizedVolPct >= T.crisisVolPct) {
    regime = "CRISIS";
    reasons.push(`drawdown ${drawdownPct}% with vol ${realizedVolPct}% — risk-off`);
  } else if (realizedVolPct != null && realizedVolPct >= T.highVolPct) {
    regime = "HIGH_VOL";
    reasons.push(`realized vol ${realizedVolPct}% ≥ ${T.highVolPct}% — size down, widen stops`);
  } else if (trendScore >= 0.5 && slopePct > T.trendSlopeEps) {
    regime = "TREND_UP";
    reasons.push(`price above its averages (trend ${trendScore}), 20d slope +${r2(slopePct)}%`);
  } else if (trendScore <= -0.5 && slopePct < -T.trendSlopeEps) {
    regime = "TREND_DOWN";
    reasons.push(`price below its averages (trend ${trendScore}), 20d slope ${r2(slopePct)}%`);
  } else {
    regime = "CHOPPY";
    reasons.push(`mixed trend (${trendScore}), slope ${r2(slopePct)}% — no clean direction`);
  }

  return { version: REGIME_VERSION, regime, reasons, trendScore, realizedVolPct, drawdownPct, sampleBars: closes.length };
}
