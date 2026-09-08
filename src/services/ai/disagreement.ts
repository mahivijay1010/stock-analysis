/**
 * aiDisagreementScore (Part 13) — DETERMINISTIC 0-100 measure of conflict
 * between AI role findings. Contradictory opinions must reduce confidence,
 * never be averaged into false certainty; this score (with its reasons) is
 * fed to the Risk Committee and stored alongside the roles' outputs.
 */

import { FundamentalAnalysis, ForecastCritique, TechnicalSynthesis, EventAnalysis } from "../reasoning/roles";

export interface DisagreementReport {
  score: number; // 0-100
  reasons: string[];
}

export function computeAiDisagreement(parts: {
  fundamental?: FundamentalAnalysis | null;
  technical?: TechnicalSynthesis | null;
  events?: EventAnalysis | null;
  critic?: ForecastCritique | null;
}): DisagreementReport {
  const reasons: string[] = [];
  let score = 0;

  const f = parts.fundamental ?? null;
  const t = parts.technical ?? null;
  const e = parts.events ?? null;
  const c = parts.critic ?? null;

  const fundamentalPositive =
    f != null && f.businessTrajectory === "IMPROVING" && (f.qualityAssessment === "STRONG" || f.qualityAssessment === "MODERATE");
  const technicalWeakEntry =
    t != null &&
    (t.participation === "WEAK" ||
      ["CONSOLIDATION", "PULLBACK", "DISTRIBUTION", "DOWNTREND"].includes(t.shortTermState));

  if (fundamentalPositive && c != null && (!c.forecastUsable || c.confidence === "LOW")) {
    score += 30;
    reasons.push("Fundamental Analyst is positive while the Forecast Critic finds the forecast unusable / low-confidence.");
  }
  if (fundamentalPositive && technicalWeakEntry) {
    score += 25;
    reasons.push("High-quality business but weak current entry (technical state contradicts the fundamental view).");
  }
  if (f != null && fundamentalPositive && (f.valuationAssessment === "EXPENSIVE" || f.valuationAssessment === "EXTREME")) {
    score += 15;
    reasons.push(`Improving business but ${f.valuationAssessment} valuation — quality and price disagree.`);
  }
  if (e != null) {
    const pricedPositives = e.interpretations.filter(
      (i) => i.direction === "POSITIVE" && (i.alreadyPricedProbability ?? 0) > 0.6
    );
    if (pricedPositives.length > 0) {
      score += 15;
      reasons.push(`${pricedPositives.length} positive event(s) judged likely already priced in.`);
    }
  }
  if (c != null && t != null && c.forecastUsable && technicalWeakEntry) {
    score += 10;
    reasons.push("Critic accepts the forecast but the technical state argues against acting on it now.");
  }
  if (f != null && f.contradictions.length > 0) {
    score += Math.min(15, f.contradictions.length * 5);
    reasons.push(`Fundamental evidence contains ${f.contradictions.length} internal contradiction(s).`);
  }

  return { score: Math.min(100, score), reasons };
}
