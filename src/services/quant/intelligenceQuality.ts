/**
 * V10 B1 — intelligenceQualityScore: PURE (no DB, no HTTP) quality score from
 * STORED Intelligence Engine metrics (NSE XBRL filings), for the rank quality
 * pillar.
 *
 * Five sub-signals, each scored 0..1, EQUAL weights renormalized over the
 * inputs that actually exist (a missing metric shrinks the denominator — it
 * never silently counts as 0):
 *
 *   roic          ROIC ≥ 15%            → 1 else 0   (the owner-earnings bar)
 *   fcf           FCF > 0               → 1 else 0
 *   fcf-margin    FCF/revenue level     → clamp(margin% / 20, 0, 1) (graded)
 *   current-ratio CR ≥ 1                → 1 else 0   (EXCLUDED for banks —
 *                 a bank balance sheet has no meaningful current ratio, so it
 *                 is skipped entirely, not treated as missing data)
 *   peg           0 < PEG < 1.5         → 1 else 0   (historical-growth PEG)
 *
 * score = round(100 × Σ sᵢ / n) over the n available signals.
 * Returns null when fewer than MIN_INPUTS (=2) signals are available — one
 * metric is not a quality picture, and pretending otherwise would fabricate
 * precision. `coverage` lists exactly which signals fed the score.
 */

export const QUALITY_MIN_INPUTS = 2;
/** FCF margin (%) at or above this level earns the full graded sub-score. */
export const FCF_MARGIN_FULL_SCORE_PCT = 20;
export const ROIC_PASS_PCT = 15;
export const CURRENT_RATIO_PASS = 1;
export const PEG_PASS_MAX = 1.5;

export interface IntelligenceQualityInputs {
  /** ROIC % (NOPAT / average invested capital). Null when not stored/valid. */
  roic: number | null;
  /** Latest annual free cash flow, ₹ (CFO − |CapEx|). */
  fcf: number | null;
  /** Latest annual revenue, ₹ — enables the graded FCF-margin signal. */
  revenue: number | null;
  /** Current ratio (current assets / current liabilities). */
  currentRatio: number | null;
  /**
   * True when the stored current_ratio row is BANK_NOT_MEANINGFUL — the CR
   * signal is then EXCLUDED from the score (bank-aware), not "missing".
   */
  currentRatioNotMeaningful?: boolean;
  /** PEG (trailing PE / historical EPS growth). */
  peg: number | null;
}

export interface IntelligenceQualityScore {
  /** 0..100 — weighted (renormalized) mean of the available sub-signals. */
  score: number;
  /** Names of the sub-signals that fed the score (honest provenance). */
  coverage: string[];
}

const finite = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/**
 * Compute the 0..100 quality score, or null when <2 sub-signals exist.
 * Pure and deterministic — the caller supplies stored values only.
 */
export function intelligenceQualityScore(
  m: IntelligenceQualityInputs
): IntelligenceQualityScore | null {
  const signals: Array<{ name: string; score: number }> = [];

  if (finite(m.roic)) {
    signals.push({ name: "roic", score: m.roic >= ROIC_PASS_PCT ? 1 : 0 });
  }
  if (finite(m.fcf)) {
    signals.push({ name: "fcf", score: m.fcf > 0 ? 1 : 0 });
    if (finite(m.revenue) && m.revenue > 0) {
      const marginPct = (m.fcf / m.revenue) * 100;
      signals.push({
        name: "fcf-margin",
        score: clamp01(marginPct / FCF_MARGIN_FULL_SCORE_PCT),
      });
    }
  }
  if (finite(m.currentRatio) && !m.currentRatioNotMeaningful) {
    signals.push({
      name: "current-ratio",
      score: m.currentRatio >= CURRENT_RATIO_PASS ? 1 : 0,
    });
  }
  if (finite(m.peg)) {
    signals.push({ name: "peg", score: m.peg > 0 && m.peg < PEG_PASS_MAX ? 1 : 0 });
  }

  if (signals.length < QUALITY_MIN_INPUTS) return null;

  const total = signals.reduce((s, x) => s + x.score, 0);
  return {
    score: Math.round((total / signals.length) * 100),
    coverage: signals.map((s) => s.name),
  };
}
