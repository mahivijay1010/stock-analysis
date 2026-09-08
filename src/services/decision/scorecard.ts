/**
 * ScoreCard (risk-spec Rule 1; remediation plan S1) — PURE.
 *
 * Separates what the product previously blurred into one number:
 *  - descriptive scores (setup/technical/momentum/valuation/fundamental/
 *    businessQuality/entryQuality) — statements about the PRESENT setup,
 *  - riskScore — ONE formula replacing the three inconsistent risk labels
 *    (audit §10.4) as the gating source of truth,
 *  - dataQualityScore — measured completeness; missing inputs are penalties,
 *    never silently neutral (Rule 11),
 *  - forecastConfidenceScore — derived ONLY from measured out-of-sample
 *    evidence (Brier skill, overlap-adjusted samples, band coverage); it is
 *    the number the UI must show as "model confidence", and it is LOW today
 *    for every stock because the measured record has no edge. That is the
 *    honest answer, not a bug.
 *
 * NOTHING here is a probability. overallOpportunityScore is a descriptive
 * blend hard-capped by evidence quality, labeled as such.
 */

import { effectiveSamples } from "./policy";

export const SCORECARD_VERSION = "scorecard-v1";

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const round1 = (x: number): number => Math.round(x * 10) / 10;

// ── riskScore: one formula (higher = riskier) ────────────────────────────────

export interface RiskInputs {
  annualVolPct: number | null; // realized, 1y
  maxDrawdownPct1y: number | null; // positive %
  /** Median daily traded value proxy (₹), null when unknown. */
  medianDailyTurnover?: number | null;
}

export interface RiskScore {
  score: number | null; // 0-100, null when core inputs missing
  band: "low" | "medium" | "high" | "unknown";
  reasons: string[];
}

/**
 * 60% volatility + 40% drawdown, each mapped to 0-100; illiquidity adds up to
 * +10. Bands: <35 low, <60 medium, else high. Missing vol or drawdown ⇒ null
 * score + "unknown" band (never a fabricated middle).
 */
export function computeRiskScore(i: RiskInputs): RiskScore {
  if (i.annualVolPct == null || i.maxDrawdownPct1y == null) {
    return {
      score: null,
      band: "unknown",
      reasons: ["Risk inputs incomplete (need 1y volatility and max drawdown) — risk cannot be scored."],
    };
  }
  // vol: 15% → 0, 60%+ → 100 (linear)
  const volPart = clamp(((i.annualVolPct - 15) / 45) * 100, 0, 100);
  // drawdown: 10% → 0, 60%+ → 100
  const ddPart = clamp(((i.maxDrawdownPct1y - 10) / 50) * 100, 0, 100);
  let score = 0.6 * volPart + 0.4 * ddPart;
  const reasons = [
    `Annualized volatility ${i.annualVolPct.toFixed(0)}% and 1y max drawdown ${i.maxDrawdownPct1y.toFixed(0)}%.`,
  ];
  if (i.medianDailyTurnover != null && i.medianDailyTurnover < 10_000_000) {
    score += 10;
    reasons.push("Thin liquidity (median daily turnover < ₹1 crore) adds exit risk.");
  }
  score = round1(clamp(score, 0, 100));
  const band = score < 35 ? "low" : score < 60 ? "medium" : "high";
  return { score, band, reasons };
}

// ── dataQualityScore: measured completeness (Rule 11) ────────────────────────

export interface DataQualityInputs {
  barCount: number;
  /** "yahoo" | "db-fresh" | "db-stale" (stale = provider down, serving cache). */
  barsSource: string | null;
  /** Calendar days between the last bar and the last known trading session. */
  barStalenessDays: number | null;
  /** Any |1d return| > this % in the bar history ⇒ possible unadjusted corporate action. */
  suspectedCorporateActionBreak: boolean;
  fundamentalsAvailable: boolean;
  /** Of the fundamentals fields the checks rely on, how many are non-null (0..1). */
  fundamentalsCompleteness: number | null;
  filingsMetricsAvailable: boolean;
  newsAvailable: boolean;
}

export interface DataQualityScore {
  score: number; // 0-100
  penalties: string[]; // every deduction, itemized — nothing silent
}

export function computeDataQualityScore(i: DataQualityInputs): DataQualityScore {
  let score = 100;
  const penalties: string[] = [];
  const hit = (points: number, why: string) => {
    score -= points;
    penalties.push(`−${points}: ${why}`);
  };

  if (i.barCount < 250) hit(15, `only ${i.barCount} daily bars (<1 trading year) — vol/drawdown/backtests under-sampled`);
  else if (i.barCount < 400) hit(5, `${i.barCount} daily bars — under 2 trading years of history`);

  if (i.barsSource === "db-stale") hit(20, "price provider unavailable — serving stale cached bars");
  if (i.barStalenessDays != null && i.barStalenessDays > 3) {
    hit(15, `last bar is ${i.barStalenessDays} calendar days behind the last trading session`);
  }
  if (i.suspectedCorporateActionBreak) {
    hit(20, "a >25% single-day price jump exists in stored history — possible UNADJUSTED corporate action corrupting returns/volatility (audit §9.1)");
  }
  if (!i.fundamentalsAvailable) hit(15, "no fundamentals available");
  else if (i.fundamentalsCompleteness != null && i.fundamentalsCompleteness < 0.6) {
    hit(10, `fundamentals only ${(i.fundamentalsCompleteness * 100).toFixed(0)}% complete — missing fields are NOT neutral`);
  }
  if (!i.filingsMetricsAvailable) hit(10, "no official-filings metrics stored (business quality unverifiable)");
  if (!i.newsAvailable) hit(5, "no recent news coverage cached — event risk unobserved");

  return { score: round1(clamp(score, 0, 100)), penalties };
}

// ── forecastConfidenceScore: measured out-of-sample evidence ONLY ────────────

export interface ForecastConfidenceInputs {
  /** Measured Brier (30d) for this ticker/system; null when no record. */
  brier: number | null;
  /** Raw matured sample count behind that Brier. */
  rawSamples: number | null;
  /** Overlap window (days) of those samples. */
  overlapDays: number;
  /** Measured 80%-band coverage %, null when unknown. */
  bandCoveragePct: number | null;
  /** |recent-window Brier − prior-window Brier|, null when only one window exists. */
  stabilityDelta: number | null;
}

export interface ForecastConfidence {
  score: number; // 0-100
  band: "LOW" | "MEDIUM" | "HIGH";
  brierSkill: number | null; // 0.25 − brier; ≤0 means no edge over a coin flip
  effectiveSamples: number | null;
  reasons: string[];
  /** Part 18: machine-readable WHY — points lost per uncertainty source. */
  contributions: Array<{ factor: string; earned: number; max: number; shortfall: number; detail: string }>;
}

/**
 * Starts at 0 and must EARN points from evidence:
 *  +40 max from Brier skill (0 at skill≤0, full at skill≥0.05),
 *  +30 max from effective samples (0 at ≤1, full at ≥100),
 *  +20 max from band-coverage accuracy (full at |coverage−80|≤5, 0 at ≥25 off),
 *  +10 max from stability (full at delta≤0.005, 0 at ≥0.03).
 * Bands: <40 LOW, <65 MEDIUM, else HIGH. With today's measured record
 * (skill ≤ 0 system-wide, effN ≈ 1) every stock scores LOW. Honest.
 */
export function computeForecastConfidence(i: ForecastConfidenceInputs): ForecastConfidence {
  const reasons: string[] = [];
  if (i.brier == null || i.rawSamples == null) {
    return {
      score: 0,
      band: "LOW",
      brierSkill: null,
      effectiveSamples: null,
      reasons: ["No measured out-of-sample record — forecast confidence cannot exceed LOW."],
      contributions: [
        { factor: "measured evidence", earned: 0, max: 100, shortfall: -100, detail: "no out-of-sample record at all" },
      ],
    };
  }
  const brierSkill = Math.round((0.25 - i.brier) * 10_000) / 10_000;
  const effN = effectiveSamples(i.rawSamples, i.overlapDays);

  const skillPts = clamp((brierSkill / 0.05) * 40, 0, 40);
  const samplePts = clamp(((effN - 1) / 99) * 30, 0, 30);
  const coveragePts =
    i.bandCoveragePct == null ? 0 : clamp((1 - (Math.abs(i.bandCoveragePct - 80) - 5) / 20) * 20, 0, 20);
  const stabilityPts =
    i.stabilityDelta == null ? 0 : clamp((1 - (i.stabilityDelta - 0.005) / 0.025) * 10, 0, 10);

  if (brierSkill <= 0) reasons.push(`Brier ${i.brier.toFixed(4)} ⇒ skill ${brierSkill.toFixed(4)} ≤ 0 — no measured edge over a constant 50% forecast.`);
  reasons.push(
    `${i.rawSamples} raw matured predictions ≈ ${effN} independent observation${effN === 1 ? "" : "s"} after ${i.overlapDays}-day overlap adjustment.`
  );
  if (i.bandCoveragePct != null) reasons.push(`Measured 80%-band coverage ${i.bandCoveragePct.toFixed(1)}%.`);
  if (i.stabilityDelta == null) reasons.push("Model stability unmeasured (needs two evaluation windows).");

  const score = round1(clamp(skillPts + samplePts + coveragePts + stabilityPts, 0, 100));
  const contributions = [
    { factor: "calibration (Brier skill)", earned: round1(skillPts), max: 40, shortfall: round1(skillPts - 40), detail: `Brier skill ${brierSkill.toFixed(4)} (full credit at ≥0.05)` },
    { factor: "effective sample size", earned: round1(samplePts), max: 30, shortfall: round1(samplePts - 30), detail: `~${effN} independent obs after ${i.overlapDays}d overlap adjustment (full at 100)` },
    { factor: "band coverage", earned: round1(coveragePts), max: 20, shortfall: round1(coveragePts - 20), detail: i.bandCoveragePct != null ? `80%-band coverage ${i.bandCoveragePct.toFixed(1)}% (nominal 80%)` : "coverage unmeasured" },
    { factor: "model stability", earned: round1(stabilityPts), max: 10, shortfall: round1(stabilityPts - 10), detail: i.stabilityDelta != null ? `stability delta ${i.stabilityDelta}` : "unmeasured — needs two evaluation windows" },
  ];
  return {
    score,
    band: score < 40 ? "LOW" : score < 65 ? "MEDIUM" : "HIGH",
    brierSkill,
    effectiveSamples: effN,
    reasons,
    contributions,
  };
}

// ── the assembled card ───────────────────────────────────────────────────────

export interface ScoreCard {
  version: string;
  /** The old "conviction"/quant composite — a technical SETUP description. */
  setupScore: number | null;
  technicalScore: number | null; // alias of setup (one formula, stated)
  momentumScore: number | null;
  valuationScore: number | null; // framework phase 5; null ≠ neutral
  fundamentalScore: number | null; // framework phase 4
  businessQualityScore: number | null; // filings-based intelligence quality
  entryTimingScore: number | null; // entry-quality v2
  risk: RiskScore;
  dataQuality: DataQualityScore;
  forecastConfidence: ForecastConfidence;
  /** Descriptive blend, hard-capped by evidence — NEVER a probability. */
  overallOpportunityScore: number | null;
  caption: string;
}

export interface ScoreCardInputs {
  setupScore: number | null;
  momentumScore: number | null;
  valuationScore: number | null;
  fundamentalScore: number | null;
  businessQualityScore: number | null;
  entryTimingScore: number | null;
  risk: RiskInputs;
  dataQuality: DataQualityInputs;
  forecastConfidence: ForecastConfidenceInputs;
}

const CAPTION =
  "Setup/technical/momentum scores describe the current chart, not the future. " +
  "Model confidence comes from measured out-of-sample performance only — not the setup score. " +
  "No score on this card is a probability.";

export function buildScoreCard(i: ScoreCardInputs): ScoreCard {
  const risk = computeRiskScore(i.risk);
  const dataQuality = computeDataQualityScore(i.dataQuality);
  const forecastConfidence = computeForecastConfidence(i.forecastConfidence);

  // Opportunity: mean of available descriptive scores, then hard caps — it can
  // never exceed what the evidence supports (Rule 1 + Rule 2 in one number).
  const descriptive = [i.setupScore, i.valuationScore, i.fundamentalScore, i.businessQualityScore, i.entryTimingScore]
    .filter((x): x is number => x != null);
  let opportunity: number | null = null;
  if (descriptive.length >= 2) {
    const blend = descriptive.reduce((a, b) => a + b, 0) / descriptive.length;
    opportunity = round1(
      Math.min(
        blend,
        40 + forecastConfidence.score, // LOW-confidence forecasts cap opportunity ≤ ~40-79
        dataQuality.score + 20, // poor data caps opportunity
        risk.score != null ? 140 - risk.score : blend // extreme risk drags it down
      )
    );
    opportunity = clamp(opportunity, 0, 100);
  }

  return {
    version: SCORECARD_VERSION,
    setupScore: i.setupScore,
    technicalScore: i.setupScore,
    momentumScore: i.momentumScore,
    valuationScore: i.valuationScore,
    fundamentalScore: i.fundamentalScore,
    businessQualityScore: i.businessQualityScore,
    entryTimingScore: i.entryTimingScore,
    risk,
    dataQuality,
    forecastConfidence,
    overallOpportunityScore: opportunity,
    caption: CAPTION,
  };
}
