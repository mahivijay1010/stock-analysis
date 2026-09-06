/**
 * Holding-horizon suitability policy v1 (spec §9) — PURE and unit-testable.
 *
 * Answers "is this stock's RISK CHARACTER suited to a short, moderate or long
 * holding period?" from measured inputs only:
 *   - annualized volatility (1y of real daily returns),
 *   - maximum drawdown over the same year,
 *   - the stored fundamentals quality score (0–100, from official filings)
 *     when one exists — spec §9: long-term suitability requires a separate
 *     fundamentals assessment, so LONG is unreachable without that evidence.
 *
 * This is a risk-character classification, NOT a return forecast: it never
 * claims the stock will go up over any horizon. Thresholds are versioned;
 * changing them is a new policy version.
 */

export const HORIZON_POLICY_VERSION = "horizon-policy-v1";

export const HORIZON_THRESHOLDS = {
  minBars: 200, // ~10 months of sessions — less cannot characterize a year of risk
  longMaxVolPct: 28, // calm enough to sit through
  longMaxDrawdownPct: 30,
  longMinQuality: 55, // fundamentals evidence gate for LONG (spec §9)
  moderateMaxVolPct: 45,
  moderateMaxDrawdownPct: 45,
} as const;

export type HorizonLabel = "short" | "moderate" | "long";

export interface HorizonInputs {
  ticker: string;
  barCount: number;
  annualizedVolPct: number | null;
  /** Max peak-to-trough drawdown over the input year, positive % (e.g. 32.5). */
  maxDrawdownPct: number | null;
  /** Stored intelligence quality 0–100, or null when no filings evidence exists. */
  qualityScore: number | null;
}

export interface HorizonSuitability {
  label: HorizonLabel | null; // null = insufficient evidence
  evidenceStatus: "PARTIAL" | "INSUFFICIENT";
  reasons: string[];
  version: string;
  basis: {
    barCount: number;
    annualizedVolPct: number | null;
    maxDrawdownPct: number | null;
    qualityScore: number | null;
  };
}

const CAVEAT =
  "Risk-character classification, not a return promise — no horizon makes an unvalidated forecast safe.";

export function assessHorizonSuitability(inputs: HorizonInputs): HorizonSuitability {
  const T = HORIZON_THRESHOLDS;
  const { barCount, annualizedVolPct: vol, maxDrawdownPct: dd, qualityScore: q } = inputs;
  const basis = { barCount, annualizedVolPct: vol, maxDrawdownPct: dd, qualityScore: q };

  if (barCount < T.minBars || vol == null || dd == null) {
    return {
      label: null,
      evidenceStatus: "INSUFFICIENT",
      version: HORIZON_POLICY_VERSION,
      basis,
      reasons: [
        `Not enough history to characterize risk (${barCount} sessions; ${T.minBars} needed with usable volatility/drawdown).`,
      ],
    };
  }

  const volStr = `${vol.toFixed(0)}% annualized volatility`;
  const ddStr = `${dd.toFixed(0)}% max drawdown (1y)`;

  if (vol <= T.longMaxVolPct && dd <= T.longMaxDrawdownPct) {
    if (q != null && q >= T.longMinQuality) {
      return {
        label: "long",
        evidenceStatus: "PARTIAL",
        version: HORIZON_POLICY_VERSION,
        basis,
        reasons: [
          `Calm risk character (${volStr}, ${ddStr}) AND fundamentals evidence present (quality ${q.toFixed(0)}/100 from official filings) — suitable to consider holding beyond a year.`,
          CAVEAT,
        ],
      };
    }
    return {
      label: "moderate",
      evidenceStatus: "PARTIAL",
      version: HORIZON_POLICY_VERSION,
      basis,
      reasons: [
        `Calm risk character (${volStr}, ${ddStr}), but ${
          q == null
            ? "no stored fundamentals evidence exists yet"
            : `fundamentals quality is only ${q.toFixed(0)}/100`
        } — long-term suitability needs that separate evidence (spec §9), so the supported label is moderate (31–365 days) with periodic review.`,
        CAVEAT,
      ],
    };
  }

  if (vol <= T.moderateMaxVolPct && dd <= T.moderateMaxDrawdownPct) {
    return {
      label: "moderate",
      evidenceStatus: "PARTIAL",
      version: HORIZON_POLICY_VERSION,
      basis,
      reasons: [
        `Middling risk character (${volStr}, ${ddStr}) — a moderate horizon (31–365 days) with periodic review fits; drawdowns this size take time to recover.`,
        CAVEAT,
      ],
    };
  }

  return {
    label: "short",
    evidenceStatus: "PARTIAL",
    version: HORIZON_POLICY_VERSION,
    basis,
    reasons: [
      `High risk character (${volStr}, ${ddStr}) — suitable only for short, actively monitored holdings (≤30 days); sizing down beats hoping a volatile position calms.`,
      CAVEAT,
    ],
  };
}

/** Max peak-to-trough drawdown of a close series, as a POSITIVE percent. */
export function maxDrawdownPct(closes: number[]): number | null {
  if (closes.length < 2) return null;
  let peak = closes[0];
  let worst = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    else if (peak > 0) worst = Math.max(worst, (peak - c) / peak);
  }
  return Math.round(worst * 10_000) / 100;
}

/** Annualized volatility % from daily returns (√252 scaling). */
export function annualizedVolPct(dailyReturns: number[]): number | null {
  const usable = dailyReturns.filter((r) => Number.isFinite(r));
  if (usable.length < 30) return null;
  const mean = usable.reduce((a, b) => a + b, 0) / usable.length;
  const variance = usable.reduce((a, b) => a + (b - mean) ** 2, 0) / (usable.length - 1);
  return Math.round(Math.sqrt(variance) * Math.sqrt(252) * 10_000) / 100;
}
