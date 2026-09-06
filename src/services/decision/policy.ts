/**
 * Decision policy v1 (Phase C, spec §9) — PURE and unit-testable.
 *
 * Evidence-gated: BUY_CANDIDATE requires (all of)
 *   1. a fresh stored forecast issuance anchored on the latest observed session,
 *   2. a VALIDATED directional edge — the measured 30d direction hit rate must
 *      beat 50% at ~95% confidence (one-sided normal approx of the binomial),
 *      on ≥ MIN_SAMPLES matured predictions,
 *   3. acceptable calibration (band coverage not badly understated, Brier not
 *      worse than chance), and
 *   4. non-extreme volatility.
 * The system's measured direction accuracy is ≈ a coin flip, so gate 2 fails
 * today and BUY_CANDIDATE is honestly unreachable ("No validated directional
 * edge" — spec §8: do not lower the bar to make the UI say BUY).
 *
 * Thresholds are VERSIONED here (DECISION_POLICY_VERSION); changing them is a
 * new policy version, never a silent tweak.
 */

export const DECISION_POLICY_VERSION = "decision-policy-v1";

export const POLICY_THRESHOLDS = {
  minMaturedSamples: 30, // fewer matured 30d predictions ⇒ INSUFFICIENT_EVIDENCE
  edgeZ: 1.645, // one-sided 95% confidence that hit rate > 50%
  minBandCoveragePct: 60, // 80%-band coverage measured below this ⇒ uncertainty understated
  maxBrier: 0.3, // worse than chance ⇒ AVOID_NEW_ENTRY
  maxAnnualVolPct: 60, // extreme volatility without a validated edge ⇒ AVOID_NEW_ENTRY
  maxAnchorAgeDays: 5, // anchor older than this many calendar days ⇒ stale
} as const;

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

/** One-sided test: is hitRatePct significantly above 50% at z confidence? */
export function directionEdgeValidated(
  hitRatePct: number,
  samples: number,
  z: number = POLICY_THRESHOLDS.edgeZ
): boolean {
  if (samples <= 0) return false;
  const p = hitRatePct / 100;
  const se = Math.sqrt(0.25 / samples); // worst-case σ for a proportion
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
    reasons.push(
      `No validated directional edge: measured 30-day direction hit rate is ` +
        `${m.directionHitRatePct.toFixed(1)}% over ${m.samples} matured predictions — statistically ` +
        `indistinguishable from a coin flip. The calibrated ranges are the supported product.`
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
      `predictions (one-sided 95% above 50%), calibration within thresholds.`
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
