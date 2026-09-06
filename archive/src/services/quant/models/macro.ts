/**
 * Model: macro — market-regime score (0..100, null → neutral 50) plus the
 * stock's beta-scaled NIFTY 20-day move. When ALL context is null the model
 * is exactly neutral (0.5 at every horizon) — an honest "no macro signal",
 * never a fabricated lean.
 */

import { Bar, Horizon } from "../types";
import { DirectionModel, ModelInput } from "./types";
import { clamp, closesOf, logistic, perHorizon, trailingDailyVol, trailingReturn } from "./shared";

/** Fixed per-horizon logistic slopes — macro tides act over weeks. */
const COEF: Record<Horizon, number> = { 1: 0.4, 3: 0.5, 7: 0.6, 15: 0.65, 30: 0.7 };

const W_REGIME = 0.9;
const W_INDEX = 0.5;
const Z_CAP = 4;
const MIN_BETA_OVERLAP = 40; // fewer overlapping return days → default beta 1
const BETA_WINDOW = 260;

/** Beta vs the index over overlapping daily returns; 1 when unmeasurable. */
function betaVsIndex(bars: Bar[], indexBars: Bar[]): number {
  const idxByDate = new Map(indexBars.map((b) => [b.date, b.close]));
  const window = bars.slice(-BETA_WINDOW);
  const paired: Array<{ s: number; n: number }> = [];
  for (const b of window) {
    const n = idxByDate.get(b.date);
    if (n !== undefined && b.close > 0 && n > 0) paired.push({ s: b.close, n });
  }
  const sRet: number[] = [];
  const nRet: number[] = [];
  for (let i = 1; i < paired.length; i++) {
    sRet.push(paired[i].s / paired[i - 1].s - 1);
    nRet.push(paired[i].n / paired[i - 1].n - 1);
  }
  if (sRet.length < MIN_BETA_OVERLAP) return 1;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const mS = mean(sRet);
  const mN = mean(nRet);
  let cov = 0;
  let varN = 0;
  for (let i = 0; i < sRet.length; i++) {
    cov += (sRet[i] - mS) * (nRet[i] - mN);
    varN += (nRet[i] - mN) ** 2;
  }
  if (varN === 0) return 1;
  const beta = cov / varN;
  return Number.isFinite(beta) ? clamp(beta, -3, 3) : 1;
}

export const macroModel: DirectionModel = {
  name: "macro",
  predict(input: ModelInput): Record<Horizon, number> {
    const regime =
      input.regimeScore !== null &&
      input.regimeScore !== undefined &&
      Number.isFinite(input.regimeScore)
        ? (clamp(input.regimeScore, 0, 100) - 50) / 50
        : 0; // null → neutral

    let indexTerm = 0;
    const nifty = input.niftyBars ?? null;
    if (nifty && nifty.length >= 21) {
      const nCloses = closesOf(nifty);
      const nR20 = trailingReturn(nCloses, 20);
      const nSigma = trailingDailyVol(nCloses, 60);
      if (nR20 !== null && nSigma !== null) {
        const zN = clamp(nR20 / (nSigma * Math.sqrt(20)), -Z_CAP, Z_CAP);
        const beta = betaVsIndex(input.bars, nifty);
        indexTerm = Math.tanh(beta * zN);
      }
    }

    const raw = W_REGIME * regime + W_INDEX * indexTerm;
    return perHorizon((h) => logistic(COEF[h] * raw));
  },
};

export default macroModel;
