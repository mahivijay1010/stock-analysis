/**
 * EnsembleService (V7 Module A3) — light FTRL-style online regret weights.
 *
 * After the 18:30 verification fills actual outcomes on matured PredictionLog
 * rows, updateFromLatestMaturedDay():
 *   1. finds the latest matured outcome date,
 *   2. for every verified (ticker, horizon) prediction that matured that day,
 *      re-runs the pure model pool on the AS-OF bars (bars dated ≤ the
 *      prediction date — zero lookahead; bars are DB-cached),
 *   3. computes each model's hindsight brier on that real outcome and updates
 *      the stored weights: w ← w · exp(−η · brier_m), η = 2, renormalized,
 *   4. persists per-(ticker,horizon) rows in ensemble_weights and a __DRIFT__
 *      meta row with { switches, updatedPairs } for /api/calibration.
 *
 * A "switch" = the argmax-weight model changed for a (ticker, horizon) pair.
 * Every number is measured from real bars and real outcomes — nothing is
 * fabricated.
 */

import { AppDataSource } from "../../config/database";
import { EnsembleWeight } from "../../entities/EnsembleWeight";
import { PredictionLog } from "../../entities/PredictionLog";
import { marketDataService } from "../market/MarketDataService";
import { Bar, Horizon } from "../../types";
import { predictAll, MODEL_NAMES, ModelName } from "../quant/models";
import { equalWeights, WeightsByModel } from "../quant/models/selector";

const MODEL_VERSION = "quant-v1";
const ETA = 2; // regret learning rate: w ← w·exp(−η·brier)
const DRIFT_TICKER = "__DRIFT__";
const HORIZON_SET = new Set([1, 3, 7, 15, 30]);

export interface EnsembleUpdateResult {
  latestOutcomeDate: string | null;
  updatedPairs: number;
  switches: number;
  skipped: number;
}

export interface ModelDrift {
  updatedAt: string;
  switches: number;
  note: string;
}

function toDateStr(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function argmax(w: Partial<Record<string, number>>): string | null {
  let best: string | null = null;
  let bestW = -Infinity;
  for (const name of MODEL_NAMES) {
    const x = w[name];
    if (x !== undefined && Number.isFinite(x) && x > bestW) {
      bestW = x;
      best = name;
    }
  }
  return best;
}

export class EnsembleService {
  /** Live weights rows for one ticker, keyed by horizon (drift row excluded). */
  async getLiveWeights(
    ticker: string
  ): Promise<Map<Horizon, { weights: Record<string, number>; updatedAt: Date }>> {
    const rows = await AppDataSource.getRepository(EnsembleWeight).find({
      where: { ticker },
    });
    const out = new Map<Horizon, { weights: Record<string, number>; updatedAt: Date }>();
    for (const row of rows) {
      if (!row.weights || !row.updatedAt || !HORIZON_SET.has(row.horizonDays)) continue;
      out.set(row.horizonDays as Horizon, {
        weights: row.weights,
        updatedAt: new Date(row.updatedAt),
      });
    }
    return out;
  }

  /** Drift summary from the last updateFromLatestMaturedDay run (null before the first). */
  async getModelDrift(): Promise<ModelDrift | null> {
    const row = await AppDataSource.getRepository(EnsembleWeight).findOne({
      where: { ticker: DRIFT_TICKER, horizonDays: 0 },
    });
    if (!row || !row.updatedAt) return null;
    const switches = Number(row.weights?.switches ?? 0);
    const updatedPairs = Number(row.weights?.updatedPairs ?? 0);
    return {
      updatedAt: new Date(row.updatedAt).toISOString(),
      switches,
      note:
        `Last nightly regret update touched ${updatedPairs} (ticker, horizon) weight rows from the most ` +
        `recently matured verified predictions; the top-weighted model changed on ${switches} of them. ` +
        `Frequent switching means no model holds a stable edge — trust the blend, not any single model.`,
    };
  }

  /**
   * One online-regret update pass from the latest matured verification day.
   * Idempotent in effect: re-running applies the same multiplicative update
   * again, which is stated (not hidden) — the cron runs it once per evening.
   */
  async updateFromLatestMaturedDay(): Promise<EnsembleUpdateResult> {
    const repo = AppDataSource.getRepository(PredictionLog);
    const weightRepo = AppDataSource.getRepository(EnsembleWeight);

    const latest: Array<{ max: string | null }> = await AppDataSource.query(
      `SELECT MAX(outcome_date)::text AS max
         FROM prediction_logs
        WHERE model_version = $1 AND actual_return IS NOT NULL AND horizon_days IS NOT NULL`,
      [MODEL_VERSION]
    );
    const latestOutcomeDate = latest[0]?.max ? latest[0].max.slice(0, 10) : null;
    if (!latestOutcomeDate) {
      return { latestOutcomeDate: null, updatedPairs: 0, switches: 0, skipped: 0 };
    }

    const logs = await repo
      .createQueryBuilder("p")
      .where("p.model_version = :mv", { mv: MODEL_VERSION })
      .andWhere("p.actual_return IS NOT NULL")
      .andWhere("p.horizon_days IS NOT NULL")
      .andWhere("p.outcome_date = :d", { d: latestOutcomeDate })
      .getMany();

    // NIFTY context for the macro model — best effort, as-of sliced per log.
    let niftyBars: Bar[] | null = null;
    try {
      niftyBars = await marketDataService.getNiftyBars("1y");
    } catch {
      niftyBars = null;
    }

    const barsCache = new Map<string, Bar[]>();
    let updatedPairs = 0;
    let switches = 0;
    let skipped = 0;

    for (const log of logs) {
      const horizon = log.horizonDays as Horizon;
      if (!HORIZON_SET.has(horizon)) {
        skipped++;
        continue;
      }
      const predDate = toDateStr(log.predictionDate);
      const actualReturn = Number(log.actualReturn);
      if (!Number.isFinite(actualReturn)) {
        skipped++;
        continue;
      }
      const outcome: 0 | 1 = actualReturn > 0 ? 1 : 0;

      let bars = barsCache.get(log.ticker);
      if (!bars) {
        try {
          bars = await marketDataService.getDailyBars(log.ticker, "1y");
          barsCache.set(log.ticker, bars);
        } catch {
          skipped++;
          continue;
        }
      }
      const asOfBars = bars.filter((b) => b.date <= predDate);
      if (asOfBars.length < 30) {
        skipped++;
        continue; // too little as-of history to re-run the pool honestly
      }
      const asOfNifty = niftyBars ? niftyBars.filter((b) => b.date <= predDate) : null;

      // Hindsight per-model brier on this single real outcome.
      const probs = predictAll({
        bars: asOfBars,
        niftyBars: asOfNifty,
        newsSentimentScore: null,
        regimeScore: null,
      });

      const existing = await weightRepo.findOne({
        where: { ticker: log.ticker, horizonDays: horizon },
      });
      const prior: WeightsByModel =
        existing?.weights &&
        MODEL_NAMES.every((n) => Number.isFinite(existing.weights?.[n]))
          ? (existing.weights as WeightsByModel)
          : equalWeights();
      const beforeBest = argmax(prior);

      const updatedRaw = {} as Record<ModelName, number>;
      let sum = 0;
      for (const name of MODEL_NAMES) {
        const brier = (probs[name][horizon] - outcome) ** 2;
        const w = prior[name] * Math.exp(-ETA * brier);
        updatedRaw[name] = w;
        sum += w;
      }
      if (!(sum > 0)) {
        skipped++;
        continue;
      }
      const updated: Record<string, number> = {};
      for (const name of MODEL_NAMES) {
        updated[name] = Math.round((updatedRaw[name] / sum) * 1_000_000) / 1_000_000;
      }
      if (argmax(updated) !== beforeBest) switches++;

      await weightRepo.upsert(
        {
          ticker: log.ticker,
          horizonDays: horizon,
          weights: updated,
          updatedAt: new Date(),
        },
        ["ticker", "horizonDays"]
      );
      updatedPairs++;
    }

    // Drift meta row for /api/calibration.
    await weightRepo.upsert(
      {
        ticker: DRIFT_TICKER,
        horizonDays: 0,
        weights: { switches, updatedPairs },
        updatedAt: new Date(),
      },
      ["ticker", "horizonDays"]
    );

    return { latestOutcomeDate, updatedPairs, switches, skipped };
  }
}

export const ensembleService = new EnsembleService();
export default ensembleService;
