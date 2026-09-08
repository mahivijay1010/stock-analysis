/**
 * Python forecasting-worker provider (completion directive, Phase 2) — the
 * clean TS↔Python service boundary. The worker is a stdlib http.server on
 * :5102 (research/worker/worker.py, repo-local venv with scikit-learn); this
 * side degrades gracefully: worker down ⇒ the app and the research harness
 * run WITHOUT ML challengers and say so — never a crash, never a fake result.
 *
 * Models served (sklearn): elastic-net (returns), logistic (direction),
 * hist-gradient-boosting regressor + classifier (the LightGBM-family
 * histogram GBM without fragile native builds).
 */

import { ExternalBatchModel } from "./harness";
import { ModelOutput, PredictRow, TrainRow } from "./models";

const WORKER_URL = process.env.FORECAST_WORKER_URL || "http://127.0.0.1:5102";
const HEALTH_TIMEOUT_MS = 2_000;
const BATCH_TIMEOUT_MS = 300_000;

export async function pythonWorkerAvailable(): Promise<boolean> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${WORKER_URL}/health`, { signal: controller.signal });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

interface WorkerPrediction {
  key: string; // `${ticker}|${date}`
  expectedReturn: number | null;
  rawDirectionProbability: number | null;
  p10: number | null;
  p50: number | null;
  p90: number | null;
}

interface WorkerResponse {
  model: string;
  version: string;
  trainingEndDate: string;
  predictions: WorkerPrediction[];
  error?: string;
}

function toBatchModel(model: string): ExternalBatchModel {
  return {
    name: `py-${model}`,
    version: "worker-v1",
    async fitPredict(
      train: TrainRow[],
      evalRows: PredictRow[],
      horizonDays: number
    ): Promise<Map<string, ModelOutput>> {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), BATCH_TIMEOUT_MS);
      try {
        const res = await fetch(`${WORKER_URL}/fit-predict`, {
          method: "POST",
          signal: controller.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            horizonDays,
            train: train.map((r) => ({ key: `${r.ticker}|${r.date}`, features: r.features, target: r.targetReturn })),
            eval: evalRows.map((r) => ({ key: `${r.ticker}|${r.date}`, features: r.features })),
          }),
        });
        if (!res.ok) throw new Error(`worker ${res.status}: ${await res.text().catch(() => "")}`);
        const body = (await res.json()) as WorkerResponse;
        if (body.error) throw new Error(`worker error: ${body.error}`);
        const out = new Map<string, ModelOutput>();
        for (const p of body.predictions) {
          const [, date] = p.key.split("|");
          out.set(p.key, {
            modelName: `py-${model}`,
            modelVersion: body.version,
            horizonDays,
            expectedReturn: p.expectedReturn,
            medianReturn: p.p50,
            quantiles: p.p10 != null && p.p50 != null && p.p90 != null ? { p10: p.p10, p50: p.p50, p90: p.p90 } : null,
            rawDirectionProbability: p.rawDirectionProbability,
            featureTimestamp: date,
            trainingEndDate: body.trainingEndDate,
          });
        }
        return out;
      } finally {
        clearTimeout(t);
      }
    },
  };
}

export function pythonWorkerModels(): ExternalBatchModel[] {
  return [toBatchModel("elastic-net"), toBatchModel("logistic"), toBatchModel("hgb-regressor"), toBatchModel("hgb-classifier")];
}
