/**
 * Fractional Kelly position sizing (fractional-kelly-v1) — PURE.
 *
 * Full Kelly over-bets and, worse, demands a CALIBRATED win probability we do
 * not yet have (the meta-label model is still accruing labels). So this is
 * built fail-safe: when no calibrated p is supplied it returns the fixed-risk
 * fallback unchanged — Kelly never silently inflates size on a made-up edge.
 * When a calibrated p IS supplied, it caps at a fraction of Kelly (quarter by
 * default) and never exceeds the risk ceiling. A non-positive edge ⇒ 0% (no
 * trade), which is the honest answer.
 *
 *   b   = reward:risk    f* = (p·(b+1) − 1) / b
 *   risk% = min(kellyFraction · f*, maxRiskPct)
 */

export const FRACTIONAL_KELLY_VERSION = "fractional-kelly-v1";

export interface KellyInput {
  rewardToRisk: number; // b = (target − entry)/(entry − stop)
  /** CALIBRATED P(win) in (0,1), or null when no promoted model exists. */
  pWin: number | null;
  maxRiskPct: number; // hard ceiling, e.g. 1–2
  kellyFraction?: number; // default 0.25 (quarter-Kelly)
  /** Fixed risk % to use when pWin is null (your current behaviour). */
  fixedRiskPct?: number;
}

export interface KellyResult {
  version: string;
  riskPct: number;
  kellyF: number | null; // the raw Kelly fraction (null when p unavailable)
  usedCalibratedP: boolean;
  basis: string;
}

const r4 = (x: number): number => Math.round(x * 10000) / 10000;

export function fractionalKellyRiskPct(input: KellyInput): KellyResult {
  const frac = input.kellyFraction ?? 0.25;
  const ceiling = Math.max(0, input.maxRiskPct);

  // No calibrated probability ⇒ fall back to fixed risk. Kelly never invents an edge.
  if (input.pWin == null || !Number.isFinite(input.pWin) || input.pWin <= 0 || input.pWin >= 1 || !(input.rewardToRisk > 0)) {
    const fixed = Math.min(ceiling, Math.max(0, input.fixedRiskPct ?? ceiling));
    return {
      version: FRACTIONAL_KELLY_VERSION,
      riskPct: r4(fixed),
      kellyF: null,
      usedCalibratedP: false,
      basis: "No calibrated win probability — using fixed risk (Kelly withheld until the meta-label model is promoted).",
    };
  }

  const b = input.rewardToRisk;
  const p = input.pWin;
  const kellyF = (p * (b + 1) - 1) / b; // classic Kelly fraction of capital at this edge
  if (kellyF <= 0) {
    return {
      version: FRACTIONAL_KELLY_VERSION,
      riskPct: 0,
      kellyF: r4(kellyF),
      usedCalibratedP: true,
      basis: `Edge is non-positive at p=${r4(p)}, reward:risk=${r4(b)} (Kelly ${r4(kellyF)}) — no trade.`,
    };
  }
  const risk = Math.min(frac * kellyF * 100, ceiling);
  return {
    version: FRACTIONAL_KELLY_VERSION,
    riskPct: r4(Math.max(0, risk)),
    kellyF: r4(kellyF),
    usedCalibratedP: true,
    basis: `${frac}×Kelly at p=${r4(p)}, reward:risk=${r4(b)} ⇒ ${r4(Math.min(frac * kellyF * 100, ceiling))}% risk (capped at ${ceiling}%).`,
  };
}
