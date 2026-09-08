/**
 * EntryConfirmationEngine (Parts 6/10/11) — Stage-B confirmation.
 *
 * Reaching the zone is Stage A; ENTRY_CONFIRMED requires the setup-specific
 * confirmation trigger to be satisfied on COMPLETED-bar evidence. The rules
 * below are the ones the expectancy study retained (docs/short-term-
 * confirmation.md); rules that did not improve after-cost outcomes are NOT
 * required. Confirmation is necessary-but-not-sufficient: tier/health/EV
 * ceilings still apply on top.
 */

import { ShortTermFeatures } from "./features";
import { SetupType } from "./types";

export interface ConfirmationResult {
  satisfied: boolean;
  required: string[];
  met: string[];
  unmet: string[];
}

export function assessConfirmation(
  setup: SetupType,
  f: ShortTermFeatures,
  ctx: { marketRegimeOk: boolean; upcomingEventRisk: boolean; freshDataOk: boolean }
): ConfirmationResult {
  const required: string[] = [];
  const met: string[] = [];
  const unmet: string[] = [];
  const check = (label: string, pass: boolean) => {
    required.push(label);
    (pass ? met : unmet).push(label);
  };

  // Universal short-term confirmations (retained by the study).
  check("no imminent material event", !ctx.upcomingEventRisk);
  check("data freshness sufficient for confirmation", ctx.freshDataOk);
  check("market regime not hostile", ctx.marketRegimeOk);

  switch (setup) {
    case "MEAN_REVERSION":
      // RSI RECOVERING (not merely low) + reclaiming SMA20 + RS turning up.
      check("RSI recovering from oversold (>35, not falling)", (f.rsi14 ?? 0) >= 35);
      check("price reclaiming/holding near SMA20", f.sma20 != null && f.price >= f.sma20 * 0.985);
      check("relative volume recovering (≥0.8×)", (f.relVolume ?? 0) >= 0.8);
      check("short-term relative strength not still collapsing", (f.relNifty5 ?? -1) >= -0.01);
      break;
    case "PULLBACK_IN_UPTREND":
      check("holding above SMA20 on the close", f.sma20 != null && f.price >= f.sma20 * 0.99);
      check("RSI reset but turning (35–60)", (f.rsi14 ?? 0) >= 35 && (f.rsi14 ?? 100) <= 62);
      check("trend strength intact (ADX ≥ 18)", (f.adx14 ?? 0) >= 18);
      break;
    case "BREAKOUT_CONFIRMATION":
    case "VOLATILITY_CONTRACTION":
      check("closed above the 20d high", (f.breakoutDistPct ?? -1) > 0);
      check("volume expansion (relVol ≥ 1.3×)", (f.relVolume ?? 0) >= 1.3);
      check("volume-price confirmation ≥ 0.6", (f.volPriceConfirm ?? 0) >= 0.6);
      break;
    case "MOMENTUM_CONTINUATION":
      check("still outperforming NIFTY (20d)", (f.relNifty20 ?? -1) > 0);
      check("not overbought (RSI < 70)", (f.rsi14 ?? 100) < 70);
      check("above EMA20", f.ema20 != null && f.price >= f.ema20);
      break;
    default:
      // Non-constructive setups cannot be confirmed.
      required.push("constructive setup type");
      unmet.push("constructive setup type");
  }

  return { satisfied: unmet.length === 0, required, met, unmet };
}
