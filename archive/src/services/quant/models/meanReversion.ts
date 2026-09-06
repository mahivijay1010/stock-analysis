/**
 * Model: meanReversion — vol-scaled z-score of price vs SMA20, INVERTED sign.
 * A price stretched above its 20-day average lowers P(up); a depressed price
 * raises it. The effect decays with horizon (mean reversion is a short-term
 * phenomenon), which the fixed per-horizon slopes encode.
 */

import { Horizon } from "../types";
import { DirectionModel, ModelInput } from "./types";
import { clamp, closesOf, logistic, perHorizon, smaLast, trailingDailyVol } from "./shared";

/** Fixed per-horizon logistic slopes — strongest at 1d, weakest at 30d. */
const COEF: Record<Horizon, number> = { 1: 0.8, 3: 0.7, 7: 0.55, 15: 0.35, 30: 0.2 };

const Z_CAP = 4;
/** Dispersion of price around SMA20 scales roughly like σ·√10 over the window. */
const DISPERSION_DAYS = 10;

export const meanReversionModel: DirectionModel = {
  name: "meanReversion",
  predict(input: ModelInput): Record<Horizon, number> {
    const closes = closesOf(input.bars);
    const sma20 = smaLast(closes, 20);
    const sigma = trailingDailyVol(closes, 20);
    if (sma20 === null || sma20 <= 0 || sigma === null) return perHorizon(() => 0.5);

    const price = closes[closes.length - 1];
    const z = clamp(
      (price / sma20 - 1) / (sigma * Math.sqrt(DISPERSION_DAYS)),
      -Z_CAP,
      Z_CAP
    );
    // Inverted: above the mean → P(up) < 0.5.
    return perHorizon((h) => logistic(-COEF[h] * z));
  },
};

export default meanReversionModel;
