/**
 * Barrier-first outcomes for intraday forecasts — PURE.
 *
 * WHY. The intraday forecaster asked "will the close be higher in N minutes?"
 * Four sessions proved that quantity untradeable: the realised 1-minute move
 * averages ~6 bps against a 20 bp round-trip cost, so a perfect direction
 * oracle loses money. The spec (§5, §6, §11) and the daily-horizon study in
 * this repo (`setupExpectancyStudy.ts`) both frame the question differently:
 *
 *     P( price reaches +TARGET before it reaches −STOP, within HORIZON )
 *
 * A fixed +0.5% / −0.3% bracket is ABOVE cost by construction (+50 bps target
 * vs ~20 bps cost), so a forecast of it is at least economically meaningful —
 * which is not yet a claim that it is skilful. This file provides the two
 * halves needed to find out:
 *
 *   1. `barrierProbabilities` — the model's ex-ante P(target first),
 *      P(stop first), P(neither) from its own drift and volatility, by seeded
 *      Monte Carlo. Recorded on the forecast at issue time.
 *   2. `evaluateBarrierPath` — what ACTUALLY happened along the realised
 *      1-minute bar path: which barrier hit first, when, the maximum
 *      favourable and adverse excursions, and the return at 5/10/15/30/60 min.
 *      Recorded at grading time. Same conservative rules as the daily study:
 *      a bar that opens through the stop fills at the open, and a bar whose
 *      range covers BOTH barriers is scored as the stop (we cannot know the
 *      intra-bar order, so we assume the worse one).
 *
 * Everything here is deterministic given its inputs. No clocks, no I/O.
 */

import { CompletedBar } from "./types";

/** The bracket, in percent of base price. Chosen from the spec's own example; recorded on every row. */
export const BARRIER_TARGET_PCT = 0.5;
export const BARRIER_STOP_PCT = 0.3;

/** Horizons at which the path return is recorded, when the path is long enough. */
export const RETURN_AT_MINUTES = [5, 10, 15, 30, 60] as const;

/** Monte Carlo paths for the ex-ante probability. 400 ⇒ SE ≈ 2.5 pp on a 50% probability. */
export const BARRIER_MC_PATHS = 400;
export const BARRIER_MC_SEED = 20260924;

export type FirstHit = "TARGET" | "STOP" | "NONE";

export interface BarrierProbabilities {
  targetPct: number;
  stopPct: number;
  /** For a DOWN call the bracket is mirrored; this records the direction it was framed for. */
  direction: "UP" | "DOWN";
  pTargetFirst: number;
  pStopFirst: number;
  pNeither: number;
  paths: number;
}

/** mulberry32 — small, fast, seeded. Good enough for a 400-path estimate; not for cryptography. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller standard normal from two uniforms. */
function gaussian(rand: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Ex-ante barrier probabilities from the forecast's own per-bar drift (%) and
 * volatility (%), over `horizonBars` one-minute steps.
 *
 * The bracket is framed in the call's direction: for UP, target is +TARGET
 * and stop is −STOP; for DOWN, mirrored. Log-price steps are Gaussian with the
 * given drift and vol — the same assumptions the direction model makes, so a
 * disagreement between this and reality is a disagreement with THAT model,
 * not with an extra layer of assumptions.
 */
export function barrierProbabilities(opts: {
  driftPerBarPct: number;
  barVolPct: number;
  horizonBars: number;
  direction: "UP" | "DOWN";
  targetPct?: number;
  stopPct?: number;
  paths?: number;
  seed?: number;
}): BarrierProbabilities {
  const targetPct = opts.targetPct ?? BARRIER_TARGET_PCT;
  const stopPct = opts.stopPct ?? BARRIER_STOP_PCT;
  const paths = opts.paths ?? BARRIER_MC_PATHS;
  const rand = mulberry32(opts.seed ?? BARRIER_MC_SEED);

  // Work in the call's frame: +up is favourable.
  const sign = opts.direction === "UP" ? 1 : -1;
  const mu = (opts.driftPerBarPct / 100) * sign;
  const sigma = opts.barVolPct / 100;
  const up = Math.log(1 + targetPct / 100);
  const down = -Math.log(1 - stopPct / 100); // positive magnitude

  let target = 0;
  let stop = 0;
  const steps = Math.max(1, Math.floor(opts.horizonBars));
  for (let p = 0; p < paths; p++) {
    let x = 0;
    let resolved = false;
    for (let s = 0; s < steps; s++) {
      x += mu + sigma * gaussian(rand);
      if (x <= -down) {
        stop++;
        resolved = true;
        break;
      }
      if (x >= up) {
        target++;
        resolved = true;
        break;
      }
    }
    void resolved;
  }
  return {
    targetPct,
    stopPct,
    direction: opts.direction,
    pTargetFirst: target / paths,
    pStopFirst: stop / paths,
    pNeither: (paths - target - stop) / paths,
    paths,
  };
}

export interface BarrierOutcome {
  targetPct: number;
  stopPct: number;
  direction: "UP" | "DOWN";
  firstHit: FirstHit;
  /** Bar start time of the hit, ms epoch. Null when NONE. */
  hitAt: number | null;
  /** Minutes from madeAt to the hitting bar's start. Null when NONE. */
  minutesToHit: number | null;
  /** Maximum favourable excursion, % of base, in the call's direction (≥ 0). */
  mfePct: number;
  /** Maximum adverse excursion, % of base, in the call's direction (≤ 0). */
  maePct: number;
  /** Close-to-base return at each listed horizon that the path covers, in %. */
  returnsAtPct: Partial<Record<(typeof RETURN_AT_MINUTES)[number], number>>;
  /** Close-to-base return at the last bar in the window, %. */
  finalReturnPct: number;
  barsSeen: number;
  /** False when the window had fewer bars than its horizon — the path was cut short. */
  complete: boolean;
}

/**
 * Score a forecast against the realised path.
 *
 * `bars` may contain bars from before `madeAt`. The path is the first
 * `horizonMin` completed bars that END after `madeAt`, in time order — the
 * bar forming when the call was issued is the first minute of the trade, and
 * minutes are counted by position in that path (1 = first bar after the call)
 * rather than by clock arithmetic, so the 15-second grading jitter in `madeAt`
 * cannot shift a minute boundary. Returns null when there is no bar in the
 * window at all — an absent path is not a NONE outcome, it is missing data,
 * and must not be scored as "no hit".
 *
 * Rules, matching the daily study so the two ledgers are comparable:
 *  - Frame everything in the call's direction: for a DOWN call, "target" is
 *    below base and "stop" above; excursions are sign-flipped so MFE ≥ 0 is
 *    always favourable.
 *  - Walk bars in order. If a bar's OPEN is already through the stop, the
 *    stop hit at the open (gap risk is real and counted against us). Then
 *    check the stop against the bar's adverse extreme, then the target
 *    against the favourable extreme. A bar spanning both counts as STOP.
 *  - MFE/MAE use highs and lows, not closes, because that is where a resting
 *    order would actually have filled.
 */
export function evaluateBarrierPath(opts: {
  bars: CompletedBar[];
  madeAt: number;
  basePrice: number;
  horizonMin: number;
  direction: "UP" | "DOWN";
  targetPct?: number;
  stopPct?: number;
}): BarrierOutcome | null {
  const targetPct = opts.targetPct ?? BARRIER_TARGET_PCT;
  const stopPct = opts.stopPct ?? BARRIER_STOP_PCT;
  const { madeAt, basePrice, horizonMin, direction } = opts;
  if (!(basePrice > 0) || !Number.isFinite(basePrice)) return null;

  const path = opts.bars
    .filter((b) => b.endAt > madeAt)
    .sort((a, b) => a.startAt - b.startAt)
    .slice(0, Math.max(1, Math.floor(horizonMin)));
  if (path.length === 0) return null;

  const sign = direction === "UP" ? 1 : -1;
  // Barrier prices in the call's frame.
  const targetPrice = basePrice * (1 + (sign * targetPct) / 100);
  const stopPrice = basePrice * (1 - (sign * stopPct) / 100);

  const pctOf = (price: number) => (sign * (price - basePrice) / basePrice) * 100;
  const favourable = (b: CompletedBar) => (sign > 0 ? b.high : b.low);
  const adverse = (b: CompletedBar) => (sign > 0 ? b.low : b.high);
  const throughStop = (price: number) => (sign > 0 ? price <= stopPrice : price >= stopPrice);
  const throughTarget = (price: number) => (sign > 0 ? price >= targetPrice : price <= targetPrice);

  let firstHit: FirstHit = "NONE";
  let hitAt: number | null = null;
  let minutesToHit: number | null = null;
  let mfe = 0;
  let mae = 0;
  const returnsAtPct: BarrierOutcome["returnsAtPct"] = {};
  const wanted = new Set<number>(RETURN_AT_MINUTES.filter((m) => m <= horizonMin));

  for (let i = 0; i < path.length; i++) {
    const b = path[i];
    const minutesIn = i + 1; // position in the path: the k-th bar after the call closes minute k
    if (wanted.has(minutesIn)) returnsAtPct[minutesIn as (typeof RETURN_AT_MINUTES)[number]] = pctOf(b.close);

    if (firstHit === "NONE") {
      // Excursions accumulate only until resolution — after a fill, the path no longer matters to the position.
      mfe = Math.max(mfe, pctOf(favourable(b)));
      mae = Math.min(mae, pctOf(adverse(b)));

      if (throughStop(b.open) || throughStop(adverse(b))) {
        firstHit = "STOP";
        hitAt = b.startAt;
        minutesToHit = minutesIn;
      } else if (throughTarget(favourable(b))) {
        firstHit = "TARGET";
        hitAt = b.startAt;
        minutesToHit = minutesIn;
      }
    }
  }

  const last = path[path.length - 1];
  const expectedBars = horizonMin; // one bar per minute
  return {
    targetPct,
    stopPct,
    direction,
    firstHit,
    hitAt,
    minutesToHit,
    mfePct: mfe,
    maePct: mae,
    returnsAtPct,
    finalReturnPct: pctOf(last.close),
    barsSeen: path.length,
    complete: path.length >= expectedBars,
  };
}

export interface BarrierScore {
  n: number;
  /** Among resolved (TARGET or STOP) forecasts, share that hit TARGET first. */
  targetFirstRatePct: number | null;
  stopFirstRatePct: number | null;
  neitherRatePct: number | null;
  /** Brier of the model's ex-ante pTargetFirst against the realised TARGET-first indicator. */
  brierTarget: number | null;
  meanMfePct: number | null;
  meanMaePct: number | null;
  /** Mean minutes to resolution among resolved paths. */
  meanMinutesToHit: number | null;
}

/**
 * Aggregate barrier outcomes with their ex-ante probabilities. PURE.
 * `pairs` are (outcome, exAnte) for graded forecasts whose path was complete.
 */
export function scoreBarriers(pairs: Array<{ outcome: BarrierOutcome; exAnte: BarrierProbabilities | null }>): BarrierScore {
  const n = pairs.length;
  if (n === 0) {
    return { n: 0, targetFirstRatePct: null, stopFirstRatePct: null, neitherRatePct: null, brierTarget: null, meanMfePct: null, meanMaePct: null, meanMinutesToHit: null };
  }
  let target = 0;
  let stop = 0;
  let neither = 0;
  let brierSum = 0;
  let brierN = 0;
  let mfe = 0;
  let mae = 0;
  let minutes = 0;
  let resolved = 0;
  for (const { outcome, exAnte } of pairs) {
    if (outcome.firstHit === "TARGET") target++;
    else if (outcome.firstHit === "STOP") stop++;
    else neither++;
    mfe += outcome.mfePct;
    mae += outcome.maePct;
    if (outcome.minutesToHit != null) {
      minutes += outcome.minutesToHit;
      resolved++;
    }
    if (exAnte) {
      brierSum += (exAnte.pTargetFirst - (outcome.firstHit === "TARGET" ? 1 : 0)) ** 2;
      brierN++;
    }
  }
  return {
    n,
    targetFirstRatePct: (target / n) * 100,
    stopFirstRatePct: (stop / n) * 100,
    neitherRatePct: (neither / n) * 100,
    brierTarget: brierN ? brierSum / brierN : null,
    meanMfePct: mfe / n,
    meanMaePct: mae / n,
    meanMinutesToHit: resolved ? minutes / resolved : null,
  };
}
