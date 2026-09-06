/**
 * V8 R4 — KellySizer. PURE (no DB, no HTTP).
 *
 * f* = p − (1 − p) / b   (Kelly criterion for a p-probability win paying b:1)
 * clamped to [0, 0.25]; the HEADLINE recommendation is HALF-Kelly (f½ = f* / 2):
 * Kelly maximizes log growth ONLY if p and b are estimated exactly right, and
 * ours are noisy measurements — half-Kelly cuts drawdowns roughly in half
 * while keeping ~75% of the growth rate, which is the right trade for
 * estimation error.
 */

export const KELLY_CAP = 0.25;

export interface KellyResult {
  /** Unclamped f* = p − (1−p)/b (can be negative — no edge). */
  rawKelly: number;
  /** f* clamped to [0, KELLY_CAP]. */
  kellyFraction: number;
  /** Headline: kellyFraction / 2. */
  halfKelly: number;
  /** True when rawKelly ≤ 0 — do not size up. */
  noEdge: boolean;
  /** True when rawKelly exceeded the cap and was clamped down. */
  capped: boolean;
}

/**
 * Compute the Kelly fraction. Throws on invalid inputs (p outside [0,1] or
 * b ≤ 0) — callers pass measured values and must not silence bad data.
 */
export function computeKelly(p: number, b: number): KellyResult {
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new Error(`Kelly winRate p must be in [0,1], got ${p}`);
  }
  if (!Number.isFinite(b) || b <= 0) {
    throw new Error(`Kelly payoff b must be > 0, got ${b}`);
  }
  const rawKelly = p - (1 - p) / b;
  const kellyFraction = Math.min(KELLY_CAP, Math.max(0, rawKelly));
  return {
    rawKelly,
    kellyFraction,
    halfKelly: kellyFraction / 2,
    noEdge: rawKelly <= 0,
    capped: rawKelly > KELLY_CAP,
  };
}
