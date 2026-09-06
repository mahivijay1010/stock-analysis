/**
 * Decision policy v2 (Phase C, spec §9) — PURE and unit-testable.
 *
 * Evidence-gated: BUY_CANDIDATE requires (all of)
 *   1. a fresh stored forecast issuance anchored on the latest observed session,
 *   2. a VALIDATED directional edge — the measured 30d direction hit rate must
 *      beat 50% at ~95% confidence on the OVERLAP-ADJUSTED sample size,
 *   3. acceptable calibration (band coverage not badly understated, Brier not
 *      worse than chance), and
 *   4. non-extreme volatility.
 *
 * v2 (2026-09-06): v1 treated daily-logged 30-day predictions as independent
 * Bernoulli trials — n=39 nightly 30d predictions span ~2 months and share
 * ~29/30 of their outcome windows, so they are ~1–2 independent observations,
 * not 39 (spec §8: "Do not call thousands of overlapping predictions
 * thousands of independent observations"). v1 briefly produced a
 * BUY_CANDIDATE from exactly this mirage (BHEL.NS, 2026-09-06); v2 divides
 * the sample count by the label horizon (30) before the significance test.
 * Validating a genuine 30d edge now honestly requires years of matured
 * nightly logs — which is the truth of the matter.
 *
 * Thresholds are VERSIONED here (DECISION_POLICY_VERSION); changing them is a
 * new policy version, never a silent tweak.
 */

export const DECISION_POLICY_VERSION = "decision-policy-v2";

export const POLICY_THRESHOLDS = {
  minMaturedSamples: 30, // fewer matured 30d predictions ⇒ INSUFFICIENT_EVIDENCE
  labelOverlapDays: 30, // 30d labels logged daily ⇒ effectiveN = rawN / 30
  minEffectiveSamples: 10, // below this, an edge test cannot validate at all
  edgeZ: 1.645, // one-sided 95% confidence that hit rate > 50%
  minBandCoveragePct: 60, // 80%-band coverage measured below this ⇒ uncertainty understated
  maxBrier: 0.3, // worse than chance ⇒ AVOID_NEW_ENTRY
  maxAnnualVolPct: 60, // extreme volatility without a validated edge ⇒ AVOID_NEW_ENTRY
  maxAnchorAgeDays: 5, // anchor older than this many calendar days ⇒ stale
} as const;

/** Overlap-adjusted independent-observation count for daily-logged h-day labels. */
export function effectiveSamples(rawSamples: number, overlapDays: number = POLICY_THRESHOLDS.labelOverlapDays): number {
  return Math.max(1, Math.floor(rawSamples / overlapDays));
}

export type DecisionStatus = "BUY_CANDIDATE" | "WAIT" | "AVOID_NEW_ENTRY" | "INSUFFICIENT_EVIDENCE";
export type EvidenceStatus = "VALIDATED" | "PARTIAL" | "INSUFFICIENT";
export type RiskLevel = "low" | "medium" | "high" | "unknown";

export interface PolicyInputs {
  ticker: string;
  /** Latest stored issuance, or null. */
  issuance: {
    anchorSessionDate: string;
    anchorAgeDays: number; // calendar days from anchor to asOf date
    anchorIsLatestObservedSession: boolean;
    targetSessionCount: number;
    /** Annualized vol %, derived from the issuance's own step-1 80% band. */
    annualizedVolPct: number | null;
    medianReturnPct30: number | null; // last-session median cumulative return
  } | null;
  /** Measured 30d walk-forward stats for THIS ticker, or null when absent. */
  measured: {
    samples: number;
    directionHitRatePct: number;
    withinBandPct: number;
    brierScore: number;
  } | null;
  /** True between the session close and the next open (IST). */
  afterMarketClose: boolean;
}

export interface PolicyDecision {
  decisionStatus: DecisionStatus;
  evidenceStatus: EvidenceStatus;
  riskLevel: RiskLevel;
  intendedHorizon: "short";
  reasons: string[];
  risks: string[];
  /** Separate holdings guidance (spec §9): never a sell instruction. */
  holdingsReviewNote: string;
}

const HOLDINGS_NOTE =
  "Holdings review is separate from new-entry advice: a new-entry caution is NOT an instruction to sell. " +
  "Judge an existing position against your own basis, horizon and the forecast ranges.";

/**
 * One-sided test: is hitRatePct significantly above 50% at z confidence?
 * `samples` is the RAW matured-prediction count; it is overlap-adjusted here
 * (spec §8) — overlapping 30d labels are not independent observations.
 */
export function directionEdgeValidated(
  hitRatePct: number,
  samples: number,
  z: number = POLICY_THRESHOLDS.edgeZ
): boolean {
  const effN = effectiveSamples(samples);
  if (effN < POLICY_THRESHOLDS.minEffectiveSamples) return false;
  const p = hitRatePct / 100;
  const se = Math.sqrt(0.25 / effN); // worst-case σ over INDEPENDENT windows
  return p - z * se > 0.5;
}

export function evaluateEntryPolicy(inputs: PolicyInputs): PolicyDecision {
  const T = POLICY_THRESHOLDS;
  const reasons: string[] = [];
  const risks: string[] = [];

  const vol = inputs.issuance?.annualizedVolPct ?? null;
  const riskLevel: RiskLevel = vol == null ? "unknown" : vol < 25 ? "low" : vol < 45 ? "medium" : "high";

  // ── Gate 0: evidence exists and is fresh ──────────────────────────────────
  if (!inputs.issuance) {
    return {
      decisionStatus: "INSUFFICIENT_EVIDENCE",
      evidenceStatus: "INSUFFICIENT",
      riskLevel,
      intendedHorizon: "short",
      reasons: [`No stored forecast issuance exists for ${inputs.ticker} yet — nothing to decide on.`],
      risks,
      holdingsReviewNote: HOLDINGS_NOTE,
    };
  }
  if (!inputs.issuance.anchorIsLatestObservedSession || inputs.issuance.anchorAgeDays > T.maxAnchorAgeDays) {
    return {
      decisionStatus: "INSUFFICIENT_EVIDENCE",
      evidenceStatus: "INSUFFICIENT",
      riskLevel,
      intendedHorizon: "short",
      reasons: [
        `The stored issuance is stale (anchored ${inputs.issuance.anchorSessionDate}, ` +
          `${inputs.issuance.anchorAgeDays} calendar days old${
            inputs.issuance.anchorIsLatestObservedSession ? "" : "; a newer session close exists"
          }) — re-issue before deciding.`,
      ],
      risks,
      holdingsReviewNote: HOLDINGS_NOTE,
    };
  }
  if (!inputs.measured || inputs.measured.samples < T.minMaturedSamples) {
    return {
      decisionStatus: "INSUFFICIENT_EVIDENCE",
      evidenceStatus: "INSUFFICIENT",
      riskLevel,
      intendedHorizon: "short",
      reasons: [
        inputs.measured
          ? `Only ${inputs.measured.samples} matured 30-day predictions measured for ${inputs.ticker} ` +
            `(minimum ${T.minMaturedSamples}) — not enough evidence for an entry opinion.`
          : `No measured walk-forward record exists for ${inputs.ticker} — no evidence to decide on.`,
      ],
      risks,
      holdingsReviewNote: HOLDINGS_NOTE,
    };
  }

  const m = inputs.measured;

  // ── Gate 1: hard-risk exclusions ⇒ AVOID_NEW_ENTRY ───────────────────────
  if (m.withinBandPct < T.minBandCoveragePct) {
    reasons.push(
      `Measured 80% band coverage for ${inputs.ticker} is ${m.withinBandPct.toFixed(1)}% ` +
        `(threshold ${T.minBandCoveragePct}%) — the model understates this stock's uncertainty.`
    );
  }
  if (m.brierScore > T.maxBrier) {
    reasons.push(
      `Measured Brier score ${m.brierScore.toFixed(4)} is worse than chance (${T.maxBrier}) for this stock.`
    );
  }
  if (vol != null && vol > T.maxAnnualVolPct) {
    reasons.push(
      `Annualized volatility ≈ ${vol.toFixed(0)}% (threshold ${T.maxAnnualVolPct}%) — extreme risk ` +
        `without a validated edge.`
    );
  }
  if (reasons.length > 0) {
    risks.push("Position sizing cannot compensate for an unvalidated or miscalibrated forecast.");
    return {
      decisionStatus: "AVOID_NEW_ENTRY",
      evidenceStatus: "PARTIAL",
      riskLevel,
      intendedHorizon: "short",
      reasons,
      risks,
      holdingsReviewNote: HOLDINGS_NOTE,
    };
  }

  // ── Gate 2: validated directional edge required for BUY_CANDIDATE ────────
  const edge = directionEdgeValidated(m.directionHitRatePct, m.samples);
  if (!edge) {
    const effN = effectiveSamples(m.samples);
    reasons.push(
      `No validated directional edge: measured 30-day direction hit rate is ` +
        `${m.directionHitRatePct.toFixed(1)}% over ${m.samples} matured predictions — but daily-logged ` +
        `30-day windows overlap almost entirely, so that is only ~${effN} independent observation${effN === 1 ? "" : "s"} ` +
        `(far too few to distinguish skill from chance). The calibrated ranges are the supported product.`
    );
    if (inputs.issuance.medianReturnPct30 != null) {
      reasons.push(
        `Median 30-day forecast return ${inputs.issuance.medianReturnPct30.toFixed(2)}% is a distribution ` +
          `centre, not a signal.`
      );
    }
    if (inputs.afterMarketClose) {
      reasons.push("Market is closed — any entry would be a candidate for the NEXT session, not now.");
    }
    risks.push("Fees on small Indian delivery trades can consume ~2% round-trip — see the fee model.");
    return {
      decisionStatus: "WAIT",
      evidenceStatus: "PARTIAL",
      riskLevel,
      intendedHorizon: "short",
      reasons,
      risks,
      holdingsReviewNote: HOLDINGS_NOTE,
    };
  }

  // ── BUY_CANDIDATE (unreachable today — kept honest and fully gated) ──────
  reasons.push(
    `Validated directional edge: ${m.directionHitRatePct.toFixed(1)}% over ${m.samples} matured ` +
      `predictions (~${effectiveSamples(m.samples)} independent windows; one-sided 95% above 50% ` +
      `after overlap adjustment), calibration within thresholds.`
  );
  if (inputs.afterMarketClose) {
    reasons.push("Market is closed — candidate for the NEXT session.");
  }
  risks.push("A validated historical edge does not guarantee future performance.");
  return {
    decisionStatus: "BUY_CANDIDATE",
    evidenceStatus: "VALIDATED",
    riskLevel,
    intendedHorizon: "short",
    reasons,
    risks,
    holdingsReviewNote: HOLDINGS_NOTE,
  };
}
