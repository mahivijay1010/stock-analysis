/**
 * Model: volAdjusted — 20-day return over trailing σ20·√20 (a Sharpe-like
 * ratio), tanh-squashed into a probability. High risk-adjusted momentum →
 * P(up) above 0.5; the fixed per-horizon amplitude grows slightly with
 * horizon because risk-adjusted drift compounds.
 */

import { Horizon } from "../types";
import { DirectionModel, ModelInput } from "./types";
import { clampProb, closesOf, perHorizon, trailingDailyVol, trailingReturn } from "./shared";

/** Fixed per-horizon amplitudes around 0.5 (max tilt when tanh saturates). */
const AMP: Record<Horizon, number> = { 1: 0.15, 3: 0.2, 7: 0.25, 15: 0.28, 30: 0.3 };

export const volAdjustedModel: DirectionModel = {
  name: "volAdjusted",
  predict(input: ModelInput): Record<Horizon, number> {
    const closes = closesOf(input.bars);
    const r20 = trailingReturn(closes, 20);
    const sigma = trailingDailyVol(closes, 20);
    if (r20 === null || sigma === null) return perHorizon(() => 0.5);

    const sharpeLike = r20 / (sigma * Math.sqrt(20));
    const x = Math.tanh(sharpeLike);
    return perHorizon((h) => clampProb(0.5 + AMP[h] * x));
  },
};

export default volAdjustedModel;
