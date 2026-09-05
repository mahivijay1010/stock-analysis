/**
 * V7 Module A1 — model pool registry (PURE).
 *
 * Six fixed-form logistic direction models. All deterministic, all clamped to
 * [0.05, 0.95], NO retraining. See each model file for its exact feature set.
 */

import { Horizon } from "../types";
import { DirectionModel, ModelInput, ModelName, MODEL_NAMES } from "./types";
import momentumModel from "./momentum";
import meanReversionModel from "./meanReversion";
import trendModel from "./trend";
import volAdjustedModel from "./volAdjusted";
import sentimentModel from "./sentiment";
import macroModel from "./macro";

export type { DirectionModel, ModelInput, ModelName } from "./types";
export { MODEL_NAMES } from "./types";

export const MODEL_REGISTRY: Record<ModelName, DirectionModel> = {
  momentum: momentumModel,
  meanReversion: meanReversionModel,
  trend: trendModel,
  volAdjusted: volAdjustedModel,
  sentiment: sentimentModel,
  macro: macroModel,
};

export const ALL_MODELS: DirectionModel[] = MODEL_NAMES.map((n) => MODEL_REGISTRY[n]);

/** Run every model on one input → probUp per model per horizon. */
export function predictAll(input: ModelInput): Record<ModelName, Record<Horizon, number>> {
  const out = {} as Record<ModelName, Record<Horizon, number>>;
  for (const model of ALL_MODELS) {
    out[model.name] = model.predict(input);
  }
  return out;
}
