/**
 * Calibrator registry (completion directive, Phase 7 — display path).
 *
 * The ONLY way a probability reaches the product as "calibrated": the latest
 * PROMOTED CalibratorRecord for (model, horizon) is loaded and applied to the
 * raw probability. No promoted record ⇒ the product must show
 * "Directional probability unavailable — insufficient calibrated evidence."
 * — never the raw model probability dressed up as calibrated.
 */

import { AppDataSource } from "../../config/database";
import { CalibratorRecord } from "../../entities";
import { applyCalibrator, Calibrator } from "./calibration";

export const CALIBRATION_UNAVAILABLE_TEXT =
  "Directional probability unavailable — insufficient calibrated evidence";

export interface DirectionProbabilityStatement {
  horizonDays: number;
  modelName: string;
  /** Raw model probability (0–1) — kept for audit, never displayed as calibrated. */
  rawProbability: number | null;
  /** Calibrated probability (0–1) — null unless a promoted calibrator applied. */
  calibratedProbability: number | null;
  calibratorType: string | null;
  calibratorId: string | null;
  calibratorTrainedThrough: string | null;
  status: "calibrated" | "unavailable";
  statement: string;
}

/** Latest promoted calibrator for (model, horizon), reconstructed from its stored params. */
export async function getLatestPromotedCalibrator(
  modelName: string,
  horizonDays: number
): Promise<{ calibrator: Calibrator; record: CalibratorRecord } | null> {
  const record = await AppDataSource.getRepository(CalibratorRecord).findOne({
    where: { modelName, horizonDays, promoted: true },
    order: { createdAt: "DESC" },
  });
  if (!record || !record.calibratorType || !record.params) return null;
  return {
    calibrator: {
      type: record.calibratorType as Calibrator["type"],
      version: record.version ?? "unknown",
      params: record.params as Calibrator["params"],
      trainingStart: record.trainingStart ?? "",
      trainingEnd: record.trainingEnd ?? "",
      trainedOn: record.effectiveSamples,
    },
    record,
  };
}

/**
 * Resolve what the product may claim about a direction probability.
 * Degrades to "unavailable" on any failure — a DB error must never let a raw
 * probability masquerade as calibrated.
 */
export async function resolveDirectionProbability(
  modelName: string,
  horizonDays: number,
  rawProbability: number | null
): Promise<DirectionProbabilityStatement> {
  const unavailable: DirectionProbabilityStatement = {
    horizonDays,
    modelName,
    rawProbability,
    calibratedProbability: null,
    calibratorType: null,
    calibratorId: null,
    calibratorTrainedThrough: null,
    status: "unavailable",
    statement: CALIBRATION_UNAVAILABLE_TEXT,
  };
  if (rawProbability == null || !Number.isFinite(rawProbability)) return unavailable;
  try {
    const promoted = await getLatestPromotedCalibrator(modelName, horizonDays);
    if (!promoted) return unavailable;
    const p = applyCalibrator(promoted.calibrator, rawProbability);
    return {
      ...unavailable,
      calibratedProbability: Math.round(p * 10000) / 10000,
      calibratorType: promoted.record.calibratorType ?? null,
      calibratorId: promoted.record.id,
      calibratorTrainedThrough: promoted.record.trainingEnd ?? null,
      status: "calibrated",
      statement: `${(p * 100).toFixed(1)}% (calibrated · ${promoted.record.calibratorType}, trained through ${promoted.record.trainingEnd})`,
    };
  } catch {
    return unavailable;
  }
}
