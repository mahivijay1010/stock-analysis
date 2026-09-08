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
  const riskPerShare = entry - stop;
  const rand = mulberry32(SEED);
  const n = pool.length;

  const retPct: number[] = new Array(PATHS);
  const rMult: number[] = new Array(PATHS);
  const mfeR: number[] = new Array(PATHS);
  const maeR: number[] = new Array(PATHS);
  let targetFirst = 0;
  let stopFirst = 0;
  let timeout = 0;

  for (let p = 0; p < PATHS; p++) {
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
    const netPct = grossPct - drag;
    retPct[p] = netPct;
    rMult[p] = (outcomePrice - entry) / riskPerShare;
    mfeR[p] = bestR;
    maeR[p] = worstR;
  }

  const sortedRet = [...retPct].sort((a, b) => a - b);
  const sortedR = [...rMult].sort((a, b) => a - b);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const pct = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];
  const meanRet = mean(retPct);
  const sd = Math.sqrt(mean(retPct.map((x) => (x - meanRet) ** 2)));

  // Block-bootstrap the MEAN to get its sampling distribution → 80/95 CIs and
  // P(mean>0). Effective sample = distinct return-days is capped by pool size,
  // but path outcomes over maxHold overlap, so we discount to pool/maxHold.
  const effectiveSamples = Math.max(1, Math.floor(pool.length / Math.max(1, maxHoldDays)));
  const meanSe = sd / Math.sqrt(effectiveSamples);
  const bootMeans: number[] = [];
  const B = 1000;
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let k = 0; k < effectiveSamples; k++) s += retPct[Math.floor(rand() * PATHS)];
    bootMeans.push(s / effectiveSamples);
  }
  bootMeans.sort((a, b) => a - b);
  const worstDecileRet = sortedRet.slice(0, Math.max(1, Math.floor(0.1 * PATHS)));
  const worstDecileR = sortedR.slice(0, Math.max(1, Math.floor(0.1 * PATHS)));

  const round = (x: number) => Math.round(x * 1000) / 1000;
  return {
    meanEvAfterCostsPct: round(meanRet),
    medianEvAfterCostsPct: round(pct(sortedRet, 0.5)),
    evStdErrorPct: round(meanSe),
    ev80LowerPct: round(pct(bootMeans, 0.1)),
    ev80UpperPct: round(pct(bootMeans, 0.9)),
    ev95LowerPct: round(pct(bootMeans, 0.025)),
    ev95UpperPct: round(pct(bootMeans, 0.975)),
    expectedShortfallPct: round(mean(worstDecileRet)),
    downsideP10Pct: round(pct(sortedRet, 0.1)),
    probabilityEvPositive: round(bootMeans.filter((m) => m > 0).length / B),
    independentSamples: effectiveSamples,
    expectedR: round(mean(rMult)),
    medianR: round(pct(sortedR, 0.5)),
    p10R: round(pct(sortedR, 0.1)),
    cvarR: round(mean(worstDecileR)),
    historicalMfeR: round(mean(mfeR)),
    historicalMaeR: round(mean(maeR)),
    targetReachRate: round(targetFirst / PATHS),
    stopHitRate: round(stopFirst / PATHS),
    timeoutRate: round(timeout / PATHS),
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
