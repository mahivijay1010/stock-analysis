/**
 * Expected value after costs (risk-spec Rule 8; remediation plan S6) — PURE.
 *
 * Computed from the STORED immutable forecast issuance's distribution (the
 * same one every other surface shows — never a second model, per
 * upgrade-spec §5) plus the delivery fee model. All probability-flavored
 * inputs here are HISTORICAL BOOTSTRAP SCENARIO FREQUENCIES (Rule 10), and
 * the outputs say so: a positive EV from an uncalibrated distribution is a
 * necessary condition for BUY, never a sufficient one.
 *
 * A probability above 50% does NOT justify BUY: the gate consumes
 * evAfterCostsPct ≤ 0 as a WATCH veto (plan S2).
 */

import { estimateRoundTripFees } from "../framework/fees";

export const EV_VERSION = "expected-value-v1";

/** Notional used to convert flat fee components into a % (documented, not hidden). */
export const EV_NOTIONAL_INR = 25_000;

/** Slippage haircut per side, % of turnover — conservative small-order estimate. */
export const SLIPPAGE_PCT_PER_SIDE = 0.05;

export interface EvInputs {
  anchorPrice: number;
  /** Terminal-horizon quantile PRICES from the stored issuance. */
  p05: number;
  p10: number;
  p50: number;
  p90: number;
  p95: number;
  /** Genuine sample mean price when the engine computed one (issuances store it). */
  meanPrice: number | null;
  /** Scenario frequency of any gain at the terminal horizon (0..1), or null. */
  pop: number | null;
  horizonDays: number;
}

export interface ExpectedValueReport {
  version: string;
  horizonDays: number;
  /** Mean scenario return % (from the genuine sample mean; falls back to a quantile blend). */
  expectedReturnPct: number;
  expectedUpsidePct: number; // p90 vs anchor
  expectedDownsidePct: number; // p10 vs anchor (negative when below)
  /** Scenario frequencies, NOT calibrated probabilities — labeled. */
  scenarioFrequencyUp: number | null;
  scenarioFrequencyDown: number | null;
  transactionCostPct: number; // round trip incl. slippage, % of notional
  evAfterCostsPct: number; // expectedReturnPct − transactionCostPct
  /** Approximate 10% expected shortfall: mean of the worst decile ≈ (p05+p10)/2. */
  expectedShortfallPct: number;
  rewardRiskRatio: number | null; // (p90−anchor)/(anchor−p10); null if downside ≤ 0
  notionalInr: number;
  notes: string[];
}

const round2 = (x: number): number => {
  const r = Math.round(x * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
};

export function computeExpectedValue(i: EvInputs): ExpectedValueReport {
  if (!(i.anchorPrice > 0)) throw new Error("computeExpectedValue: anchorPrice must be > 0");
  const ret = (p: number): number => ((p - i.anchorPrice) / i.anchorPrice) * 100;

  // Mean: prefer the genuine stored sample mean; otherwise a documented
  // quantile blend (Pearson-Tukey weights) — stated in notes, never silent.
  const notes: string[] = [];
  let expectedReturnPct: number;
  if (i.meanPrice != null && Number.isFinite(i.meanPrice)) {
    expectedReturnPct = ret(i.meanPrice);
  } else {
    expectedReturnPct = 0.185 * ret(i.p05) + 0.63 * ret(i.p50) + 0.185 * ret(i.p95);
    notes.push("Mean approximated from quantiles (Pearson–Tukey 0.185/0.63/0.185) — no stored sample mean.");
  }

  const fees = estimateRoundTripFees(EV_NOTIONAL_INR);
  const transactionCostPct = round2(fees.roundTripPct + 2 * SLIPPAGE_PCT_PER_SIDE);
  const evAfterCostsPct = round2(expectedReturnPct - transactionCostPct);

  const upside = ret(i.p90);
  const downside = ret(i.p10);
  const rewardRiskRatio =
    downside < 0 ? round2((i.p90 - i.anchorPrice) / (i.anchorPrice - i.p10)) : null;
  if (rewardRiskRatio == null) {
    notes.push("Reward/risk undefined: p10 is not below the anchor (distribution skewed above entry).");
  }

  notes.push(
    `Scenario frequencies come from the stored bootstrap issuance — historical resampling, ` +
      `NOT calibrated probabilities. Costs: ${fees.roundTripPct.toFixed(2)}% fees + ` +
      `${(2 * SLIPPAGE_PCT_PER_SIDE).toFixed(2)}% slippage on a ₹${EV_NOTIONAL_INR.toLocaleString("en-IN")} notional.`
  );

  return {
    version: EV_VERSION,
    horizonDays: i.horizonDays,
    expectedReturnPct: round2(expectedReturnPct),
    expectedUpsidePct: round2(upside),
    expectedDownsidePct: round2(downside),
    scenarioFrequencyUp: i.pop,
    scenarioFrequencyDown: i.pop != null ? round2(1 - i.pop) : null,
    transactionCostPct,
    evAfterCostsPct,
    expectedShortfallPct: round2((ret(i.p05) + ret(i.p10)) / 2),
    rewardRiskRatio,
    notionalInr: EV_NOTIONAL_INR,
    notes,
  };
}
