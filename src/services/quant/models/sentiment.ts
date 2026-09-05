/**
 * Model: sentiment — newsSentimentScore (−100..100; null → 0, i.e. a neutral
 * 0.5 contribution) blended with the vol-scaled 5-day return. News decays
 * fast, so the fixed per-horizon slopes shrink with horizon.
 */

import { Horizon } from "../types";
import { DirectionModel, ModelInput } from "./types";
import { clamp, closesOf, logistic, perHorizon, trailingDailyVol, trailingReturn } from "./shared";

/** Fixed per-horizon logistic slopes — news matters most in the next days. */
const COEF: Record<Horizon, number> = { 1: 0.9, 3: 0.8, 7: 0.6, 15: 0.4, 30: 0.3 };

const W_SENT = 1.2;
const W_R5 = 0.4;
const Z_CAP = 4;

export const sentimentModel: DirectionModel = {
  name: "sentiment",
  predict(input: ModelInput): Record<Horizon, number> {
    const s =
      input.newsSentimentScore !== null &&
      input.newsSentimentScore !== undefined &&
      Number.isFinite(input.newsSentimentScore)
        ? clamp(input.newsSentimentScore, -100, 100) / 100
        : 0; // null → 0 → pure-neutral contribution

    const closes = closesOf(input.bars);
    const r5 = trailingReturn(closes, 5);
    const sigma = trailingDailyVol(closes, 60);
    const z5 =
      r5 !== null && sigma !== null
        ? Math.tanh(clamp(r5 / (sigma * Math.sqrt(5)), -Z_CAP, Z_CAP))
        : 0;

    const raw = W_SENT * s + W_R5 * z5;
    return perHorizon((h) => logistic(COEF[h] * raw));
  },
};

export default sentimentModel;
