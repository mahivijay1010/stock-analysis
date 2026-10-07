/**
 * Calibration curve (calibration-curve-v1) — PURE.
 *
 * The reliability diagram: of all the times the model said "60% chance of a
 * win", did ~60% actually win? A model can have a decent hit rate and still be
 * badly calibrated (confidently wrong), and calibration is what EV and Kelly
 * sizing depend on. This bins predictions by their stated probability and, per
 * bin, measures the ACTUAL win rate with a Wilson interval — withheld below a
 * minimum count, like every other rate in this system. It also returns the
 * Brier score and Expected Calibration Error (ECE), and names the failure mode
 * (OVERCONFIDENT / UNDERCONFIDENT) in plain words.
 */

import { wilsonLb95 } from "./selectivity";

export const CALIBRATION_CURVE_VERSION = "calibration-curve-v1";

export interface CalibrationPoint {
  predictedProb: number; // 0..1
  won: boolean; // did the predicted outcome happen
}

export interface CalibrationBin {
  lo: number;
  hi: number;
  count: number;
  predictedMean: number | null; // mean stated probability in the bin
  actualRate: number | null; // observed win rate — null when count < min
  wilsonLo: number | null;
  wilsonHi: number | null;
  withheld: boolean;
}

export type Reliability = "WELL_CALIBRATED" | "OVERCONFIDENT" | "UNDERCONFIDENT" | "INSUFFICIENT";

export interface CalibrationReport {
  version: string;
  n: number;
  bins: CalibrationBin[];
  brier: number | null;
  /** Expected Calibration Error — mean |predicted − actual| weighted by bin count. */
  ece: number | null;
  overallPredictedMean: number | null;
  overallActualRate: number | null;
  reliability: Reliability;
  headline: string;
}

/** Wilson score interval (both bounds) at 95%. */
function wilson(successes: number, n: number): { lo: number; hi: number } | null {
  if (n <= 0) return null;
  const z = 1.96;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: Math.max(0, (centre - margin) / denom), hi: Math.min(1, (centre + margin) / denom) };
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000;

export function buildCalibration(points: CalibrationPoint[], opts: { nBins?: number; minPerBin?: number } = {}): CalibrationReport {
  const nBins = opts.nBins ?? 10;
  const minPerBin = opts.minPerBin ?? 10;
  const valid = points.filter((p) => Number.isFinite(p.predictedProb) && p.predictedProb >= 0 && p.predictedProb <= 1);
  const n = valid.length;

  const bins: CalibrationBin[] = [];
  for (let b = 0; b < nBins; b++) {
    const lo = b / nBins;
    const hi = (b + 1) / nBins;
    // Last bin is inclusive of 1.0.
    const inBin = valid.filter((p) => (b === nBins - 1 ? p.predictedProb >= lo && p.predictedProb <= hi : p.predictedProb >= lo && p.predictedProb < hi));
    const count = inBin.length;
    const wins = inBin.filter((p) => p.won).length;
    const enough = count >= minPerBin;
    const w = enough ? wilson(wins, count) : null;
    bins.push({
      lo: r3(lo),
      hi: r3(hi),
      count,
      predictedMean: count ? r3(inBin.reduce((a, p) => a + p.predictedProb, 0) / count) : null,
      actualRate: enough ? r3(wins / count) : null,
      wilsonLo: w ? r3(w.lo) : null,
      wilsonHi: w ? r3(w.hi) : null,
      withheld: !enough && count > 0,
    });
  }

  if (n < minPerBin) {
    return {
      version: CALIBRATION_CURVE_VERSION,
      n,
      bins,
      brier: null,
      ece: null,
      overallPredictedMean: null,
      overallActualRate: null,
      reliability: "INSUFFICIENT",
      headline: `Only ${n} graded predictions — too few to assess calibration.`,
    };
  }

  const brier = r3(valid.reduce((a, p) => a + (p.predictedProb - (p.won ? 1 : 0)) ** 2, 0) / n);
  const overallPredicted = r3(valid.reduce((a, p) => a + p.predictedProb, 0) / n);
  const overallActual = r3(valid.filter((p) => p.won).length / n);
  // ECE over bins with enough data.
  let eceNum = 0;
  let eceDen = 0;
  for (const bin of bins) {
    if (bin.actualRate != null && bin.predictedMean != null) {
      eceNum += bin.count * Math.abs(bin.actualRate - bin.predictedMean);
      eceDen += bin.count;
    }
  }
  const ece = eceDen > 0 ? r3(eceNum / eceDen) : null;

  // Reliability verdict: is the model systematically over/under-confident?
  const gap = overallPredicted - overallActual; // >0 ⇒ predicts more wins than happen
  let reliability: Reliability;
  if (ece != null && ece <= 0.05) reliability = "WELL_CALIBRATED";
  else if (gap > 0.03) reliability = "OVERCONFIDENT";
  else if (gap < -0.03) reliability = "UNDERCONFIDENT";
  else reliability = "WELL_CALIBRATED";

  const wLb = wilsonLb95(valid.filter((p) => p.won).length, n);
  const headline =
    reliability === "OVERCONFIDENT"
      ? `Overconfident: the model's probabilities average ${(overallPredicted * 100).toFixed(0)}% but only ${(overallActual * 100).toFixed(0)}% actually won (ECE ${ece}). Treat its probabilities as inflated.`
      : reliability === "UNDERCONFIDENT"
        ? `Underconfident: stated ${(overallPredicted * 100).toFixed(0)}% vs ${(overallActual * 100).toFixed(0)}% actual (ECE ${ece}).`
        : `Reasonably calibrated over ${n} predictions (ECE ${ece}, Brier ${brier}); overall win rate ${(overallActual * 100).toFixed(0)}% (Wilson LB ${wLb != null ? (wLb * 100).toFixed(0) : "n/a"}%).`;

  return {
    version: CALIBRATION_CURVE_VERSION,
    n,
    bins,
    brier,
    ece,
    overallPredictedMean: overallPredicted,
    overallActualRate: overallActual,
    reliability,
    headline,
  };
}
