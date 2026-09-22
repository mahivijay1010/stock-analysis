/**
 * Intraday 1-minute and 5-minute forecasts from completed live bars — PURE.
 *
 * WHAT THIS IS HONESTLY WORTH, stated before the code so it cannot be read as
 * more than it is:
 *
 *   - This system's first live grading (2026-09-21, n=154, 1-DAY horizon)
 *     scored a 47.4% direction hit rate — below a coin flip — and its
 *     probabilities were INVERTED where confidence was highest
 *     (docs/system-trust-review.md §14).
 *   - The out-of-sample setup study found 0 of 12 short-term setups with a
 *     positive edge (§13.1).
 *   - A 1-minute horizon is a HARDER problem than the 1-day horizon that
 *     produced those numbers, not an easier one. Microstructure noise
 *     dominates at this scale and the bid-ask spread alone typically exceeds
 *     the entire predicted move.
 *
 * So these forecasts are produced to be MEASURED, not to be traded. Every one
 * is logged before its horizon elapses and graded against what actually
 * happened, and the UI shows the measured hit rate beside the forecast. If the
 * model has no skill, that will be visible in this system's own numbers within
 * an hour of trading rather than argued about.
 *
 * The model itself is deliberately simple and transparent — an EWMA drift term
 * damped toward zero, with realized volatility setting the band. A complicated
 * model would not be more skillful here; it would only be harder to falsify.
 * Every term is observable and every constant is named.
 */

import { CompletedBar } from "./types";

export const INTRADAY_FORECAST_VERSION = "intraday-forecast-v1";

/** Horizons, in minutes. Both are graded; neither is trusted until measured. */
export const FORECAST_HORIZONS_MIN = [1, 5] as const;
export type ForecastHorizonMin = (typeof FORECAST_HORIZONS_MIN)[number];

/**
 * Minimum completed bars before a forecast is emitted at all.
 *
 * Below this the volatility estimate is meaningless and the drift term is
 * pure noise. Emitting anyway would produce confident-looking output from
 * nothing, which is the failure mode this file exists to avoid.
 */
export const MIN_BARS_FOR_FORECAST = 10;

/**
 * EWMA half-life in bars for the drift estimate. Short enough to react within
 * a session, long enough that one bar cannot swing the call.
 */
export const DRIFT_HALFLIFE_BARS = 10;

/**
 * Drift is shrunk toward zero by this factor before being projected.
 *
 * Minute-scale drift estimated from ~20 bars is overwhelmingly noise. Shrinkage
 * is the honest response to that: it keeps the sign information while refusing
 * to extrapolate a magnitude the data cannot support. 0.25 is a judgement call
 * made BEFORE seeing any live result, and is recorded here so that a later
 * change to it is visible as a change.
 */
export const DRIFT_SHRINKAGE = 0.25;

/** Probabilities are clamped to this band — no minute-scale call is 90% sure. */
export const MAX_PROBABILITY = 0.65;
export const MIN_PROBABILITY = 0.35;

export interface IntradayForecast {
  securityId: string;
  ticker: string;
  horizonMin: ForecastHorizonMin;
  /** Bar close the forecast is made from — the price the outcome is measured against. */
  basePrice: number;
  /** Expected return over the horizon, in percent. */
  expectedReturnPct: number;
  /** P(close higher than basePrice at horizon). Clamped; never extreme. */
  probabilityUp: number;
  direction: "UP" | "DOWN";
  /** 80% band on the return, in percent, from realized volatility. */
  low80Pct: number;
  high80Pct: number;
  /** Realized per-bar volatility (%), the band's basis. */
  barVolPct: number;
  barsUsed: number;
  /** Instant the forecast was made, and when it can be graded. */
  madeAt: number;
  resolveAt: number;
  modelVersion: string;
}

/** Log-return series between consecutive completed bar closes, in percent. */
function barReturnsPct(bars: CompletedBar[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].close;
    const cur = bars[i].close;
    if (prev > 0 && cur > 0 && Number.isFinite(prev) && Number.isFinite(cur)) {
      out.push((Math.log(cur / prev)) * 100);
    }
  }
  return out;
}

/** EWMA of a series, most recent weighted highest. */
function ewma(values: number[], halfLife: number): number {
  if (values.length === 0) return 0;
  const lambda = Math.log(2) / halfLife;
  let num = 0;
  let den = 0;
  for (let i = 0; i < values.length; i++) {
    const age = values.length - 1 - i;
    const w = Math.exp(-lambda * age);
    num += w * values[i];
    den += w;
  }
  return den > 0 ? num / den : 0;
}

/** Population standard deviation. */
function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const v = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(v);
}

/** Normal CDF (Abramowitz–Stegun 7.1.26), for turning drift/vol into P(up). */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-(z * z) / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Forecast one security at one horizon, or null when the data cannot support
 * one. Returning null is the correct answer far more often than it is
 * inconvenient — a forecast from 3 bars is not a weak forecast, it is noise
 * with a number attached.
 */
export function forecastOne(opts: {
  securityId: string;
  ticker: string;
  bars: CompletedBar[];
  horizonMin: ForecastHorizonMin;
  now: number;
}): IntradayForecast | null {
  const { securityId, ticker, bars, horizonMin, now } = opts;
  if (bars.length < MIN_BARS_FOR_FORECAST) return null;

  const last = bars[bars.length - 1];
  const basePrice = last.close;
  if (!Number.isFinite(basePrice) || basePrice <= 0) return null;

  const rets = barReturnsPct(bars);
  if (rets.length < MIN_BARS_FOR_FORECAST - 1) return null;

  const barVolPct = stdev(rets);
  // A security with literally no observed variation gives no basis for a
  // probability; refuse rather than emit a degenerate 50/50 with a fake band.
  if (!(barVolPct > 0)) return null;

  // Drift per bar, shrunk. Scaled to the horizon; vol scales with sqrt(t).
  const driftPerBar = ewma(rets, DRIFT_HALFLIFE_BARS) * DRIFT_SHRINKAGE;
  const expectedReturnPct = driftPerBar * horizonMin;
  const horizonVolPct = barVolPct * Math.sqrt(horizonMin);

  // P(up) from the drift/vol ratio, then clamped: at minute scale the honest
  // range of belief is narrow, and a 90% call would be a lie about precision.
  const probabilityUp = clamp(normalCdf(expectedReturnPct / horizonVolPct), MIN_PROBABILITY, MAX_PROBABILITY);

  // 80% band ⇒ ±1.2816 sigma.
  const z80 = 1.2815515655446004;
  return {
    securityId,
    ticker,
    horizonMin,
    basePrice,
    expectedReturnPct,
    probabilityUp,
    direction: probabilityUp >= 0.5 ? "UP" : "DOWN",
    low80Pct: expectedReturnPct - z80 * horizonVolPct,
    high80Pct: expectedReturnPct + z80 * horizonVolPct,
    barVolPct,
    barsUsed: bars.length,
    madeAt: now,
    resolveAt: now + horizonMin * 60_000,
    modelVersion: INTRADAY_FORECAST_VERSION,
  };
}

/**
 * Entry/exit levels, derived FROM the forecast already computed — never a
 * separate model, so a level can never disagree with the forecast beside it.
 *
 * These are shown UNCONDITIONALLY, at the user's explicit direction, even
 * though the horizon backing them may have no demonstrated edge yet
 * (docs/system-trust-review.md §14: the 1-day model's first live grading was
 * 47.4%, below a coin flip). That is exactly why every level below carries
 * the measured accuracy of the horizon that produced it as a required,
 * co-equal field — not a caveat elsewhere on the page. The plan is for
 * accuracy to improve as the calibration loop runs (docs/tsp-study-notes.md);
 * until it does, these levels are a plan for what the CURRENT model would do,
 * not a claim that following them makes money.
 *
 * Levels, all derived from the SAME 80% band already in the forecast:
 *   entryLow / entryHigh  — a narrow zone around basePrice (±0.15 bar-sigma),
 *                           not a single tick, because a live price moves
 *                           between the forecast instant and any action on it.
 *   stopLossPct/Price     — the 80% band's ADVERSE edge. If the model's own
 *                           calibrated range is wrong 20% of the time, a stop
 *                           inside that range is not a safety margin at all;
 *                           it must sit AT OR BEYOND the model's own admitted
 *                           uncertainty, never inside it.
 *   targetPct/Price       — the 80% band's FAVOURABLE edge, symmetric to the
 *                           stop. Not the full expected move — the expected
 *                           move is a MEAN, and exiting at the mean captures
 *                           only half of what the model's own band allows.
 *   riskRewardRatio        — reward:risk on these two levels. Below 1 is
 *                           flagged, because it means the position risks more
 *                           than it targets even if the direction call is
 *                           right.
 */
export interface EntryExitPlan {
  securityId: string;
  ticker: string;
  horizonMin: ForecastHorizonMin;
  direction: "UP" | "DOWN";
  basePrice: number;
  entryLow: number;
  entryHigh: number;
  stopLossPct: number;
  stopLossPrice: number;
  targetPct: number;
  targetPrice: number;
  riskRewardRatio: number | null;
  /** Copied from the forecast so the plan is self-contained for the UI. */
  probabilityUp: number;
  resolveAt: number;
  /**
   * This horizon's measured accuracy, as of when the plan was built — the
   * field this function exists to make impossible to omit.
   */
  accuracy: {
    graded: number;
    hitRatePct: number | null;
    unproven: boolean;
    note: string;
  };
}

/** Narrow entry-zone half-width, in units of bar-sigma. Not a single tick. */
const ENTRY_ZONE_SIGMA = 0.15;

export function buildEntryExitPlan(f: IntradayForecast, accuracy: HorizonScore): EntryExitPlan {
  const zoneWidthPct = f.barVolPct * ENTRY_ZONE_SIGMA;
  const entryLow = f.basePrice * (1 - zoneWidthPct / 100);
  const entryHigh = f.basePrice * (1 + zoneWidthPct / 100);

  // Favourable/adverse edges depend on direction: for a DOWN call, the
  // favourable edge is the LOWER (more negative) side of the band.
  const favourablePct = f.direction === "UP" ? f.high80Pct : f.low80Pct;
  const adversePct = f.direction === "UP" ? f.low80Pct : f.high80Pct;

  const targetPrice = f.basePrice * (1 + favourablePct / 100);
  const stopLossPrice = f.basePrice * (1 + adversePct / 100);

  const rewardAbs = Math.abs(targetPrice - f.basePrice);
  const riskAbs = Math.abs(f.basePrice - stopLossPrice);
  const riskRewardRatio = riskAbs > 0 ? rewardAbs / riskAbs : null;

  return {
    securityId: f.securityId,
    ticker: f.ticker,
    horizonMin: f.horizonMin,
    direction: f.direction,
    basePrice: f.basePrice,
    entryLow,
    entryHigh,
    stopLossPct: adversePct,
    stopLossPrice,
    targetPct: favourablePct,
    targetPrice,
    riskRewardRatio,
    probabilityUp: f.probabilityUp,
    resolveAt: f.resolveAt,
    accuracy: {
      graded: accuracy.graded,
      hitRatePct: accuracy.hitRatePct,
      unproven: accuracy.unproven,
      note: accuracy.note,
    },
  };
}

export type GradeOutcome = "CORRECT" | "WRONG";

export interface GradedForecast extends IntradayForecast {
  actualPrice: number;
  actualReturnPct: number;
  actualDirection: "UP" | "DOWN";
  outcome: GradeOutcome;
  /** actual − expected, in percentage points. */
  errorPct: number;
  gradedAt: number;
}

/**
 * Grade a forecast against the realised price.
 *
 * A flat close counts as DOWN, matching the rest of this codebase's
 * convention (`actual > 0 counts as UP`), so the rule cannot be bent after the
 * fact to flatter a result.
 */
export function gradeForecast(f: IntradayForecast, actualPrice: number, gradedAt: number): GradedForecast | null {
  if (!Number.isFinite(actualPrice) || actualPrice <= 0) return null;
  const actualReturnPct = (Math.log(actualPrice / f.basePrice)) * 100;
  const actualDirection: "UP" | "DOWN" = actualReturnPct > 0 ? "UP" : "DOWN";
  return {
    ...f,
    actualPrice,
    actualReturnPct,
    actualDirection,
    outcome: actualDirection === f.direction ? "CORRECT" : "WRONG",
    errorPct: actualReturnPct - f.expectedReturnPct,
    gradedAt,
  };
}

export interface HorizonScore {
  horizonMin: ForecastHorizonMin;
  graded: number;
  correct: number;
  /** Null until MIN_GRADED_FOR_RATE outcomes exist — a rate below that is noise. */
  hitRatePct: number | null;
  /** Mean |actual − expected| in percentage points. */
  meanAbsErrorPct: number | null;
  /** Brier score against the stated probabilities. 0.25 = always saying 50%. */
  brier: number | null;
  /** Mean absolute predicted move vs mean absolute actual move — the §14.4 check. */
  meanAbsPredictedPct: number | null;
  meanAbsActualPct: number | null;
  /** True while the sample cannot support any claim of skill. */
  unproven: boolean;
  note: string;
}

/** Matches EvidenceService.MIN_GRADED_FOR_RATE so surfaces cannot disagree. */
export const MIN_GRADED_FOR_RATE = 10;

/**
 * Score a horizon's graded forecasts.
 *
 * `unproven` stays true until the sample is both large enough AND the hit rate
 * is meaningfully above 50%. It is deliberately NOT a claim of skill — it is
 * the absence of a claim, and the UI shows it beside every forecast.
 */
export function scoreHorizon(horizonMin: ForecastHorizonMin, graded: GradedForecast[]): HorizonScore {
  const n = graded.length;
  if (n === 0) {
    return {
      horizonMin,
      graded: 0,
      correct: 0,
      hitRatePct: null,
      meanAbsErrorPct: null,
      brier: null,
      meanAbsPredictedPct: null,
      meanAbsActualPct: null,
      unproven: true,
      note: "no graded outcomes yet",
    };
  }

  const correct = graded.filter((g) => g.outcome === "CORRECT").length;
  const hitRatePct = n >= MIN_GRADED_FOR_RATE ? (correct / n) * 100 : null;
  const meanAbsErrorPct = graded.reduce((a, g) => a + Math.abs(g.errorPct), 0) / n;
  // Brier over the stated P(up) against the realised up/down.
  const brier = graded.reduce((a, g) => a + (g.probabilityUp - (g.actualDirection === "UP" ? 1 : 0)) ** 2, 0) / n;
  const meanAbsPredictedPct = graded.reduce((a, g) => a + Math.abs(g.expectedReturnPct), 0) / n;
  const meanAbsActualPct = graded.reduce((a, g) => a + Math.abs(g.actualReturnPct), 0) / n;

  const enough = n >= MIN_GRADED_FOR_RATE;
  const beatsCoinFlip = hitRatePct != null && hitRatePct > 50;
  const unproven = !enough || !beatsCoinFlip;

  let note: string;
  if (!enough) {
    note = `${n} graded — need ${MIN_GRADED_FOR_RATE} before a hit rate means anything`;
  } else if (!beatsCoinFlip) {
    note = `${hitRatePct!.toFixed(1)}% of ${n} — at or below a coin flip, no demonstrated edge`;
  } else {
    note = `${hitRatePct!.toFixed(1)}% of ${n} — above 50%, but a single session is not evidence of skill`;
  }

  return {
    horizonMin,
    graded: n,
    correct,
    hitRatePct,
    meanAbsErrorPct,
    brier,
    meanAbsPredictedPct,
    meanAbsActualPct,
    unproven,
    note,
  };
}
