/**
 * Model: trend — SMA20/50 cross state + price vs SMA200 + SMA20 slope → fixed
 * logistic. Trend information is weak at 1 day and strongest at 30 days,
 * encoded in the per-horizon slopes.
 */

import { Horizon } from "../types";
import { DirectionModel, ModelInput } from "./types";
import { clamp, closesOf, logistic, perHorizon, smaLast, trailingDailyVol } from "./shared";

/** Fixed per-horizon logistic slopes — trend matters more at longer horizons. */
const COEF: Record<Horizon, number> = { 1: 0.25, 3: 0.3, 7: 0.4, 15: 0.5, 30: 0.6 };

const W_CROSS = 0.9;
const W_P200 = 0.7;
const W_SLOPE = 0.5;
const SLOPE_LOOKBACK = 5; // SMA20 now vs 5 bars ago
const SLOPE_Z_CAP = 2;

const sign = (a: number, b: number): number => (a > b ? 1 : a < b ? -1 : 0);

export const trendModel: DirectionModel = {
  name: "trend",
  predict(input: ModelInput): Record<Horizon, number> {
    const closes = closesOf(input.bars);
    const price = closes.length ? closes[closes.length - 1] : 0;
    const sma20 = smaLast(closes, 20);
    const sma50 = smaLast(closes, 50);
    const sma200 = smaLast(closes, 200);
    const sigma = trailingDailyVol(closes, 60);

    const cross = sma20 !== null && sma50 !== null ? sign(sma20, sma50) : 0;
    const p200 = sma200 !== null && price > 0 ? sign(price, sma200) : 0;

    let slopeZ = 0;
    if (sma20 !== null && sigma !== null && closes.length >= 20 + SLOPE_LOOKBACK) {
      const past = smaLast(closes.slice(0, closes.length - SLOPE_LOOKBACK), 20);
      if (past !== null && past > 0) {
        slopeZ = clamp(
          (sma20 / past - 1) / (sigma * Math.sqrt(SLOPE_LOOKBACK)),
          -SLOPE_Z_CAP,
          SLOPE_Z_CAP
        );
      }
    }

    const raw = W_CROSS * cross + W_P200 * p200 + W_SLOPE * slopeZ;
    return perHorizon((h) => logistic(COEF[h] * raw));
  },
};

export default trendModel;
