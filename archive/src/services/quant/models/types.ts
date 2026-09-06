/**
 * V7 Module A1 — model pool shared types (PURE: no DB, no HTTP).
 *
 * Six lightweight direction-probability models, each a FIXED-FORM logistic
 * mapping over features computable from bars (+ optional context). The
 * coefficients are precomputed sensible constants — there is NO daily
 * retraining, so every prediction is deterministic and reproducible.
 */

import { Bar, Horizon } from "../types";

export type ModelName =
  | "momentum"
  | "meanReversion"
  | "trend"
  | "volAdjusted"
  | "sentiment"
  | "macro";

export const MODEL_NAMES: ModelName[] = [
  "momentum",
  "meanReversion",
  "trend",
  "volAdjusted",
  "sentiment",
  "macro",
];

export interface ModelInput {
  bars: Bar[];
  /** Index context (as-of slices in walk-forward use). Optional/null-safe. */
  niftyBars?: Bar[] | null;
  /** News sentiment −100..100 (null → neutral 0 contribution). */
  newsSentimentScore?: number | null;
  /** Market regime score 0..100 (null → neutral 50). */
  regimeScore?: number | null;
}

export interface DirectionModel {
  name: ModelName;
  /**
   * probUp per horizon from features computable from the input.
   * MUST be deterministic; every value clamped to [0.05, 0.95].
   */
  predict(input: ModelInput): Record<Horizon, number>;
}
