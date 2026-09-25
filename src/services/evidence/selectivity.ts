/**
 * Selective-prediction analysis — the HONEST machinery behind "make it more
 * accurate" (owner ask: ≥80% correct).
 *
 * No model here (or anywhere) gets 80% directional accuracy on every stock
 * every day; a system claiming that is lying or leaking. What a system CAN do
 * honestly is ABSTAIN: only issue a call when its calibrated probability is far
 * from 50%, and be measured on the calls it makes. That trades coverage for
 * accuracy, and this module MEASURES that trade on the graded ledger instead of
 * asserting it:
 *
 *   confidence = max(p, 1−p)   (distance from a coin flip)
 *   for each threshold t: coverage = share of graded predictions with
 *   confidence ≥ t; hit rate = accuracy on exactly those.
 *
 * Honesty rules, same as the rest of the evidence layer:
 *  - a hit rate over fewer than MIN_CALLS_FOR_RATE calls is WITHHELD (null);
 *  - a Wilson lower bound accompanies every rate so a lucky small sample can't
 *    read as skill;
 *  - the headline reports the best SUPPORTED operating point, and says plainly
 *    when no threshold reaches the target — including when the model simply
 *    never emits high confidence at all (the current champion tops out below
 *    65%, so "≥80% when confident" is not reachable yet and the report says so).
 *
 * PURE — callers fetch rows; this file only computes.
 */

export const SELECTIVITY_VERSION = "selectivity-v1";

/** Same floor as MIN_GRADED_FOR_RATE in EvidenceService — a rate over fewer
 *  calls than this is noise dressed as a track record. */
export const MIN_CALLS_FOR_RATE = 30;

/** The owner's stated target, kept visible so the report can measure the gap
 *  to it rather than quietly redefining success. */
export const TARGET_HIT_RATE_PCT = 80;

export interface GradedCall {
  /** Stated P(up) at issuance, in [0,1]. */
  probability: number;
  correct: boolean;
  horizonDays: number | null;
}

export interface OperatingPoint {
  /** Minimum confidence (max(p,1−p)) for a prediction to count as a CALL. */
  minConfidence: number;
  calls: number;
  /** calls / graded total — how often the system would actually speak. */
  coveragePct: number;
  correct: number;
  /** Withheld (null) below MIN_CALLS_FOR_RATE. */
  hitRatePct: number | null;
  /** Wilson 95% lower bound on the hit rate — the defensible claim. */
  hitRateLb95Pct: number | null;
}

export interface SelectivityReport {
  version: string;
  gradedTotal: number;
  targetHitRatePct: number;
  /** Highest confidence the model has EVER emitted on a graded row. */
  maxObservedConfidence: number | null;
  curve: OperatingPoint[];
  /** The best threshold whose LOWER BOUND clears the target, if any. */
  targetMet: OperatingPoint | null;
  /** Best supported (≥ MIN calls) hit rate anywhere on the curve. */
  bestSupported: OperatingPoint | null;
  headline: string;
  caveat: string;
}

const DEFAULT_THRESHOLDS = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8];

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/** Wilson score interval lower bound (95%, z=1.96). */
export function wilsonLb95(successes: number, n: number): number | null {
  if (n <= 0) return null;
  const z = 1.96;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (centre - margin) / denom);
}

export function selectivityCurve(rows: GradedCall[], thresholds: number[] = DEFAULT_THRESHOLDS): OperatingPoint[] {
  const graded = rows.filter((r) => Number.isFinite(r.probability) && r.probability >= 0 && r.probability <= 1);
  const total = graded.length;
  return thresholds.map((t) => {
    const covered = graded.filter((r) => Math.max(r.probability, 1 - r.probability) >= t);
    const correct = covered.filter((r) => r.correct).length;
    const enough = covered.length >= MIN_CALLS_FOR_RATE;
    const lb = enough ? wilsonLb95(correct, covered.length) : null;
    return {
      minConfidence: t,
      calls: covered.length,
      coveragePct: total > 0 ? round((covered.length / total) * 100, 1) : 0,
      correct,
      hitRatePct: enough ? round((correct / covered.length) * 100, 1) : null,
      hitRateLb95Pct: lb !== null ? round(lb * 100, 1) : null,
    };
  });
}

export function buildSelectivityReport(rows: GradedCall[], thresholds: number[] = DEFAULT_THRESHOLDS): SelectivityReport {
  const curve = selectivityCurve(rows, thresholds);
  const gradedTotal = rows.length;
  const maxConf = rows.length
    ? round(Math.max(...rows.map((r) => Math.max(r.probability, 1 - r.probability))), 4)
    : null;

  // The claim must survive its own lower bound — a point target-met on the
  // raw rate but not the LB is a lucky sample, not evidence.
  const targetMet =
    curve.find((p) => p.hitRateLb95Pct !== null && p.hitRateLb95Pct >= TARGET_HIT_RATE_PCT) ?? null;
  const supported = curve.filter((p) => p.hitRatePct !== null);
  const bestSupported = supported.length
    ? supported.reduce((a, b) => ((b.hitRatePct as number) > (a.hitRatePct as number) ? b : a))
    : null;

  let headline: string;
  if (gradedTotal < MIN_CALLS_FOR_RATE) {
    headline = `Only ${gradedTotal} graded predictions — too few for any selectivity statement.`;
  } else if (targetMet) {
    headline =
      `At confidence ≥${round(targetMet.minConfidence * 100, 0)}% the system hit ` +
      `${targetMet.hitRatePct}% (lower bound ${targetMet.hitRateLb95Pct}%) — but only speaks on ` +
      `${targetMet.coveragePct}% of predictions. Selectivity, not omniscience, is what the number means.`;
  } else {
    const best = bestSupported
      ? `best supported operating point: ${bestSupported.hitRatePct}% hit rate at confidence ≥` +
        `${round(bestSupported.minConfidence * 100, 0)}% (${bestSupported.calls} calls, ` +
        `${bestSupported.coveragePct}% coverage)`
      : "no threshold has enough calls to support a rate";
    const confNote =
      maxConf !== null && maxConf < 0.65
        ? ` The model has never emitted confidence above ${round(maxConf * 100, 1)}%, so a high-confidence tier does not exist yet.`
        : "";
    headline =
      `No operating point reaches the ${TARGET_HIT_RATE_PCT}% target on its 95% lower bound — ${best}.` +
      confNote +
      ` The honest path to a higher rate is a model whose confident calls are actually right, not a relabeled aggregate.`;
  }

  return {
    version: SELECTIVITY_VERSION,
    gradedTotal,
    targetHitRatePct: TARGET_HIT_RATE_PCT,
    maxObservedConfidence: maxConf,
    curve,
    targetMet,
    bestSupported,
    headline,
    caveat:
      "Daily-logged multi-day horizons overlap, so consecutive calls are not independent samples; " +
      "treat coverage-weighted rates as optimistic until the non-overlapping count is comparable.",
  };
}
