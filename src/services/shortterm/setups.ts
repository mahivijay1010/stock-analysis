/**
 * Setup classifier (S3/S4) — DETERMINISTIC rules mapping features + regimes to
 * explicit setup types. Each setup gets its own historical evaluation (see
 * scripts/shortTermStudy.ts); no single model is assumed to work in every
 * regime. Precedence: risk states first (event risk, late trend), then
 * constructive setups, then NO_SETUP — a stock above its SMA200 is NOT
 * automatically a setup (the BHEL rule).
 */

import { ShortTermFeatures } from "./features";
import { SetupType } from "./types";

export interface SetupClassification {
  setupType: SetupType;
  setupScore: number; // 0-100 descriptive strength of the pattern (never a probability)
  reasons: string[];
}

export function classifySetup(
  f: ShortTermFeatures,
  ctx: {
    marketRegime: string | null;
    stockRegime: string | null;
    upcomingEventRisk: boolean;
  }
): SetupClassification {
  const reasons: string[] = [];
  const uptrend =
    f.sma50 != null && f.sma200 != null && f.price > f.sma50 && f.sma50 > f.sma200 && (f.distSma200Pct ?? 0) > 0;
  const weakParticipation = (f.relVolume ?? 1) < 0.7;

  // 1. Risk states take precedence — they are setups to AVOID, not trade.
  if (ctx.upcomingEventRisk) {
    return {
      setupType: "HIGH_EVENT_RISK",
      setupScore: 0,
      reasons: ["A material event is imminent (point-in-time event engine) — short-term entries are blocked around binary events."],
    };
  }
  const extended = (f.distSma20Pct ?? 0) > 8 || ((f.week52Pct ?? 0) > 90 && (f.r20 ?? 0) > 0.15);
  if (uptrend && extended && (f.r5 ?? 0) <= 0) {
    return {
      setupType: "LATE_TREND",
      setupScore: 25,
      reasons: [
        `Extended after a strong run (dist SMA20 ${f.distSma20Pct?.toFixed(1)}%, 52w ${f.week52Pct?.toFixed(0)}pctile) with fading 5-day momentum — chasing here is the classic bad entry.`,
      ],
    };
  }

  // 2. Failed breakout: pushed above the 20d high recently, now back below it.
  if (uptrend && (f.breakoutDistPct ?? 0) < -1 && (f.r5 ?? 0) < -0.02 && (f.week52Pct ?? 0) > 80) {
    return {
      setupType: "FAILED_BREAKOUT",
      setupScore: 20,
      reasons: ["Recent push toward the highs failed and price fell back — failed breakouts resolve lower often enough to stand aside."],
    };
  }

  // 3. Constructive setups.
  if (
    uptrend &&
    (f.drawdownFrom20dHighPct ?? 0) <= -2 &&
    (f.drawdownFrom20dHighPct ?? -99) >= -9 &&
    f.sma20 != null &&
    Math.abs(f.distSma20Pct ?? 99) <= 3.5 &&
    (f.rsi14 ?? 50) >= 35 &&
    (f.rsi14 ?? 50) <= 60
  ) {
    reasons.push(
      `Pullback of ${Math.abs(f.drawdownFrom20dHighPct ?? 0).toFixed(1)}% from the 20d high onto SMA20 (${f.distSma20Pct?.toFixed(1)}% away) inside an uptrend (price > SMA50 > SMA200), RSI ${f.rsi14?.toFixed(0)} reset.`
    );
    let score = 55;
    if ((f.adx14 ?? 0) > 20) {
      score += 10;
      reasons.push(`Trend strength intact (ADX ${f.adx14?.toFixed(0)}).`);
    }
    if (!weakParticipation) score += 5;
    else reasons.push(`Participation weak (relative volume ${f.relVolume?.toFixed(2)}×) — needs confirmation before entry.`);
    if ((f.relNifty20 ?? 0) > 0) score += 5;
    return { setupType: "PULLBACK_IN_UPTREND", setupScore: Math.min(85, score), reasons };
  }

  if (
    uptrend &&
    (f.breakoutDistPct ?? -99) >= -2.5 &&
    (f.breakoutDistPct ?? 1) <= 0.5 &&
    (f.contraction ?? 1) < 0.85 &&
    (f.atrPct ?? 99) < 4
  ) {
    reasons.push(
      `Volatility contraction near the 20d high (ATR5/ATR20 ${f.contraction?.toFixed(2)}, ${Math.abs(f.breakoutDistPct ?? 0).toFixed(1)}% below the trigger) — energy building for a breakout attempt.`
    );
    return { setupType: "VOLATILITY_CONTRACTION", setupScore: (f.relVolume ?? 1) > 1 ? 65 : 55, reasons };
  }

  if (uptrend && (f.breakoutDistPct ?? -99) > 0 && (f.relVolume ?? 0) >= 1.3 && (f.volPriceConfirm ?? 0) >= 0.6) {
    reasons.push(
      `Closed above the 20d high on ${f.relVolume?.toFixed(1)}× volume with volume-price confirmation ${(100 * (f.volPriceConfirm ?? 0)).toFixed(0)}%.`
    );
    return { setupType: "BREAKOUT_CONFIRMATION", setupScore: 70, reasons };
  }

  if (
    uptrend &&
    (f.relNifty20 ?? -1) > 0.02 &&
    (f.r5 ?? 0) > 0 &&
    (f.adx14 ?? 0) > 25 &&
    (f.distSma20Pct ?? 99) <= 6 &&
    (f.rsi14 ?? 99) < 70
  ) {
    reasons.push(
      `Momentum continuation: +${((f.relNifty20 ?? 0) * 100).toFixed(1)}% vs NIFTY over 20 sessions, ADX ${f.adx14?.toFixed(0)}, not yet overbought (RSI ${f.rsi14?.toFixed(0)}).`
    );
    return { setupType: "MOMENTUM_CONTINUATION", setupScore: 60, reasons };
  }

  if (
    !uptrend &&
    f.sma200 != null &&
    f.price > f.sma200 * 0.92 &&
    (f.rsi14 ?? 50) < 30 &&
    (f.drawdownFrom20dHighPct ?? 0) < -8 &&
    (f.supportDistPct ?? 99) < 4
  ) {
    reasons.push(
      `Oversold mean-reversion: RSI ${f.rsi14?.toFixed(0)}, ${Math.abs(f.drawdownFrom20dHighPct ?? 0).toFixed(1)}% off the 20d high, ${f.supportDistPct?.toFixed(1)}% above swing support.`
    );
    // V2 (ranking-cliff fix): the score VARIES with pattern strength instead of
    // pinning every mean-reversion to exactly the gate floor. It is a
    // DESCRIPTIVE strength only — entry eligibility is decided by the setup
    // EVIDENCE tier + EV lower bound, never by this number reaching a gate.
    let score = 30;
    const rsi = f.rsi14 ?? 30;
    if (rsi < 25) score += 8; // deeper oversold
    else if (rsi < 28) score += 4;
    if ((f.supportDistPct ?? 9) < 2) score += 8; // right at structural support
    else if ((f.supportDistPct ?? 9) < 3) score += 4;
    if ((f.relNifty5 ?? -1) > 0) score += 6; // short-term RS already turning up
    if ((f.relVolume ?? 0) >= 1) score += 4; // participation returning
    if ((f.drawdownFrom20dHighPct ?? 0) < -14) score -= 4; // falling-knife penalty
    return { setupType: "MEAN_REVERSION", setupScore: Math.max(20, Math.min(58, score)), reasons };
  }

  return {
    setupType: "NO_SETUP",
    setupScore: 0,
    reasons: ["No qualifying short-term pattern — most stocks most of the time. Above-SMA200 alone is not a setup."],
  };
}
