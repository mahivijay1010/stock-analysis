/**
 * Regime engine (completion directive, Phase 4) — PURE and deterministic.
 *
 * Classifies market / sector / stock / entry regimes from the ADJUSTED price
 * series plus VIX and (optional) breadth/sector inputs. Regime output is a
 * CONFIDENCE MODIFIER and eligibility input — it caps and contextualizes,
 * it never makes anything bullish by itself (spec Rule 6).
 */

import { Bar } from "../market/types";
import { analysisCloses } from "../market/canonical";

export const REGIME_VERSION = "regime-v1";

export type MarketRegime = "bull_low_vol" | "bull_high_vol" | "neutral" | "bear_low_vol" | "bear_high_vol";
export type StockRegime =
  | "extended_uptrend"
  | "healthy_uptrend"
  | "breakout"
  | "late_trend"
  | "mean_reverting"
  | "downtrend"
  | "high_event_risk"
  | "neutral";
export type SectorRegime = "leading" | "inline" | "lagging" | "unknown";

export interface RegimeInputs {
  /** NIFTY bars ascending (≥ 210 for the 200-day trend; fewer ⇒ degraded confidence). */
  niftyBars: Bar[] | null;
  /** Latest India VIX level and its 1y percentile (0–100), when known. */
  vixLevel: number | null;
  vixPercentile1y: number | null;
  /** % of universe above its 50-day average (0–100), when known. */
  breadthPctAbove50?: number | null;
  /** The stock's bars ascending (≥ 60). */
  stockBars: Bar[] | null;
  /** Stock 20d return − sector 20d return, percentage points; null = unknown. */
  sectorRelativeStrength20pp?: number | null;
  /** Caller-asserted imminent material event (earnings date etc.). */
  upcomingEventRisk?: boolean;
}

export interface RegimeAssessment {
  version: string;
  marketRegime: MarketRegime | "unknown";
  sectorRegime: SectorRegime;
  stockRegime: StockRegime | "unknown";
  entryRegime: StockRegime | "unknown";
  regimeConfidence: number; // 0-100 — input completeness × internal agreement
  regimeReasons: string[];
}

const HIGH_VOL_ANN_PCT = 17; // NIFTY realized 20d, annualized — long-run median ≈ 14–15
const VIX_HIGH = 17;

function sma(xs: number[], n: number): number | null {
  if (xs.length < n) return null;
  let s = 0;
  for (let i = xs.length - n; i < xs.length; i++) s += xs[i];
  return s / n;
}

function realizedVolAnnPct(closes: number[], n = 20): number | null {
  if (closes.length < n + 1) return null;
  const rets: number[] = [];
  for (let i = closes.length - n; i < closes.length; i++) {
    if (closes[i - 1] > 0) rets.push(closes[i] / closes[i - 1] - 1);
  }
  if (rets.length < 2) return null;
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v) * Math.sqrt(252) * 100;
}

function trailingReturnPct(closes: number[], n: number): number | null {
  if (closes.length < n + 1) return null;
  const prev = closes[closes.length - 1 - n];
  return prev > 0 ? (closes[closes.length - 1] / prev - 1) * 100 : null;
}

export function assessRegime(i: RegimeInputs): RegimeAssessment {
  const reasons: string[] = [];
  let inputsSeen = 0;
  let inputsTotal = 0;

  // ── market ────────────────────────────────────────────────────────────────
  let marketRegime: RegimeAssessment["marketRegime"] = "unknown";
  inputsTotal += 2; // trend + vol
  if (i.niftyBars && i.niftyBars.length >= 60) {
    const closes = analysisCloses(i.niftyBars);
    const price = closes[closes.length - 1];
    const s50 = sma(closes, 50);
    const s200 = sma(closes, 200);
    const above50 = s50 != null ? price > s50 : null;
    const above200 = s200 != null ? price > s200 : null;
    inputsSeen++;

    const rv = realizedVolAnnPct(closes);
    const volHigh =
      (rv != null && rv > HIGH_VOL_ANN_PCT) ||
      (i.vixLevel != null && i.vixLevel > VIX_HIGH) ||
      (i.vixPercentile1y != null && i.vixPercentile1y > 80);
    if (rv != null || i.vixLevel != null) inputsSeen++;

    const breadthWeak = i.breadthPctAbove50 != null && i.breadthPctAbove50 < 40;
    const trendUp = above50 === true && above200 !== false && !breadthWeak;
    const trendDown = (above50 === false && above200 === false) || (above200 === false && breadthWeak);

    if (trendUp) marketRegime = volHigh ? "bull_high_vol" : "bull_low_vol";
    else if (trendDown) marketRegime = volHigh ? "bear_high_vol" : "bear_low_vol";
    else marketRegime = "neutral";

    reasons.push(
      `Market: NIFTY ${above50 == null ? "trend unknown" : above50 ? "above" : "below"} 50DMA, ` +
        `${above200 == null ? "200DMA unknown" : above200 ? "above" : "below"} 200DMA` +
        (rv != null ? `, realized vol ${rv.toFixed(1)}%` : "") +
        (i.vixLevel != null ? `, VIX ${i.vixLevel.toFixed(1)}` : "") +
        (i.breadthPctAbove50 != null ? `, breadth ${i.breadthPctAbove50.toFixed(0)}% above 50DMA` : "") +
        ` ⇒ ${marketRegime}.`
    );
  } else {
    reasons.push("Market: insufficient NIFTY history — regime unknown.");
  }

  // ── sector ────────────────────────────────────────────────────────────────
  let sectorRegime: SectorRegime = "unknown";
  inputsTotal += 1;
  if (i.sectorRelativeStrength20pp != null) {
    inputsSeen++;
    sectorRegime =
      i.sectorRelativeStrength20pp > 3 ? "leading" : i.sectorRelativeStrength20pp < -3 ? "lagging" : "inline";
    reasons.push(`Sector: 20d relative strength ${i.sectorRelativeStrength20pp.toFixed(1)}pp ⇒ ${sectorRegime}.`);
  } else {
    reasons.push("Sector: relative strength unknown.");
  }

  // ── stock ─────────────────────────────────────────────────────────────────
  let stockRegime: RegimeAssessment["stockRegime"] = "unknown";
  inputsTotal += 1;
  if (i.stockBars && i.stockBars.length >= 60) {
    inputsSeen++;
    const closes = analysisCloses(i.stockBars);
    const price = closes[closes.length - 1];
    const s50 = sma(closes, 50);
    const s200 = sma(closes, 200);
    const r5 = trailingReturnPct(closes, 5);
    const r20 = trailingReturnPct(closes, 20);
    const r60 = trailingReturnPct(closes, 60);
    const year = closes.slice(-252);
    const hi = Math.max(...year);
    const lo = Math.min(...year);
    const w52 = hi > lo ? ((price - lo) / (hi - lo)) * 100 : null;
    const distAbove50Pct = s50 != null && s50 > 0 ? ((price - s50) / s50) * 100 : null;
    const vols = i.stockBars.slice(-21).map((b) => b.volume);
    const positive = vols.slice(0, -1).filter((v) => v > 0);
    const volRatio =
      positive.length >= 10 && vols[vols.length - 1] > 0
        ? vols[vols.length - 1] / (positive.reduce((a, b) => a + b, 0) / positive.length)
        : null;

    if (i.upcomingEventRisk === true) {
      stockRegime = "high_event_risk";
    } else if (s200 != null && price < s200 && (r60 ?? 0) < 0) {
      stockRegime = "downtrend";
    } else if (w52 != null && w52 >= 97 && (r5 ?? 0) > 2 && volRatio != null && volRatio > 1.3) {
      stockRegime = "breakout";
    } else if (w52 != null && w52 >= 90 && (r60 ?? 0) >= 15 && distAbove50Pct != null && distAbove50Pct > 10) {
      stockRegime = "extended_uptrend";
    } else if ((r60 ?? 0) >= 15 && (r20 ?? 0) <= 0) {
      stockRegime = "late_trend";
    } else if (s50 != null && s200 != null && price > s50 && price > s200 && (r60 ?? 0) > 0) {
      stockRegime = "healthy_uptrend";
    } else if (Math.abs(r60 ?? 0) < 6 && r20 != null && r60 != null && Math.sign(r20) !== Math.sign(r60)) {
      stockRegime = "mean_reverting";
    } else {
      stockRegime = "neutral";
    }
    reasons.push(
      `Stock: r20 ${(r20 ?? 0).toFixed(1)}%, r60 ${(r60 ?? 0).toFixed(1)}%, ` +
        `${w52 != null ? `52w ${w52.toFixed(0)}th pct, ` : ""}` +
        `${distAbove50Pct != null ? `${distAbove50Pct.toFixed(1)}% above 50DMA ` : ""}⇒ ${stockRegime}.`
    );
  } else {
    reasons.push("Stock: insufficient history — regime unknown.");
  }

  // ── entry regime: the stock regime through the market lens (cap-only) ────
  let entryRegime = stockRegime;
  if (
    (marketRegime === "bear_high_vol" || marketRegime === "bear_low_vol") &&
    (stockRegime === "healthy_uptrend" || stockRegime === "breakout")
  ) {
    entryRegime = "late_trend"; // fighting the tape — treated as late, never boosted
    reasons.push("Entry: bullish stock inside a bear market is treated as late_trend (regime caps, never boosts).");
  }

  const completeness = inputsTotal > 0 ? inputsSeen / inputsTotal : 0;
  const regimeConfidence = Math.round(completeness * 100 * 10) / 10;

  return {
    version: REGIME_VERSION,
    marketRegime,
    sectorRegime,
    stockRegime,
    entryRegime,
    regimeConfidence,
    regimeReasons: reasons,
  };
}
