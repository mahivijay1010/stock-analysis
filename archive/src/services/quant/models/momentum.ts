/**
 * Model: momentum — r5/r20/r60 vol-scaled z-scores → fixed logistic.
 * Positive recent returns (relative to the stock's own volatility) push
 * P(up) above 0.5; the horizon coefficient grows modestly because measured
 * momentum persistence is stronger over weeks than over a single day.
 */

import { Horizon } from "../types";
import { DirectionModel, ModelInput } from "./types";
import { clamp, closesOf, logistic, perHorizon, trailingDailyVol, trailingReturn } from "./shared";

/** Fixed per-horizon logistic slopes (precomputed, NO retraining). */
const COEF: Record<Horizon, number> = { 1: 0.35, 3: 0.45, 7: 0.55, 15: 0.6, 30: 0.65 };

const W5 = 0.45;
const W20 = 0.35;
const W60 = 0.2;
const Z_CAP = 4; // z-scores capped so one wild week cannot saturate the model

export const momentumModel: DirectionModel = {
  name: "momentum",
  predict(input: ModelInput): Record<Horizon, number> {
    const closes = closesOf(input.bars);
    const sigma = trailingDailyVol(closes, 60);
    if (sigma === null) return perHorizon(() => 0.5);

    const z = (k: number): number => {
      const r = trailingReturn(closes, k);
      if (r === null) return 0;
      return clamp(r / (sigma * Math.sqrt(k)), -Z_CAP, Z_CAP);
    };
    const raw = W5 * z(5) + W20 * z(20) + W60 * z(60);
    return perHorizon((h) => logistic(COEF[h] * raw));
  },
};

export default momentumModel;
