/**
 * Decision policy v3 — the TradeGate (risk-spec Rules 2, 8, 14; remediation
 * plan S2) — PURE and unit-testable.
 *
 * Evidence-gated: BUY_CANDIDATE requires ALL of
 *   1. a fresh stored forecast issuance anchored on the latest observed session,
 *   2. a VALIDATED directional edge — measured 30d hit rate beats 50% at ~95%
 *      one-sided confidence on the OVERLAP-ADJUSTED sample size,
 *   3. acceptable calibration (band coverage not understated, Brier not worse
 *      than chance) AND positive Brier skill,
 *   4. sufficient data quality and forecast confidence (ScoreCard),
 *   5. acceptable entry quality (a strong company at an extended price is
 *      NOT a buy — Rule 7),
 *   6. positive expected value AFTER transaction costs (Rule 8 — P(up)>50%
 *      alone never justifies BUY),
 *   7. non-extreme unified riskScore (closes audit §10.11's 45–60%-vol gap).
 *
 * v3 (2026-09-07): adds gates 4–7 per docs/risk-spec.md. The v3-only
 * thresholds are PROVISIONAL pending Stage-FOURTH walk-forward validation
 * (spec Rule 2: "determine sensible thresholds using historical walk-forward
 * experiments"); shipping them immediately is safe because every provisional
 * gate only RESTRICTS — loosening any of them requires validation evidence
 * recorded next to the constant.
 *
 * v4 (2026-09-08): regime caps (completion Phase 4) — a hostile market
 * regime (bear_high_vol) or an extended/late/high-event-risk entry regime
 * caps the decision at WATCH with its own unmet gate. Regime can only cap,
 * never boost (Rule 6).
 *
 * v2 (2026-09-06): overlap-adjusted sample sizes after the BHEL mirage
 * (79.5% over 39 daily-logged 30d windows ≈ 1 independent observation).
 *
 * Also new in v3 (Rule 14): a SEPARATE existing-holder evaluation —
 * a new-entry caution is never a sell instruction.
 */

export const DECISION_POLICY_VERSION = "decision-policy-v4";

export const POLICY_THRESHOLDS = {
  minMaturedSamples: 30, // fewer matured 30d predictions ⇒ INSUFFICIENT_EVIDENCE
  labelOverlapDays: 30, // 30d labels logged daily ⇒ effectiveN = rawN / 30
  minEffectiveSamples: 10, // below this, an edge test cannot validate at all
  edgeZ: 1.645, // one-sided 95% confidence that hit rate > 50%
  minBandCoveragePct: 60, // 80%-band coverage measured below this ⇒ uncertainty understated
  maxBrier: 0.3, // worse than chance ⇒ AVOID_NEW_ENTRY
  maxAnnualVolPct: 60, // extreme volatility without a validated edge ⇒ AVOID_NEW_ENTRY
  maxAnchorAgeDays: 5, // anchor older than this many calendar days ⇒ stale

  // v3 additions — PROVISIONAL until Stage-FOURTH validation (see header).
  minDataQuality: 70, // Rule 2 example gate: dataQualityScore < 70 ⇒ cap WATCH
  minForecastConfidence: 60, // forecastConfidenceScore < 60 ⇒ cap WATCH
  minEntryQuality: 40, // entry "unattractive" (<40) ⇒ cap WATCH even with edge
  riskScoreVeto: 80, // unified riskScore ≥ 80 ⇒ AVOID_NEW_ENTRY
} as const;

/** Overlap-adjusted independent-observation count for daily-logged h-day labels. */
export function effectiveSamples(rawSamples: number, overlapDays: number = POLICY_THRESHOLDS.labelOverlapDays): number {
  return Math.max(1, Math.floor(rawSamples / overlapDays));
}

export type DecisionStatus = "BUY_CANDIDATE" | "WAIT" | "AVOID_NEW_ENTRY" | "INSUFFICIENT_EVIDENCE";
export type HolderAction = "HOLD" | "REVIEW" | "INSUFFICIENT_DATA";
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

  // ── v3 gate inputs (all nullable — null means "not assessed", which can
  //    only make the outcome MORE conservative, never less) ─────────────────
  /** Unified 0-100 risk score (scorecard.computeRiskScore), null = unknown. */
  riskScore?: number | null;
  /** 0-100 measured data completeness (scorecard), null = not assessed. */
  dataQualityScore?: number | null;
  /** 0-100 measured-evidence confidence (scorecard), null = not assessed. */
  forecastConfidenceScore?: number | null;
  /** 0-100 entry quality v2, null = not assessed. */
  entryQualityScore?: number | null;
  /** Expected value AFTER round-trip costs, % (expectedValue.ts), null = not assessed. */
  evAfterCostsPct?: number | null;
  /** Phase 4 regime assessment (regimeEngine.ts), null = not assessed. */
  regime?: {
    marketRegime: string;
    entryRegime: string;
  } | null;
}

export interface PolicyDecision {
  decisionStatus: DecisionStatus;
  evidenceStatus: EvidenceStatus;
  riskLevel: RiskLevel;
  intendedHorizon: "short";
  reasons: string[];
  risks: string[];
  /**
   * Rule 17: what would have to change for a stronger action — every unmet
   * gate with its threshold, machine-readable for the "What would change the
   * decision?" panel.
   */
  unmetGates: Array<{ gate: string; current: string; required: string }>;
  /** Separate holdings guidance (spec §9): never a sell instruction. */
  holdingsReviewNote: string;
}

export interface HolderContext {
  /** Supplied by the user, never inferred (Rule 14). */
  purchasePrice?: number | null;
  investmentHorizon?: "short" | "medium" | "long" | null;
  riskTolerance?: "low" | "medium" | "high" | null;
}

export interface HolderDecision {
  action: HolderAction;
  reasons: string[];
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
  const unmetGates: Array<{ gate: string; current: string; required: string }> = [];

  const vol = inputs.issuance?.annualizedVolPct ?? null;
  const riskLevel: RiskLevel =
    inputs.riskScore != null
      ? inputs.riskScore < 35
        ? "low"
        : inputs.riskScore < 60
        ? "medium"
        : "high"
      : vol == null
      ? "unknown"
      : vol < 25
      ? "low"
      : vol < 45
      ? "medium"
      : "high";

  const finish = (decisionStatus: DecisionStatus, evidenceStatus: EvidenceStatus): PolicyDecision => ({
    decisionStatus,
    evidenceStatus,
    riskLevel,
    intendedHorizon: "short",
    reasons,
    risks,
    unmetGates,
    holdingsReviewNote: HOLDINGS_NOTE,
  });

  // ── Gate 0: evidence exists and is fresh ──────────────────────────────────
  if (!inputs.issuance) {
    reasons.push(`No stored forecast issuance exists for ${inputs.ticker} yet — nothing to decide on.`);
    unmetGates.push({ gate: "forecast issuance", current: "none", required: "a stored issuance anchored on the latest session" });
    return finish("INSUFFICIENT_EVIDENCE", "INSUFFICIENT");
  }
  if (!inputs.issuance.anchorIsLatestObservedSession || inputs.issuance.anchorAgeDays > T.maxAnchorAgeDays) {
    reasons.push(
      `The stored issuance is stale (anchored ${inputs.issuance.anchorSessionDate}, ` +
        `${inputs.issuance.anchorAgeDays} calendar days old${
          inputs.issuance.anchorIsLatestObservedSession ? "" : "; a newer session close exists"
        }) — re-issue before deciding.`
    );
    unmetGates.push({
      gate: "issuance freshness",
      current: `${inputs.issuance.anchorAgeDays}d old`,
      required: `anchored on the latest session, ≤${T.maxAnchorAgeDays}d`,
    });
    return finish("INSUFFICIENT_EVIDENCE", "INSUFFICIENT");
  }
  if (!inputs.measured || inputs.measured.samples < T.minMaturedSamples) {
    reasons.push(
      inputs.measured
        ? `Only ${inputs.measured.samples} matured 30-day predictions measured for ${inputs.ticker} ` +
          `(minimum ${T.minMaturedSamples}) — not enough evidence for an entry opinion.`
        : `No measured walk-forward record exists for ${inputs.ticker} — no evidence to decide on.`
    );
    unmetGates.push({
      gate: "measured record",
      current: inputs.measured ? `${inputs.measured.samples} raw samples` : "none",
      required: `≥${T.minMaturedSamples} matured predictions`,
    });
    return finish("INSUFFICIENT_EVIDENCE", "INSUFFICIENT");
  }

  const m = inputs.measured;
  const brierSkill = 0.25 - m.brierScore;

  // ── Gate 1: hard-risk exclusions ⇒ AVOID_NEW_ENTRY ───────────────────────
  if (m.withinBandPct < T.minBandCoveragePct) {
    reasons.push(
      `Measured 80% band coverage for ${inputs.ticker} is ${m.withinBandPct.toFixed(1)}% ` +
        `(threshold ${T.minBandCoveragePct}%) — the model understates this stock's uncertainty.`
    );
    unmetGates.push({ gate: "band coverage", current: `${m.withinBandPct.toFixed(1)}%`, required: `≥${T.minBandCoveragePct}%` });
  }
  if (m.brierScore > T.maxBrier) {
    reasons.push(`Measured Brier score ${m.brierScore.toFixed(4)} is worse than chance (${T.maxBrier}) for this stock.`);
    unmetGates.push({ gate: "Brier", current: m.brierScore.toFixed(4), required: `≤${T.maxBrier}` });
  }
  if (vol != null && vol > T.maxAnnualVolPct) {
    reasons.push(
      `Annualized volatility ≈ ${vol.toFixed(0)}% (threshold ${T.maxAnnualVolPct}%) — extreme risk without a validated edge.`
    );
    unmetGates.push({ gate: "volatility", current: `${vol.toFixed(0)}%`, required: `≤${T.maxAnnualVolPct}%` });
  }
  if (inputs.riskScore != null && inputs.riskScore >= T.riskScoreVeto) {
    reasons.push(
      `Unified risk score ${inputs.riskScore.toFixed(0)}/100 (veto at ${T.riskScoreVeto}) — volatility/drawdown character too hostile for a new entry.`
    );
    unmetGates.push({ gate: "risk score", current: `${inputs.riskScore.toFixed(0)}`, required: `<${T.riskScoreVeto}` });
  }
  if (reasons.length > 0) {
    risks.push("Position sizing cannot compensate for an unvalidated or miscalibrated forecast.");
    return finish("AVOID_NEW_ENTRY", "PARTIAL");
  }

  // ── Gate 2 (v3): WATCH caps — each alone is sufficient to block BUY ──────
  let capped = false;
  const cap = (why: string, gate: { gate: string; current: string; required: string }) => {
    reasons.push(why);
    unmetGates.push(gate);
    capped = true;
  };

  if (brierSkill <= 0) {
    cap(
      `Brier skill ${brierSkill.toFixed(4)} ≤ 0 — the model has NOT beaten a constant 50% forecast out of sample; the maximum supportable action is WATCH.`,
      { gate: "Brier skill", current: brierSkill.toFixed(4), required: "> 0" }
    );
  }
  const edge = directionEdgeValidated(m.directionHitRatePct, m.samples);
  if (!edge) {
    const effN = effectiveSamples(m.samples);
    cap(
      `No validated directional edge: measured 30-day direction hit rate is ` +
        `${m.directionHitRatePct.toFixed(1)}% over ${m.samples} matured predictions — but daily-logged ` +
        `30-day windows overlap almost entirely, so that is only ~${effN} independent observation${effN === 1 ? "" : "s"} ` +
        `(far too few to distinguish skill from chance). The calibrated ranges are the supported product.`,
      { gate: "directional edge", current: `${m.directionHitRatePct.toFixed(1)}% over ~${effN} independent obs`, required: `one-sided 95% above 50% on ≥${T.minEffectiveSamples} independent obs` }
    );
  }
  if (inputs.dataQualityScore != null && inputs.dataQualityScore < T.minDataQuality) {
    cap(
      `Data quality ${inputs.dataQualityScore.toFixed(0)}/100 (minimum ${T.minDataQuality}) — missing or suspect inputs make a buy opinion unsupportable.`,
      { gate: "data quality", current: `${inputs.dataQualityScore.toFixed(0)}`, required: `≥${T.minDataQuality}` }
    );
  }
  if (inputs.forecastConfidenceScore != null && inputs.forecastConfidenceScore < T.minForecastConfidence) {
    cap(
      `Forecast confidence ${inputs.forecastConfidenceScore.toFixed(0)}/100 (minimum ${T.minForecastConfidence}) — measured out-of-sample evidence does not support a buy.`,
      { gate: "forecast confidence", current: `${inputs.forecastConfidenceScore.toFixed(0)}`, required: `≥${T.minForecastConfidence}` }
    );
  }
  if (inputs.entryQualityScore != null && inputs.entryQualityScore < T.minEntryQuality) {
    cap(
      `Entry quality ${inputs.entryQualityScore.toFixed(0)}/100 (minimum ${T.minEntryQuality}) — the setup may be strong but THIS price is an unattractive entry (extension/reward-risk penalties).`,
      { gate: "entry quality", current: `${inputs.entryQualityScore.toFixed(0)}`, required: `≥${T.minEntryQuality}` }
    );
  }
  if (inputs.evAfterCostsPct != null && inputs.evAfterCostsPct <= 0) {
    cap(
      `Expected value after round-trip costs is ${inputs.evAfterCostsPct.toFixed(2)}% — a scenario frequency above 50% does not justify BUY when the expected P&L net of fees is not positive.`,
      { gate: "expected value", current: `${inputs.evAfterCostsPct.toFixed(2)}% after costs`, required: "> 0%" }
    );
  }
  if (inputs.regime) {
    if (inputs.regime.marketRegime === "bear_high_vol") {
      cap(
        "Market regime is bear_high_vol — new entries are capped at WATCH regardless of the setup (regime caps, never boosts).",
        { gate: "market regime", current: inputs.regime.marketRegime, required: "not bear_high_vol" }
      );
    }
    if (["extended_uptrend", "late_trend", "high_event_risk"].includes(inputs.regime.entryRegime)) {
      cap(
        `Entry regime is ${inputs.regime.entryRegime} — chasing extension/late trends or entering into event risk is capped at WATCH.`,
        { gate: "entry regime", current: inputs.regime.entryRegime, required: "healthy/neutral/breakout entry regime" }
      );
    }
  }

  if (capped) {
    if (inputs.issuance.medianReturnPct30 != null) {
      reasons.push(
        `Median 30-day forecast return ${inputs.issuance.medianReturnPct30.toFixed(2)}% is a distribution centre, not a signal.`
      );
    }
    if (inputs.afterMarketClose) {
      reasons.push("Market is closed — any entry would be a candidate for the NEXT session, not now.");
    }
    risks.push("Fees on small Indian delivery trades can consume ~2% round-trip — see the fee model.");
    return finish("WAIT", "PARTIAL");
  }

  // ── BUY_CANDIDATE — every gate passed (unreachable on today's evidence) ──
  reasons.push(
    `Validated directional edge: ${m.directionHitRatePct.toFixed(1)}% over ${m.samples} matured ` +
      `predictions (~${effectiveSamples(m.samples)} independent windows; one-sided 95% above 50% ` +
      `after overlap adjustment), positive Brier skill, calibration, data quality, entry quality ` +
      `and after-cost expected value all within thresholds.`
  );
  if (inputs.afterMarketClose) {
    reasons.push("Market is closed — candidate for the NEXT session.");
  }
  risks.push("A validated historical edge does not guarantee future performance.");
  return finish("BUY_CANDIDATE", "VALIDATED");
}

/**
 * Rule 14: the EXISTING-POSITION decision, separate from new-entry advice.
 * Never emits a sell instruction; REVIEW means "re-examine against your own
 * basis/horizon", triggered only by hard evidence (extreme risk character,
 * collapsed data quality, or a measured-calibration breakdown).
 */
export function evaluateHolderPolicy(
  entry: PolicyDecision,
  inputs: PolicyInputs,
  ctx?: HolderContext | null
): HolderDecision {
  const reasons: string[] = [];

  if (entry.decisionStatus === "INSUFFICIENT_EVIDENCE" && !inputs.measured) {
    return {
      action: "INSUFFICIENT_DATA",
      reasons: ["No measured record and no stored issuance — position review needs evidence, not guesses."],
    };
  }

  let review = false;
  if (inputs.riskScore != null && inputs.riskScore >= POLICY_THRESHOLDS.riskScoreVeto) {
    review = true;
    reasons.push(
      `Risk character is extreme (risk score ${inputs.riskScore.toFixed(0)}/100) — re-check position size against your maximum acceptable loss.`
    );
  }
  if (inputs.dataQualityScore != null && inputs.dataQualityScore < 50) {
    review = true;
    reasons.push(
      `Data quality has degraded to ${inputs.dataQualityScore.toFixed(0)}/100 — the evidence behind any thesis is currently unreliable.`
    );
  }
  if (inputs.measured && inputs.measured.withinBandPct < POLICY_THRESHOLDS.minBandCoveragePct) {
    review = true;
    reasons.push(
      `The model's uncertainty bands have measurably understated this stock's moves (coverage ${inputs.measured.withinBandPct.toFixed(0)}%) — widen your own downside assumptions.`
    );
  }
  if (ctx?.riskTolerance === "low" && inputs.riskScore != null && inputs.riskScore >= 60) {
    review = true;
    reasons.push(
      `Your stated risk tolerance is LOW but this stock's risk score is ${inputs.riskScore.toFixed(0)}/100 — the position may no longer match your settings.`
    );
  }

  if (review) return { action: "REVIEW", reasons };

  reasons.push(
    "No hard evidence demands action on an existing position. A new-entry WAIT is about TODAY'S price for NEW money, not about your position."
  );
  if (ctx?.purchasePrice != null && inputs.issuance?.medianReturnPct30 != null) {
    reasons.push(
      "Judge the position against your own basis and horizon using the forecast ranges — the median is a distribution centre, not a target."
    );
  }
  return { action: "HOLD", reasons };
}
