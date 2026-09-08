/**
 * Walk-forward research harness (completion directive, Phase 5) — OFFLINE
 * RESEARCH, clearly labeled: nothing here touches live PredictionLog rows or
 * decision snapshots; results persist as append-only ExperimentRun records.
 *
 * Discipline enforced:
 *  - date-grouped chronological splits with PURGE + EMBARGO (never random),
 *  - features built strictly as-of each date (assertNoLookahead on every row),
 *  - targets = forward h-trading-day ADJUSTED returns,
 *  - metrics reported with rawSamples, overlap-adjusted effectiveSamples AND a
 *    genuinely NON-OVERLAPPING (stride = h trading days) evaluation,
 *  - Newey–West SEs + date-block-bootstrap CIs for uncertainty,
 *  - validation-segment predictions are RETURNED (for the calibration layer)
 *    and never mixed into test metrics.
 *
 * The OLD CHAMPION (quant-v1: analyzeBars directionProb/expected/bands, WITH
 * the NIFTY relative-strength signal — fixing audit §9.4's model mismatch)
 * is evaluated on exactly the same dates as every challenger.
 */

import { NSE_UNIVERSE } from "../../data/nseUniverse";
import { marketDataService } from "../market/MarketDataService";
import { analysisCloses } from "../market/canonical";
import { Bar } from "../market/types";
import { analyzeBars } from "../quant/engine";
import { buildPurgedSplits, dateBlockBootstrap } from "../experiments/splits";
import { mulberry32 } from "../quant/montecarlo";
import { buildFeatures, assertNoLookahead } from "./features";
import { ForecastModel, ModelOutput, TrainRow, PredictRow } from "./models";
import { crpsFromQuantiles, expectedCalibrationError, neweyWestSE, round4 } from "./metrics";

export const HARNESS_VERSION = "walk-forward-harness-v1";

/** Calendar horizon → trading-day offset (the app's standard mapping). */
export const H_TD: Record<number, number> = { 1: 1, 3: 2, 7: 5, 15: 10, 30: 21 };

export interface SampleRow {
  ticker: string;
  date: string;
  features: Record<string, number | null>;
  /** Forward h-TD adjusted return (fraction). */
  target: number;
}

export interface PredRecord {
  ticker: string;
  date: string;
  target: number;
  output: ModelOutput;
}

export interface ExternalBatchModel {
  name: string;
  version: string;
  /** Fit on train, predict for every eval row; keyed by `${ticker}|${date}`. */
  fitPredict(
    train: TrainRow[],
    evalRows: PredictRow[],
    horizonDays: number
  ): Promise<Map<string, ModelOutput>>;
}

export interface ModelHorizonMetrics {
  model: string;
  modelVersion: string;
  horizonDays: number;
  rawSamples: number;
  effectiveSamples: number;
  nonOverlappingSamples: number;
  direction: {
    hitRatePct: number | null;
    hitRateCi80: [number, number] | null; // date-block bootstrap
    brier: number | null;
    brierSkillVsConstant50: number | null;
    logLoss: number | null;
    ece: number | null;
    /** Same metrics on the NON-OVERLAPPING subset. */
    nonOverlapHitRatePct: number | null;
    nonOverlapBrier: number | null;
  };
  returns: {
    maePct: number | null;
    maeNeweyWestSePct: number | null;
    rmsePct: number | null;
    medianAePct: number | null;
  };
  distribution: {
    coverage80Pct: number | null;
    avgWidthPct: number | null;
    crpsApprox: number | null;
  };
}

export interface HarnessResult {
  version: string;
  tickers: string[];
  horizons: number[];
  splitCounts: Record<number, { train: number; validation: number; calibration: number; test: number }>;
  metrics: ModelHorizonMetrics[];
  /** Validation+calibration predictions per model/horizon — calibrator input (Phase 7). */
  validationPredictions: Record<string, PredRecord[]>; // key `${model}|${h}`
  testPredictions: Record<string, PredRecord[]>;
  skipped: string[];
}

const flat = (r: number): 0 | 1 => (r > 0 ? 1 : 0); // stated flat-day rule

function metricsFor(
  model: string,
  modelVersion: string,
  h: number,
  preds: PredRecord[],
  nonOverlap: PredRecord[]
): ModelHorizonMetrics {
  const td = H_TD[h] ?? 1;
  const withProb = preds.filter((p) => p.output.rawDirectionProbability != null);
  const probs = withProb.map((p) => p.output.rawDirectionProbability as number);
  const outcomes = withProb.map((p) => flat(p.target));

  let brier: number | null = null;
  let logLoss: number | null = null;
  let hitRatePct: number | null = null;
  if (withProb.length > 0) {
    brier = round4(probs.reduce((a, p, i) => a + (p - outcomes[i]) ** 2, 0) / probs.length);
    logLoss = round4(
      probs.reduce((a, p, i) => {
        const q = Math.min(1 - 1e-6, Math.max(1e-6, p));
        return a + (outcomes[i] === 1 ? -Math.log(q) : -Math.log(1 - q));
      }, 0) / probs.length
    );
    hitRatePct = round4(
      (withProb.filter((p) => (p.output.rawDirectionProbability as number) > 0.5 === (p.target > 0)).length /
        withProb.length) *
        100
    );
  }

  // Date-block bootstrap CI on hit rate (overlap-aware).
  let hitRateCi80: [number, number] | null = null;
  if (withProb.length >= 30) {
    const dates = [...new Set(withProb.map((p) => p.date))].sort();
    const byDate = new Map<string, PredRecord[]>();
    for (const p of withProb) {
      const l = byDate.get(p.date) ?? [];
      l.push(p);
      byDate.set(p.date, l);
    }
    if (dates.length > td + 1) {
      const draws = dateBlockBootstrap(dates, Math.min(td, dates.length - 1), 300, mulberry32(20260908));
      const rates = draws
        .map((sample) => {
          let hit = 0;
          let n = 0;
          for (const d of sample)
            for (const p of byDate.get(d) ?? []) {
              n++;
              if ((p.output.rawDirectionProbability as number) > 0.5 === (p.target > 0)) hit++;
            }
          return n > 0 ? (hit / n) * 100 : NaN;
        })
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      if (rates.length >= 100) {
        hitRateCi80 = [round4(rates[Math.floor(rates.length * 0.1)]), round4(rates[Math.floor(rates.length * 0.9)])];
      }
    }
  }

  const withRet = preds.filter((p) => p.output.expectedReturn != null);
  const errsPct = withRet.map((p) => Math.abs((p.output.expectedReturn as number) - p.target) * 100);
  const sqErrs = withRet.map((p) => (((p.output.expectedReturn as number) - p.target) * 100) ** 2);
  const sortedErrs = [...errsPct].sort((a, b) => a - b);

  const withQ = preds.filter((p) => p.output.quantiles != null);
  let coverage80: number | null = null;
  let width: number | null = null;
  let crps: number | null = null;
  if (withQ.length > 0) {
    const inBand = withQ.filter(
      (p) => p.target >= (p.output.quantiles as { p10: number }).p10 && p.target <= (p.output.quantiles as { p90: number }).p90
    ).length;
    coverage80 = round4((inBand / withQ.length) * 100);
    width = round4(
      (withQ.reduce((a, p) => a + ((p.output.quantiles as { p90: number }).p90 - (p.output.quantiles as { p10: number }).p10), 0) /
        withQ.length) *
        100
    );
    crps = round4(
      (withQ.reduce((a, p) => a + crpsFromQuantiles(p.output.quantiles as { p10: number; p50: number; p90: number }, p.target), 0) /
        withQ.length) *
        100
    );
  }

  const noWithProb = nonOverlap.filter((p) => p.output.rawDirectionProbability != null);
  const noBrier =
    noWithProb.length > 0
      ? round4(
          noWithProb.reduce((a, p) => a + ((p.output.rawDirectionProbability as number) - flat(p.target)) ** 2, 0) /
            noWithProb.length
        )
      : null;
  const noHit =
    noWithProb.length > 0
      ? round4(
          (noWithProb.filter((p) => (p.output.rawDirectionProbability as number) > 0.5 === (p.target > 0)).length /
            noWithProb.length) *
            100
        )
      : null;

  return {
    model,
    modelVersion,
    horizonDays: h,
    rawSamples: preds.length,
    effectiveSamples: Math.max(1, Math.floor(preds.length / td)),
    nonOverlappingSamples: nonOverlap.length,
    direction: {
      hitRatePct,
      hitRateCi80,
      brier,
      brierSkillVsConstant50: brier != null ? round4((0.25 - brier) / 0.25) : null,
      logLoss,
      ece: withProb.length > 0 ? expectedCalibrationError(probs, outcomes) : null,
      nonOverlapHitRatePct: noHit,
      nonOverlapBrier: noBrier,
    },
    returns: {
      maePct: errsPct.length ? round4(errsPct.reduce((a, b) => a + b, 0) / errsPct.length) : null,
      maeNeweyWestSePct: errsPct.length ? round4(neweyWestSE(errsPct, Math.max(0, td - 1)) ?? NaN) : null,
      rmsePct: sqErrs.length ? round4(Math.sqrt(sqErrs.reduce((a, b) => a + b, 0) / sqErrs.length)) : null,
      medianAePct: sortedErrs.length ? round4(sortedErrs[Math.floor(sortedErrs.length / 2)]) : null,
    },
    distribution: { coverage80Pct: coverage80, avgWidthPct: width, crpsApprox: crps },
  };
}

export interface HarnessOptions {
  tickers?: string[];
  horizons?: number[];
  models: ForecastModel[];
  externalModels?: ExternalBatchModel[];
  includeChampion?: boolean;
  warmupBars?: number;
  log?: (msg: string) => void;
}

export async function runWalkForward(opts: HarnessOptions): Promise<HarnessResult> {
  const log = opts.log ?? (() => undefined);
  const tickers = opts.tickers ?? NSE_UNIVERSE.slice(0, 40).map((u) => u.ticker);
  const horizons = opts.horizons ?? [1, 7, 30];
  const warmup = opts.warmupBars ?? 210;
  const skipped: string[] = [];

  const [niftyBars, vixBars] = await Promise.all([
    marketDataService.getNiftyBars("2y").catch(() => null),
    marketDataService.getIndiaVixBars("2y").catch(() => null),
  ]);

  // ── build per-ticker samples (features as-of each date, adjusted targets) ──
  const perTicker = new Map<string, { bars: Bar[]; rows: Map<number, SampleRow[]> }>();
  for (const ticker of tickers) {
    try {
      const { bars } = await marketDataService.getDailyBarsWithSource(ticker, "2y");
      if (bars.length < warmup + 40) {
        skipped.push(`${ticker}: only ${bars.length} bars`);
        continue;
      }
      const closes = analysisCloses(bars);
      const rows = new Map<number, SampleRow[]>();
      for (const h of horizons) rows.set(h, []);
      for (let i = warmup; i < bars.length - 1; i++) {
        const fv = buildFeatures(ticker, bars, i, { nifty: niftyBars, vix: vixBars });
        assertNoLookahead(fv); // hard leakage guard on EVERY research row
        const features: Record<string, number | null> = {};
        for (const [k, v] of Object.entries(fv.features)) features[k] = v.value;
        for (const h of horizons) {
          const td = H_TD[h] ?? h;
          const j = i + td;
          if (j >= bars.length) continue;
          if (closes[i] > 0) {
            rows.get(h)!.push({ ticker, date: bars[i].date, features, target: closes[j] / closes[i] - 1 });
          }
        }
      }
      perTicker.set(ticker, { bars, rows });
    } catch (e) {
      skipped.push(`${ticker}: ${(e as Error).message}`);
    }
  }
  log(`samples built for ${perTicker.size} tickers (${skipped.length} skipped)`);

  const result: HarnessResult = {
    version: HARNESS_VERSION,
    tickers: [...perTicker.keys()],
    horizons,
    splitCounts: {},
    metrics: [],
    validationPredictions: {},
    testPredictions: {},
    skipped,
  };

  for (const h of horizons) {
    const td = H_TD[h] ?? h;
    // Pool rows across tickers, grouped BY DATE for the chronological split.
    const all: SampleRow[] = [];
    for (const { rows } of perTicker.values()) all.push(...(rows.get(h) ?? []));
    const dates = [...new Set(all.map((r) => r.date))].sort();
    if (dates.length < 60) {
      result.skipped.push(`${h}d: only ${dates.length} distinct dates`);
      continue;
    }
    const splits = buildPurgedSplits({
      dates,
      horizonDays: Math.ceil((td * 7) / 5) + 2, // trading→calendar purge window
      embargoDays: 3,
      trainFrac: 0.55,
      valFrac: 0.15,
      calFrac: 0.1,
    });
    const seg = (ds: string[]) => {
      const set = new Set(ds);
      return all.filter((r) => set.has(r.date));
    };
    const train = seg(splits.train);
    const valRows = seg([...splits.validation, ...splits.calibration]);
    const test = seg(splits.test);
    result.splitCounts[h] = {
      train: train.length,
      validation: seg(splits.validation).length,
      calibration: seg(splits.calibration).length,
      test: test.length,
    };
    log(`${h}d: train ${train.length} / valcal ${valRows.length} / test ${test.length} rows`);

    // Non-overlapping test subset: stride = td over the test DATES.
    const testDates = [...new Set(test.map((r) => r.date))].sort();
    const strideDates = new Set(testDates.filter((_, i) => i % td === 0));

    const record = (model: string, preds: PredRecord[], key: string) => {
      const nonOverlap = preds.filter((p) => strideDates.has(p.date));
      const mv = preds[0]?.output.modelVersion ?? "v?";
      result.metrics.push(metricsFor(model, mv, h, preds, nonOverlap));
      result.testPredictions[key] = preds;
    };

    const asTrainRows = (rows: SampleRow[]) =>
      rows.map((r) => ({ ticker: r.ticker, date: r.date, features: r.features, targetReturn: r.target }));

    // TS models: fit on train, predict on val (for calibrators) and test.
    for (const model of opts.models) {
      model.fit(asTrainRows(train));
      const valPreds: PredRecord[] = valRows.map((r) => ({
        ticker: r.ticker,
        date: r.date,
        target: r.target,
        output: model.predict({ ticker: r.ticker, date: r.date, features: r.features }, h),
      }));
      const testPreds: PredRecord[] = test.map((r) => ({
        ticker: r.ticker,
        date: r.date,
        target: r.target,
        output: model.predict({ ticker: r.ticker, date: r.date, features: r.features }, h),
      }));
      result.validationPredictions[`${model.name}|${h}`] = valPreds;
      record(model.name, testPreds, `${model.name}|${h}`);
    }

    // External (Python) batch models.
    for (const ext of opts.externalModels ?? []) {
      try {
        const evalRows: PredictRow[] = [...valRows, ...test].map((r) => ({ ticker: r.ticker, date: r.date, features: r.features }));
        const out = await ext.fitPredict(asTrainRows(train), evalRows, h);
        const mk = (rows: SampleRow[]): PredRecord[] =>
          rows
            .map((r) => {
              const o = out.get(`${r.ticker}|${r.date}`);
              return o ? { ticker: r.ticker, date: r.date, target: r.target, output: o } : null;
            })
            .filter((x): x is PredRecord => x != null);
        result.validationPredictions[`${ext.name}|${h}`] = mk(valRows);
        record(ext.name, mk(test), `${ext.name}|${h}`);
      } catch (e) {
        result.skipped.push(`${ext.name}@${h}d: ${(e as Error).message}`);
      }
    }

    // OLD CHAMPION (quant-v1) on the same val+test dates.
    if (opts.includeChampion !== false) {
      const champ = (rows: SampleRow[]): PredRecord[] => {
        const preds: PredRecord[] = [];
        for (const r of rows) {
          const t = perTicker.get(r.ticker);
          if (!t) continue;
          const idx = t.bars.findIndex((b) => b.date === r.date);
          if (idx < 60) continue;
          try {
            const slicedNifty = niftyBars ? niftyBars.filter((b) => b.date <= r.date) : undefined;
            const a = analyzeBars(t.bars.slice(0, idx + 1), slicedNifty ? { niftyBars: slicedNifty } : undefined);
            const p = a.predictions.find((x) => x.horizonDays === h);
            if (!p) continue;
            preds.push({
              ticker: r.ticker,
              date: r.date,
              target: r.target,
              output: {
                modelName: "champion-quant-v1",
                modelVersion: "quant-v1",
                horizonDays: h,
                expectedReturn: p.expectedReturnPct / 100,
                medianReturn: p.expectedReturnPct / 100,
                quantiles: { p10: p.low80Pct / 100, p50: p.expectedReturnPct / 100, p90: p.high80Pct / 100 },
                rawDirectionProbability: p.directionProb,
                featureTimestamp: r.date,
                trainingEndDate: r.date,
              },
            });
          } catch {
            /* insufficient bars for a slice — skip honestly */
          }
        }
        return preds;
      };
      result.validationPredictions[`champion-quant-v1|${h}`] = champ(valRows);
      record("champion-quant-v1", champ(test), `champion-quant-v1|${h}`);
      log(`${h}d: champion evaluated`);
    }
  }

  return result;
}
