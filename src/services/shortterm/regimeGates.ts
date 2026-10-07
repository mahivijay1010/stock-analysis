/**
 * Regime-conditional gates (regime-gates-v1) — PURE.
 *
 * Small caps behave differently by regime, so one set of thresholds across all
 * markets underperforms. This is a CONFIG table, not a model: given the current
 * regime (from regime.ts) it returns how to adjust sizing, the conviction bar,
 * stop width and which setups are even allowed. Highest ROI per line of code —
 * no new data, no training.
 */

import { Regime } from "./regime";

export const REGIME_GATES_VERSION = "regime-gates-v1";

export type AllowedSetups = "ALL" | "MEAN_REVERSION_ONLY" | "TREND_ONLY";

export interface RegimeGateProfile {
  regime: Regime;
  /** Multiply position size by this (constant-risk discipline in rough markets). */
  sizeMultiplier: number;
  /** Add this to the minimum conviction score required to act. */
  convictionBump: number;
  /** Multiply the ATR stop distance by this (wider in high-vol, tighter risk-off). */
  stopAtrMultiplier: number;
  allowedSetups: AllowedSetups;
  note: string;
}

export const REGIME_GATES: Record<Regime, RegimeGateProfile> = {
  TREND_UP: { regime: "TREND_UP", sizeMultiplier: 1.0, convictionBump: 0, stopAtrMultiplier: 1.0, allowedSetups: "ALL", note: "Risk-on: normal size, full setup menu." },
  CHOPPY: { regime: "CHOPPY", sizeMultiplier: 0.75, convictionBump: 5, stopAtrMultiplier: 1.0, allowedSetups: "MEAN_REVERSION_ONLY", note: "No clean trend: fade extremes, avoid breakouts (they fail in chop)." },
  HIGH_VOL: { regime: "HIGH_VOL", sizeMultiplier: 0.5, convictionBump: 8, stopAtrMultiplier: 1.5, allowedSetups: "ALL", note: "High vol: widen stops but HALVE size so rupee risk stays constant." },
  TREND_DOWN: { regime: "TREND_DOWN", sizeMultiplier: 0.5, convictionBump: 10, stopAtrMultiplier: 0.85, allowedSetups: "MEAN_REVERSION_ONLY", note: "Downtrend (long-only): half size, tighter stops, ONLY oversold mean-reversion bounces — never buy momentum/breakouts into a falling market." },
  CRISIS: { regime: "CRISIS", sizeMultiplier: 0.0, convictionBump: 100, stopAtrMultiplier: 0.75, allowedSetups: "TREND_ONLY", note: "Risk-off crisis: new long entries OFF. Capital preservation only." },
};

export function regimeGateFor(regime: Regime | string | null | undefined): RegimeGateProfile {
  if (regime && regime in REGIME_GATES) return REGIME_GATES[regime as Regime];
  return REGIME_GATES.CHOPPY; // unknown ⇒ the neutral-cautious default
}

/** Is a setup type permitted in this regime? PURE. */
export function setupAllowedInRegime(setupType: string, allowed: AllowedSetups): boolean {
  if (allowed === "ALL") return true;
  const s = setupType.toUpperCase();
  const isMeanReversion = s.includes("MEAN_REVERSION") || s.includes("PULLBACK");
  const isTrend = s.includes("BREAKOUT") || s.includes("MOMENTUM");
  if (allowed === "MEAN_REVERSION_ONLY") return isMeanReversion;
  if (allowed === "TREND_ONLY") return isTrend;
  return true;
}
