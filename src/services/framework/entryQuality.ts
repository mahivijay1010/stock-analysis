/**
 * Entry-quality model v2 (risk-spec Rule 7; remediation plan S5) — PURE.
 *
 * "A strong company is not automatically a good stock to BUY TODAY."
 * Starts from the existing measured-signal entry-timing score and applies
 * EXTENSION and QUALITY penalties the v1 heuristic ignored — the exact
 * failure shape of the BHEL case (near 52-week high after a rapid run,
 * high volatility, expensive without growth evidence, wide forecast
 * intervals). Generalizes: nothing here is per-ticker.
 *
 * This layer OWNS NO ACTION VOCABULARY. It outputs a score + label
 * (attractive/neutral/unattractive) + reasons; only the TradeGate
 * (decision policy) can emit anything BUY-flavored. It also supports the
 * split verdict "LONG-TERM POSITIVE but ENTRY UNATTRACTIVE" by being
 * independent of the business-quality axis.
 */

import { QuantAnalysis } from "../quant/types";
import { Fundamentals } from "../market/types";

export const ENTRY_QUALITY_VERSION = "entry-quality-v2";

export interface EntryQualityInputs {
  /** The v1 entry-timing score (base 50 + measured deltas), or null. */
  baseTimingScore: number | null;
  price: number;
  technicals: QuantAnalysis["technicals"];
  fundamentals: Fundamentals | null;
  /** Terminal-horizon 80% interval width as % of anchor, from the stored issuance. */
  intervalWidthPct30: number | null;
  /** (p90−anchor)/(anchor−p10) from the stored issuance, null when undefined. */
  rewardRiskRatio: number | null;
}

export interface EntryQuality {
  version: string;
  score: number | null; // 0-100; null when no base score AND no technicals
  label: "attractive" | "neutral" | "unattractive" | "unknown";
  adjustments: Array<{ delta: number; reason: string }>;
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

export function assessEntryQuality(i: EntryQualityInputs): EntryQuality {
  const t = i.technicals;
  const adjustments: Array<{ delta: number; reason: string }> = [];
  const add = (delta: number, reason: string) => adjustments.push({ delta, reason });

  if (i.baseTimingScore == null && (t.sma50 == null || t.atr14 == null)) {
    return { version: ENTRY_QUALITY_VERSION, score: null, label: "unknown", adjustments: [] };
  }
  const base = i.baseTimingScore ?? 50;

  // 1. Extension above moving averages, in ATR units (audit: v1 never checked this).
  if (t.sma50 != null && t.atr14 != null && t.atr14 > 0) {
    const atrAbove50 = (i.price - t.sma50) / t.atr14;
    if (atrAbove50 > 8) add(-18, `price is ${atrAbove50.toFixed(1)} ATRs above the 50-day average — severely extended`);
    else if (atrAbove50 > 4) add(-10, `price is ${atrAbove50.toFixed(1)} ATRs above the 50-day average — extended`);
  }
  if (t.sma200 != null && t.sma200 > 0) {
    const pctAbove200 = ((i.price - t.sma200) / t.sma200) * 100;
    if (pctAbove200 > 40) add(-10, `price is ${pctAbove200.toFixed(0)}% above the 200-day average`);
    else if (pctAbove200 > 25) add(-6, `price is ${pctAbove200.toFixed(0)}% above the 200-day average`);
  }

  // 2. Near the 52-week high after a rapid run (the BHEL shape — generalized).
  const pos = t.week52?.positionPct ?? null;
  const r60 = t.returns.r60dPct ?? null;
  if (pos != null && pos >= 90 && r60 != null && r60 >= 15) {
    add(-12, `at the ${pos.toFixed(0)}th percentile of the 52-week range after a +${r60.toFixed(0)}% 60-day run — chasing strength`);
  }

  // 3. Volatility spike (entering during turbulence).
  if (t.annualVolatilityPct != null && t.annualVolatilityPct > 45) {
    add(-8, `annualized volatility ${t.annualVolatilityPct.toFixed(0)}% — sizing/stop math is unreliable at this turbulence`);
  }

  // 4. Wide forecast intervals ⇒ the model itself says "wide open".
  if (i.intervalWidthPct30 != null && i.intervalWidthPct30 > 18) {
    add(-6, `the stored 30d forecast's 80% interval spans ${i.intervalWidthPct30.toFixed(0)}% of price — high modeled uncertainty`);
  }

  // 5. Weak reward/risk from the same distribution.
  if (i.rewardRiskRatio != null) {
    if (i.rewardRiskRatio < 1) add(-10, `reward/risk ${i.rewardRiskRatio.toFixed(2)} < 1 from the stored forecast distribution`);
    else if (i.rewardRiskRatio >= 1.5) add(+5, `reward/risk ${i.rewardRiskRatio.toFixed(2)} ≥ 1.5 from the stored forecast distribution`);
  }

  // 6. Expensive valuation WITHOUT growth evidence (missing growth ≠ neutral, Rule 11).
  const f = i.fundamentals;
  if (f) {
    const expensive =
      (f.trailingPE != null && f.trailingPE > 45) ||
      (f.pegRatio != null && f.pegRatio > 2.5) ||
      (f.enterpriseToEbitda != null && f.enterpriseToEbitda > 25);
    const growthProven = f.earningsGrowthPct != null && f.earningsGrowthPct >= 12;
    if (expensive && !growthProven) {
      add(
        -10,
        f.earningsGrowthPct == null
          ? "expensive valuation with NO earnings-growth evidence (missing data is not neutral)"
          : `expensive valuation with earnings growth only ${f.earningsGrowthPct.toFixed(0)}%`
      );
    }
  } else {
    add(-4, "no fundamentals available — valuation risk at entry is unobserved");
  }

  // 7. Negative divergence: price strength without volume participation.
  if (t.volumeRatio20d != null && r60 != null && r60 >= 15 && t.volumeRatio20d < 0.7) {
    add(-5, `+${r60.toFixed(0)}% in 60 days on fading volume (${t.volumeRatio20d.toFixed(2)}× the 20d average)`);
  }

  const score = Math.round(clamp(base + adjustments.reduce((s, a) => s + a.delta, 0), 0, 100) * 10) / 10;
  const label = score >= 60 ? "attractive" : score >= 40 ? "neutral" : "unattractive";
  return { version: ENTRY_QUALITY_VERSION, score, label, adjustments };
}
