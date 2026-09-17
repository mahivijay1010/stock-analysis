/**
 * EV uncertainty + R-multiple engine (Parts 5/16/17/18).
 *
 * A raw mean EV of +0.5% is meaningless if its uncertainty is ±3%. This
 * module runs the trade's OWN bracket (entry / stop / target1 / max-hold)
 * across seeded bootstrap return paths, records the realized R-multiple of
 * each path (first-touch on the daily path; terminal-R at the time stop), and
 * returns the FULL distribution with a lower confidence bound.
 *
 * A trade may only be ENTRY-eligible when the EV-after-costs 80% LOWER bound
 * is > 0 — i.e. the edge survives its own statistical uncertainty, not just
 * its point estimate. All PURE and deterministic (seeded).
 */

import { mulberry32 } from "../quant/montecarlo";

export interface EvEvidence {
  meanEvAfterCostsPct: number;
  medianEvAfterCostsPct: number;
  evStdErrorPct: number;
  ev80LowerPct: number;
  ev80UpperPct: number;
  ev95LowerPct: number;
  ev95UpperPct: number;
  expectedShortfallPct: number; // mean of worst-decile % outcomes (after costs)
  downsideP10Pct: number;
  probabilityEvPositive: number; // fraction of bootstrap-mean resamples > 0
  independentSamples: number;
  // R-multiple view (Part 18)
  expectedR: number;
  medianR: number;
  p10R: number;
  cvarR: number; // mean of worst-decile R
  historicalMfeR: number; // mean best-excursion R across paths
  historicalMaeR: number; // mean worst-excursion R across paths
  targetReachRate: number; // fraction of paths that touched target1 first
  stopHitRate: number;
  timeoutRate: number;
}

const PATHS = 3000;
const SEED = 20260908;

/**
 * Outer block-bootstrap: resamples of the daily-return pool re-run through
 * the same inner Monte Carlo, to measure genuine sampling uncertainty from
 * limited history (see BLOCK_BOOTSTRAP_B/BLOCK_BOOTSTRAP_PATHS/MEAN_BLOCK_LEN
 * below for the accuracy/cost tradeoff this makes).
 */
const BLOCK_BOOTSTRAP_B = 120; // outer resamples of history — enough for stable 10th/90th percentiles
const BLOCK_BOOTSTRAP_PATHS = 250; // inner MC paths PER outer resample — kept high enough that MC noise on each draw's mean stays small relative to genuine across-block variance (reducing this further adds pure simulator noise on top of the resampling uncertainty we're trying to measure, the opposite direction from the bug this replaces)
const MEAN_BLOCK_LEN = 10; // stationary-bootstrap mean block length (days) — same convention as quant/montecarlo.ts's simulateDailyQuantilesBlock

interface BracketWalkResult {
  retPct: Float64Array;
  rMult: Float64Array;
  mfeR: Float64Array;
  maeR: Float64Array;
  targetFirst: number;
  stopFirst: number;
  timeout: number;
}

/**
 * Runs `paths` bracket-walk simulations against a fixed return pool (sampled
 * i.i.d. from that pool — the pool itself carries the autocorrelation
 * structure when it was produced by a block bootstrap upstream). Pure,
 * deterministic given `rand`.
 */
function simulateBracketWalk(
  pool: number[],
  paths: number,
  entry: number,
  stop: number,
  target1: number,
  maxHoldDays: number,
  drag: number,
  rand: () => number
): BracketWalkResult {
  const riskPerShare = entry - stop;
  const n = pool.length;
  const retPct = new Float64Array(paths);
  const rMult = new Float64Array(paths);
  const mfeR = new Float64Array(paths);
  const maeR = new Float64Array(paths);
  let targetFirst = 0;
  let stopFirst = 0;
  let timeout = 0;

  for (let p = 0; p < paths; p++) {
    let price = entry;
    let bestR = 0;
    let worstR = 0;
    let outcomePrice = entry;
    let resolved = false;
    for (let d = 0; d < maxHoldDays; d++) {
      price *= 1 + pool[Math.floor(rand() * n)];
      const r = (price - entry) / riskPerShare;
      if (r > bestR) bestR = r;
      if (r < worstR) worstR = r;
      if (price <= stop) {
        outcomePrice = stop;
        stopFirst++;
        resolved = true;
        break;
      }
      if (price >= target1) {
        outcomePrice = target1;
        targetFirst++;
        resolved = true;
        break;
      }
    }
    if (!resolved) {
      outcomePrice = price;
      timeout++;
    }
    const grossPct = ((outcomePrice - entry) / entry) * 100;
    retPct[p] = grossPct - drag;
    rMult[p] = (outcomePrice - entry) / riskPerShare;
    mfeR[p] = bestR;
    maeR[p] = worstR;
  }

  return { retPct, rMult, mfeR, maeR, targetFirst, stopFirst, timeout };
}

/**
 * Stationary block bootstrap of a return pool (same technique as
 * quant/montecarlo.ts's simulateDailyQuantilesBlock, applied to the SOURCE
 * pool rather than to simulated terminal outcomes): walks the pool with
 * geometric block lengths (mean `meanBlockLen`, wrapping), producing a
 * resampled pool of the same size that partially preserves autocorrelation
 * and vol clustering that i.i.d. resampling would destroy.
 */
function stationaryBlockResample(pool: number[], meanBlockLen: number, rand: () => number): number[] {
  const n = pool.length;
  const pNew = 1 / Math.max(1, meanBlockLen);
  const out: number[] = new Array(n);
  let idx = Math.floor(rand() * n);
  for (let i = 0; i < n; i++) {
    out[i] = pool[idx];
    idx = rand() < pNew ? Math.floor(rand() * n) : (idx + 1) % n;
  }
  return out;
}

/**
 * @param dailyReturns  the stock's own recent daily returns (fractions)
 * @param entry/stop/target1  price levels
 * @param maxHoldDays  time stop in trading days
 * @param costPct + slippagePct  round-trip drag applied to every path
 */
export function computeEvEvidence(opts: {
  dailyReturns: number[];
  entry: number;
  stop: number;
  target1: number;
  maxHoldDays: number;
  costPct: number;
  slippagePct: number;
}): EvEvidence | null {
  const { entry, stop, target1, maxHoldDays } = opts;
  const pool = opts.dailyReturns.filter((r) => Number.isFinite(r) && r > -1).slice(-260);
  if (pool.length < 60 || !(entry > 0) || !(stop > 0) || !(target1 > entry) || !(stop < entry)) return null;

  const drag = opts.costPct + opts.slippagePct; // % subtracted from every realized outcome
  const rand = mulberry32(SEED);

  // ── Point estimate: PATHS=3000 i.i.d. draws from the ACTUAL history. This
  //    is unchanged from before — it is the trade's own expected outcome, not
  //    the uncertainty about it. ──────────────────────────────────────────
  const point = simulateBracketWalk(pool, PATHS, entry, stop, target1, maxHoldDays, drag, rand);
  const retPct = Array.from(point.retPct);
  const rMult = Array.from(point.rMult);

  const sortedRet = [...retPct].sort((a, b) => a - b);
  const sortedR = [...rMult].sort((a, b) => a - b);
  const mean = (xs: number[] | Float64Array) => {
    let s = 0;
    for (let i = 0; i < xs.length; i++) s += xs[i];
    return s / xs.length;
  };
  const pct = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];
  const meanRet = mean(retPct);

  // ── Uncertainty: a REAL block bootstrap. §4.1 of the trust review: the old
  //    code resampled the 3000 already-simulated PATH OUTCOMES (i.i.d. by
  //    construction, since they came from i.i.d. draws off the same fixed
  //    pool) — that measured Monte-Carlo dispersion of the simulator, not
  //    sampling uncertainty of the 260-day HISTORY, and its width was an
  //    artifact of pool.length/maxHoldDays rather than anything about the
  //    market. The correct construction resamples the underlying daily-return
  //    HISTORY in contiguous (stationary) blocks — preserving autocorrelation
  //    the way i.i.d. resampling would destroy — and RE-RUNS the full
  //    bracket-walk simulation on each resampled history, so each bootstrap
  //    draw is a genuine "what if we'd only ever seen this alternate slice of
  //    market history" estimate of the trade's mean EV. ─────────────────────
  const bootMeans: number[] = new Array(BLOCK_BOOTSTRAP_B);
  for (let b = 0; b < BLOCK_BOOTSTRAP_B; b++) {
    const resampledPool = stationaryBlockResample(pool, MEAN_BLOCK_LEN, rand);
    const boot = simulateBracketWalk(resampledPool, BLOCK_BOOTSTRAP_PATHS, entry, stop, target1, maxHoldDays, drag, rand);
    bootMeans[b] = mean(boot.retPct);
  }
  bootMeans.sort((a, b) => a - b);

  // independentSamples is now an honest description of what the block
  // bootstrap actually resamples (distinct history blocks), not a divisor
  // baked into the CI's width — the CI's width instead falls naturally out
  // of how much the resampled histories actually disagree with each other.
  const independentSamples = Math.max(1, Math.floor(pool.length / MEAN_BLOCK_LEN));
  const bootSd = Math.sqrt(mean(bootMeans.map((x) => (x - mean(bootMeans)) ** 2)));

  const worstDecileRet = sortedRet.slice(0, Math.max(1, Math.floor(0.1 * PATHS)));
  const worstDecileR = sortedR.slice(0, Math.max(1, Math.floor(0.1 * PATHS)));

  const round = (x: number) => Math.round(x * 1000) / 1000;
  return {
    meanEvAfterCostsPct: round(meanRet),
    medianEvAfterCostsPct: round(pct(sortedRet, 0.5)),
    evStdErrorPct: round(bootSd),
    ev80LowerPct: round(pct(bootMeans, 0.1)),
    ev80UpperPct: round(pct(bootMeans, 0.9)),
    ev95LowerPct: round(pct(bootMeans, 0.025)),
    ev95UpperPct: round(pct(bootMeans, 0.975)),
    expectedShortfallPct: round(mean(worstDecileRet)),
    downsideP10Pct: round(pct(sortedRet, 0.1)),
    probabilityEvPositive: round(bootMeans.filter((m) => m > 0).length / BLOCK_BOOTSTRAP_B),
    independentSamples,
    expectedR: round(mean(rMult)),
    medianR: round(pct(sortedR, 0.5)),
    p10R: round(pct(sortedR, 0.1)),
    cvarR: round(mean(worstDecileR)),
    historicalMfeR: round(mean(point.mfeR)),
    historicalMaeR: round(mean(point.maeR)),
    targetReachRate: round(point.targetFirst / PATHS),
    stopHitRate: round(point.stopFirst / PATHS),
    timeoutRate: round(point.timeout / PATHS),
  };
}

/** Pre-registered EV gate (Part 5/25): the edge must survive its uncertainty. */
export const EV_GATE = {
  minEv80LowerPct: 0, // 80% lower bound strictly positive
  minExpectedR: 0.1, // at least +0.1R expected after costs
  maxCvarR: -2.0, // reject if worst-decile R worse than −2R (tail too fat vs a 1R stop)
} as const;

export function evGatePasses(e: EvEvidence | null): { ok: boolean; reasons: string[] } {
  if (!e) return { ok: false, reasons: ["EV evidence unavailable (insufficient return history)"] };
  const reasons: string[] = [];
  if (e.ev80LowerPct <= EV_GATE.minEv80LowerPct) reasons.push(`EV 80% lower bound ${e.ev80LowerPct}% ≤ 0 — edge not distinguishable from zero`);
  if (e.expectedR < EV_GATE.minExpectedR) reasons.push(`expected ${e.expectedR}R < ${EV_GATE.minExpectedR}R after costs`);
  if (e.cvarR < EV_GATE.maxCvarR) reasons.push(`tail risk CVaR ${e.cvarR}R worse than ${EV_GATE.maxCvarR}R`);
  return { ok: reasons.length === 0, reasons };
}
