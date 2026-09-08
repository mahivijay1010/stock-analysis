/**
 * Probability calibration (completion directive, Phase 7) — PURE.
 *
 * Three calibrator families fitted ONLY on validation-segment predictions and
 * selected on a chronologically LATER held-out slice — never on the test
 * period they will be evaluated against:
 *
 *  - Platt scaling: sigmoid(A·logit(p) + B), gradient descent
 *  - Isotonic regression: pool-adjacent-violators step function
 *  - Beta calibration: sigmoid(a·ln p − b·ln(1−p) + c)
 *
 * Promotion requires held-out Brier AND ECE improvement over the raw
 * probabilities with a minimum effective sample count. When nothing is
 * credible, the product's answer stays "Directional probability unavailable —
 * insufficient calibrated evidence" (never a resurrected heuristic).
 */

import { expectedCalibrationError, round4 } from "./metrics";

export type CalibratorType = "platt" | "isotonic" | "beta";

export interface Calibrator {
  type: CalibratorType;
  version: string;
  /** platt: {a,b} · beta: {a,b,c} · isotonic: step function */
  params: Record<string, number> | { thresholds: number[]; values: number[] };
  trainingStart: string;
  trainingEnd: string;
  trainedOn: number;
}

const clampP = (p: number): number => Math.min(1 - 1e-6, Math.max(1e-6, p));
const logit = (p: number): number => Math.log(clampP(p) / (1 - clampP(p)));
const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

export interface CalPoint {
  prob: number;
  outcome: 0 | 1;
  date: string;
}

// ── fitting ──────────────────────────────────────────────────────────────────

function fitLogistic1D(xs: number[][], ys: number[], iters = 500, lr = 0.5): number[] {
  // Generic small logistic regression (with intercept as last weight).
  const d = xs[0].length;
  const w = Array(d + 1).fill(0);
  const n = xs.length;
  for (let it = 0; it < iters; it++) {
    const g = Array(d + 1).fill(0);
    for (let i = 0; i < n; i++) {
      let z = w[d];
      for (let j = 0; j < d; j++) z += w[j] * xs[i][j];
      const err = sigmoid(z) - ys[i];
      for (let j = 0; j < d; j++) g[j] += err * xs[i][j];
      g[d] += err;
    }
    for (let j = 0; j <= d; j++) w[j] -= (lr * g[j]) / n;
  }
  return w;
}

export function fitPlatt(points: CalPoint[]): Calibrator {
  const xs = points.map((p) => [logit(p.prob)]);
  const ys = points.map((p) => p.outcome as number);
  const w = fitLogistic1D(xs, ys);
  const dates = points.map((p) => p.date).sort();
  return {
    type: "platt",
    version: "platt-v1",
    params: { a: round4(w[0]), b: round4(w[1]) },
    trainingStart: dates[0] ?? "",
    trainingEnd: dates[dates.length - 1] ?? "",
    trainedOn: points.length,
  };
}

export function fitBeta(points: CalPoint[]): Calibrator {
  // Beta calibration (Kull et al.): features [ln p, −ln(1−p)].
  const xs = points.map((p) => [Math.log(clampP(p.prob)), -Math.log(1 - clampP(p.prob))]);
  const ys = points.map((p) => p.outcome as number);
  const w = fitLogistic1D(xs, ys);
  const dates = points.map((p) => p.date).sort();
  return {
    type: "beta",
    version: "beta-v1",
    params: { a: round4(w[0]), b: round4(w[1]), c: round4(w[2]) },
    trainingStart: dates[0] ?? "",
    trainingEnd: dates[dates.length - 1] ?? "",
    trainedOn: points.length,
  };
}

export function fitIsotonic(points: CalPoint[]): Calibrator {
  // Pool Adjacent Violators over probability-sorted outcomes.
  const sorted = [...points].sort((a, b) => a.prob - b.prob);
  const blocks: Array<{ sum: number; n: number; minProb: number }> = [];
  for (const p of sorted) {
    blocks.push({ sum: p.outcome, n: 1, minProb: p.prob });
    while (blocks.length >= 2) {
      const last = blocks[blocks.length - 1];
      const prev = blocks[blocks.length - 2];
      if (prev.sum / prev.n <= last.sum / last.n) break;
      prev.sum += last.sum;
      prev.n += last.n;
      blocks.pop();
    }
  }
  const dates = points.map((p) => p.date).sort();
  return {
    type: "isotonic",
    version: "isotonic-v1",
    params: {
      thresholds: blocks.map((b) => round4(b.minProb)),
      values: blocks.map((b) => round4(b.sum / b.n)),
    },
    trainingStart: dates[0] ?? "",
    trainingEnd: dates[dates.length - 1] ?? "",
    trainedOn: points.length,
  };
}

export function applyCalibrator(cal: Calibrator, p: number): number {
  if (cal.type === "platt") {
    const { a, b } = cal.params as { a: number; b: number };
    return clampP(sigmoid(a * logit(p) + b));
  }
  if (cal.type === "beta") {
    const { a, b, c } = cal.params as { a: number; b: number; c: number };
    return clampP(sigmoid(a * Math.log(clampP(p)) - b * Math.log(1 - clampP(p)) + c));
  }
  const { thresholds, values } = cal.params as { thresholds: number[]; values: number[] };
  if (thresholds.length === 0) return 0.5;
  let idx = 0;
  for (let i = 0; i < thresholds.length; i++) if (p >= thresholds[i]) idx = i;
  return clampP(values[idx]);
}

// ── selection with held-out discipline ───────────────────────────────────────

export interface CalibrationReport {
  calibratorType: CalibratorType | null; // null = nothing credible
  calibrator: Calibrator | null;
  trainingStart: string;
  trainingEnd: string;
  effectiveSamples: number;
  brierBefore: number;
  brierAfter: number | null;
  eceBefore: number;
  eceAfter: number | null;
  verdict: string;
}

/**
 * Fit all three calibrators on the chronologically EARLIER part of the
 * validation predictions and select on the LATER held-out slice; promotion
 * requires held-out Brier improvement AND no ECE degradation AND at least
 * minEffective overlap-adjusted samples.
 */
export function selectCalibrator(
  valPoints: CalPoint[],
  overlapDays: number,
  minEffective = 10
): CalibrationReport {
  const sorted = [...valPoints].sort((a, b) => (a.date < b.date ? -1 : 1));
  const dates = [...new Set(sorted.map((p) => p.date))].sort();
  const cutIdx = Math.floor(dates.length * 0.6);
  const cut = dates[Math.max(0, cutIdx - 1)] ?? "";
  const fitSet = sorted.filter((p) => p.date <= cut);
  const holdSet = sorted.filter((p) => p.date > cut);
  const holdDates = new Set(holdSet.map((p) => p.date)).size;
  const effHold = Math.max(1, Math.floor(holdDates / Math.max(1, overlapDays)));

  const brier = (pts: Array<{ p: number; y: 0 | 1 }>): number =>
    round4(pts.reduce((a, x) => a + (x.p - x.y) ** 2, 0) / Math.max(1, pts.length));

  const rawHold = holdSet.map((p) => ({ p: p.prob, y: p.outcome }));
  const brierBefore = brier(rawHold);
  const eceBefore =
    expectedCalibrationError(holdSet.map((p) => p.prob), holdSet.map((p) => p.outcome)) ?? 1;

  const empty: CalibrationReport = {
    calibratorType: null,
    calibrator: null,
    trainingStart: fitSet[0]?.date ?? "",
    trainingEnd: fitSet[fitSet.length - 1]?.date ?? "",
    effectiveSamples: effHold,
    brierBefore,
    brierAfter: null,
    eceBefore: round4(eceBefore),
    eceAfter: null,
    verdict: "",
  };

  if (fitSet.length < 100 || holdSet.length < 50 || effHold < minEffective) {
    return {
      ...empty,
      verdict: `insufficient calibration evidence (fit ${fitSet.length}, hold ${holdSet.length}, ~${effHold} independent hold-out obs < ${minEffective}) — directional probability stays unavailable`,
    };
  }

  const candidates: Array<{ cal: Calibrator; brierAfter: number; eceAfter: number }> = [];
  for (const fit of [fitPlatt, fitIsotonic, fitBeta]) {
    try {
      const cal = fit(fitSet);
      const calibrated = holdSet.map((p) => ({ p: applyCalibrator(cal, p.prob), y: p.outcome }));
      const b = brier(calibrated);
      const e =
        expectedCalibrationError(
          calibrated.map((x) => x.p),
          calibrated.map((x) => x.y)
        ) ?? 1;
      candidates.push({ cal, brierAfter: b, eceAfter: round4(e) });
    } catch {
      /* a calibrator that fails to fit is simply not a candidate */
    }
  }

  const improving = candidates
    .filter((c) => c.brierAfter < brierBefore && c.eceAfter <= eceBefore + 1e-6)
    .sort((a, b) => a.brierAfter - b.brierAfter);

  if (improving.length === 0) {
    return {
      ...empty,
      verdict: "no calibrator improved held-out Brier without degrading ECE — directional probability stays unavailable",
    };
  }
  const best = improving[0];
  return {
    calibratorType: best.cal.type,
    calibrator: best.cal,
    trainingStart: best.cal.trainingStart,
    trainingEnd: best.cal.trainingEnd,
    effectiveSamples: effHold,
    brierBefore,
    brierAfter: best.brierAfter,
    eceBefore: round4(eceBefore),
    eceAfter: best.eceAfter,
    verdict: `${best.cal.type} promoted on held-out evidence (Brier ${brierBefore} → ${best.brierAfter}, ECE ${round4(eceBefore)} → ${best.eceAfter}, ~${effHold} independent obs)`,
  };
}
