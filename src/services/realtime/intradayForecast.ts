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
import { COST_SCHEDULE_INTRADAY_2024_10, estimateSlippagePct, roundTripCostPct } from "../shortterm/costs";
import { BarrierOutcome, BarrierProbabilities, barrierProbabilities, evaluateBarrierPath } from "./barrierOutcomes";

export const INTRADAY_FORECAST_VERSION = "intraday-forecast-v1";

/**
 * The forecaster's tunable constants, as a value rather than a set of module
 * constants, so the ACTIVE row of `intraday_model_params` can drive the model
 * and a nightly challenger can be promoted without a code change. The named
 * constants below remain as the documented DEFAULTS (= the seeded `ip-v1`).
 *
 * `driftSign`: +1 project the EWMA drift (momentum), −1 invert it
 * (mean-reversion, Roll 1984), 0 withhold direction entirely (the null model:
 * P(up) ≡ 0.5). See docs/intraday-microstructure-notes.md §1–2.
 */
export interface IntradayModelParams {
  driftSign: -1 | 0 | 1;
  driftShrinkage: number;
  driftHalfLifeBars: number;
  minProbability: number;
  maxProbability: number;
  minBarsForForecast: number;
}

/**
 * Horizons, in minutes. All are graded; none is trusted until measured.
 * 1 and 5 are kept as the microstructure probes where the bounce anti-signal
 * is clearest; 15/30/60 are where a +0.5%/−0.3% bracket becomes reachable and
 * a call can, in principle, clear cost (spec §6; intraday-microstructure-notes §3).
 */
export const FORECAST_HORIZONS_MIN = [1, 5, 15, 30, 60] as const;
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

export const DEFAULT_INTRADAY_PARAMS: IntradayModelParams = {
  driftSign: 1,
  driftShrinkage: DRIFT_SHRINKAGE,
  driftHalfLifeBars: DRIFT_HALFLIFE_BARS,
  minProbability: MIN_PROBABILITY,
  maxProbability: MAX_PROBABILITY,
  minBarsForForecast: MIN_BARS_FOR_FORECAST,
};

/**
 * Reference order size for the cost gate. A modest retail clip is the
 * CONSERVATIVE (higher-cost) assumption, because the flat-₹ brokerage cap
 * makes cost fall with size — and a gate deciding whether a call is
 * actionable should err toward "no".
 */
export const COST_REFERENCE_ORDER_INR = 50_000;

/**
 * Round-trip cost (%) of acting on a minute-scale call: fees from the live
 * intraday schedule plus the slippage floor. On 2026-09-23 this was
 * 14.5–20.6 bps against a mean predicted 1-minute move of 0.29 bps and a mean
 * ACTUAL move of 5.79 bps — a perfect oracle loses money at this horizon
 * (docs/intraday-microstructure-notes.md §3). Every forecast carries it.
 */
export function intradayRoundTripCostPct(barVolPct: number | null): number {
  const fees = roundTripCostPct(COST_REFERENCE_ORDER_INR, COST_SCHEDULE_INTRADAY_2024_10);
  const slippage = estimateSlippagePct({
    atrPct: barVolPct != null && barVolPct > 0 ? barVolPct * 20 : null,
    relVolume: 1,
    orderValueInr: COST_REFERENCE_ORDER_INR,
    advInr: null,
  });
  return Math.round((fees + slippage) * 1_000_000) / 1_000_000;
}

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
  /**
   * The momentum-sign direction is ALWAYS recorded (so a stored row can be
   * re-scored under any challenger), but under the null model (driftSign 0)
   * it is WITHHELD from display: `withheld` is true and probabilityUp is 0.5.
   */
  direction: "UP" | "DOWN";
  withheld: boolean;
  /** Round-trip cost (%) of acting on this call at the reference size. */
  roundTripCostPct: number;
  /** Parameter set the forecast was computed under. */
  paramsVersion: string;
  /**
   * The model's own bracket probabilities — P(+0.5% before −0.3%) in the
   * call's direction, over this horizon, from its drift and vol. Null when
   * direction is withheld. This is the quantity that can be economically
   * meaningful; the direction call above mostly cannot (barrierOutcomes.ts).
   */
  barrier: BarrierProbabilities | null;
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
  params?: IntradayModelParams;
  paramsVersion?: string;
}): IntradayForecast | null {
  const { securityId, ticker, bars, horizonMin, now } = opts;
  const p = opts.params ?? DEFAULT_INTRADAY_PARAMS;
  const paramsVersion = opts.paramsVersion ?? "ip-v1";
  if (bars.length < p.minBarsForForecast) return null;

  const last = bars[bars.length - 1];
  const basePrice = last.close;
  if (!Number.isFinite(basePrice) || basePrice <= 0) return null;

  const rets = barReturnsPct(bars);
  if (rets.length < p.minBarsForForecast - 1) return null;

  const barVolPct = stdev(rets);
  // A security with literally no observed variation gives no basis for a
  // probability; refuse rather than emit a degenerate 50/50 with a fake band.
  if (!(barVolPct > 0)) return null;

  // Drift per bar, shrunk. Scaled to the horizon; vol scales with sqrt(t).
  // Under the null model the MOMENTUM sign is still recorded (so the row can
  // be re-scored under any challenger) but the direction is withheld below.
  const effectiveSign = p.driftSign === 0 ? 1 : p.driftSign;
  const driftPerBar = ewma(rets, p.driftHalfLifeBars) * p.driftShrinkage * effectiveSign;
  const expectedReturnPct = driftPerBar * horizonMin;
  const horizonVolPct = barVolPct * Math.sqrt(horizonMin);

  // P(up) from the drift/vol ratio, then clamped: at minute scale the honest
  // range of belief is narrow, and a 90% call would be a lie about precision.
  const withheld = p.driftSign === 0;
  const probabilityUp = withheld ? 0.5 : clamp(normalCdf(expectedReturnPct / horizonVolPct), p.minProbability, p.maxProbability);

  // 80% band ⇒ ±1.2816 sigma.
  const z80 = 1.2815515655446004;
  const direction: "UP" | "DOWN" = expectedReturnPct >= 0 ? "UP" : "DOWN";
  return {
    securityId,
    ticker,
    horizonMin,
    basePrice,
    expectedReturnPct,
    probabilityUp,
    direction,
    withheld,
    roundTripCostPct: intradayRoundTripCostPct(barVolPct),
    paramsVersion,
    barrier: withheld
      ? null
      : barrierProbabilities({ driftPerBarPct: driftPerBar, barVolPct, horizonBars: horizonMin, direction }),
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
   * THE COST GATE. `actionable` is false when |expected move| does not exceed
   * the round-trip cost of acting on it, or when the active model withholds
   * direction. On 2026-09-23 this was false for every 1-minute and every
   * 5-minute forecast issued: the cards showed a target and a stop on trades
   * that could not clear their own fees. Never render levels as a plan when
   * this is false.
   */
  actionable: boolean;
  notActionableReason: string | null;
  roundTripCostPct: number;
  expectedMoveBps: number;
  costBps: number;
  withheld: boolean;
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

  const expectedMoveBps = Math.abs(f.expectedReturnPct) * 100;
  const costBps = f.roundTripCostPct * 100;
  let notActionableReason: string | null = null;
  if (f.withheld) {
    notActionableReason = "the active model withholds direction (null parameters): no call is made";
  } else if (expectedMoveBps <= costBps) {
    notActionableReason =
      `expected move ${expectedMoveBps.toFixed(2)} bps does not clear round-trip cost ${costBps.toFixed(1)} bps ` +
      `(fees + slippage) — a perfect direction call still loses money here`;
  }

  return {
    actionable: notActionableReason === null,
    notActionableReason,
    roundTripCostPct: f.roundTripCostPct,
    expectedMoveBps,
    costBps,
    withheld: f.withheld,
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
  /** |actual move| exceeded the round-trip cost: a perfect call could have netted something. */
  clearsCost: boolean;
  /** Realised return fell inside the forecast's 80% band. */
  inBand80: boolean;
  /**
   * What the realised bar path did against the +0.5%/−0.3% bracket: first
   * hit, MFE/MAE, returns at 5–60 min. Null when no path was available at
   * grading time — missing data, never scored as "no hit".
   */
  barrierOutcome: BarrierOutcome | null;
}

/**
 * Grade a forecast against the realised price.
 *
 * A flat close counts as DOWN, matching the rest of this codebase's
 * convention (`actual > 0 counts as UP`), so the rule cannot be bent after the
 * fact to flatter a result.
 */
export function gradeForecast(
  f: IntradayForecast,
  actualPrice: number,
  gradedAt: number,
  /** Bars covering the forecast window, for the barrier evaluation. Optional: absent ⇒ barrierOutcome null. */
  pathBars?: CompletedBar[]
): GradedForecast | null {
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
    clearsCost: Math.abs(actualReturnPct) > f.roundTripCostPct,
    inBand80: actualReturnPct >= f.low80Pct && actualReturnPct <= f.high80Pct,
    barrierOutcome:
      pathBars && pathBars.length > 0
        ? evaluateBarrierPath({ bars: pathBars, madeAt: f.madeAt, basePrice: f.basePrice, horizonMin: f.horizonMin, direction: f.direction })
        : null,
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
  /**
   * Share of realised returns inside the 80% band. The literature says
   * MAGNITUDE is what is predictable at minute horizons, not sign — so this,
   * not the hit rate, is the metric that can actually be learned. Target 80.
   */
  bandCoverage80Pct: number | null;
  /** Share of graded forecasts whose |actual move| exceeded round-trip cost. */
  clearsCostRatePct: number | null;
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
      bandCoverage80Pct: null,
      clearsCostRatePct: null,
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
  const bandCoverage80Pct = (graded.filter((g) => g.inBand80).length / n) * 100;
  const clearsCostRatePct = (graded.filter((g) => g.clearsCost).length / n) * 100;

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
  note += `; ${clearsCostRatePct.toFixed(1)}% of moves cleared round-trip cost; 80% band held ${bandCoverage80Pct.toFixed(1)}%`;

  return {
    horizonMin,
    graded: n,
    correct,
    hitRatePct,
    meanAbsErrorPct,
    brier,
    meanAbsPredictedPct,
    meanAbsActualPct,
    bandCoverage80Pct,
    clearsCostRatePct,
    unproven,
    note,
  };
}
