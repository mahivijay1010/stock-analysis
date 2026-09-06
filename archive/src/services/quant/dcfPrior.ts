/**
 * V10 B3 — DCF-implied Kelly payoff prior. PURE (no DB, no HTTP).
 *
 * PRE-MEASUREMENT ONLY: when the desk has no usable measured payoff
 * (<10 closed trades with both wins and losses), the structural 1.5 can be
 * replaced by a prior derived from the ticker's STORED Intelligence DCF
 * scenarios (bear/base/bull intrinsic values from NSE-filing FCF):
 *
 *   b_prior = (base-or-bull intrinsic upside vs current price)
 *             ─────────────────────────────────────────────────
 *             |bear intrinsic downside vs current price|
 *
 * clamped to [DCF_PRIOR_MIN, DCF_PRIOR_MAX] = [0.5, 3.0] — DCF outputs are
 * assumption-sensitive estimates, so the prior is never allowed to claim an
 * extreme payoff. Measured b ALWAYS wins once usable; this prior only ever
 * replaces the structural assumption, never a measurement.
 */

export const DCF_PRIOR_MIN = 0.5;
export const DCF_PRIOR_MAX = 3.0;

/** The exact source label SPEC_V10 mandates for a DCF-implied payoff. */
export const DCF_PRIOR_SOURCE_LABEL =
  "DCF-implied (assumption-sensitive — bear/base/bull scenarios, not measured)";

export interface DcfScenarioLevels {
  /** Intrinsic value per share under each stored scenario (₹). */
  bear: number | null;
  base: number | null;
  bull: number | null;
}

export interface DcfImpliedPayoff {
  /** The clamped prior b ∈ [0.5, 3.0]. */
  b: number;
  /** The raw (unclamped) upside/|downside| ratio. */
  raw: number;
  /** True when the raw ratio was clamped into the [0.5, 3.0] band. */
  clamped: boolean;
  /** Which scenario supplied the upside ('base' preferred, 'bull' fallback). */
  upsideScenario: "base" | "bull";
  /** Upside of that scenario vs the current price, % (can be ≤ 0). */
  upsidePct: number;
  /** Bear-scenario move vs the current price, % (negative = real downside). */
  bearPct: number;
  /** The price the ratio was computed against. */
  price: number;
}

const finite = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

/**
 * Compute the DCF-implied payoff prior, or null when it cannot be computed
 * honestly (no bear scenario, no usable upside scenario, non-positive price,
 * or a bear value exactly at the price — a zero denominator defines nothing).
 */
export function dcfImpliedPayoff(
  levels: DcfScenarioLevels,
  currentPrice: number | null
): DcfImpliedPayoff | null {
  if (!finite(currentPrice) || currentPrice <= 0) return null;
  if (!finite(levels.bear)) return null;

  // Upside: base preferred; bull only when base implies no upside at all.
  let upsideScenario: "base" | "bull" | null = null;
  let upsideValue: number | null = null;
  if (finite(levels.base) && levels.base > currentPrice) {
    upsideScenario = "base";
    upsideValue = levels.base;
  } else if (finite(levels.bull) && levels.bull > currentPrice) {
    upsideScenario = "bull";
    upsideValue = levels.bull;
  } else if (finite(levels.base)) {
    // No scenario implies upside — keep base and let the 0.5 floor clamp it;
    // the DCF still carries payoff information (it says: poor).
    upsideScenario = "base";
    upsideValue = levels.base;
  } else if (finite(levels.bull)) {
    upsideScenario = "bull";
    upsideValue = levels.bull;
  }
  if (upsideScenario === null || upsideValue === null) return null;

  const denominator = Math.abs(levels.bear - currentPrice);
  if (!(denominator > 0)) return null; // bear exactly at price — undefined ratio

  const raw = (upsideValue - currentPrice) / denominator;
  const b = Math.min(DCF_PRIOR_MAX, Math.max(DCF_PRIOR_MIN, raw));

  return {
    b: Number(b.toFixed(4)),
    raw: Number(raw.toFixed(4)),
    clamped: raw < DCF_PRIOR_MIN || raw > DCF_PRIOR_MAX,
    upsideScenario,
    upsidePct: Number((((upsideValue - currentPrice) / currentPrice) * 100).toFixed(2)),
    bearPct: Number((((levels.bear - currentPrice) / currentPrice) * 100).toFixed(2)),
    price: currentPrice,
  };
}
