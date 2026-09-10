/**
 * Module V2-C — TradePlan (owner's Phase 8 risk rules) and the amount-aware
 * InvestmentPlan. Pure composition helpers: every number comes from real
 * quotes/bars/quant output — nothing is fabricated.
 *
 * Owner's rules implemented exactly:
 *  - Stop-loss: max(2×ATR14, 5% below entry for bluechips / 7.5% when
 *    annualised volatility > 30%).
 *  - Target: entry + 3 × (entry − stopLoss) — the 3:1 reward:risk rule.
 *  - Plausibility clamp: the target move must fit inside +2.5σ√21 trading
 *    days; if not, meetsRewardRisk = false with an honest note.
 *  - Position sizing: risk at most 2% of the portfolio at the stop.
 */

import {
  HorizonPrediction,
  InvestmentPlan,
  ProjectionRow,
  TradePlan,
} from "../../types";
import { buildProjections } from "../quant/engine";
import { estimateBuyFees, estimateRoundTripFees } from "./fees";

const REWARD_RISK_RATIO = 3.0;
const HIGH_VOL_THRESHOLD_PCT = 30; // annualised vol above this → 7.5% stop tier
const BLUECHIP_STOP_PCT = 0.05;
const HIGH_VOL_STOP_PCT = 0.075;
const PLAUSIBILITY_SIGMAS = 2.5;
const PLAUSIBILITY_TRADING_DAYS = 21;
const RISK_BUDGET_PCT = 0.02; // owner's 2% rule

function round2(x: number): number {
  const r = Math.round(x * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

const inr = (x: number): string =>
  `₹${x.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface TradePlanInput {
  entry: number; // current price
  atr14: number | null;
  annualVolatilityPct: number | null;
  recommendation: "BUY" | "HOLD" | "AVOID";
  /**
   * Optional probabilistic upper bound for the same holding period. When
   * present, an executable target may not sit above it. This keeps the
   * deterministic reward:risk geometry aligned with the forecast tab.
   */
  forecastConstraint?: {
    horizonDays: number;
    upperReturnPct: number;
    label: string;
  } | null;
}

/** ATR/vol-based trade plan. Returns null when the recommendation is AVOID. */
export function buildTradePlan(input: TradePlanInput): TradePlan | null {
  const { entry, atr14, annualVolatilityPct, recommendation, forecastConstraint } = input;
  if (recommendation === "AVOID") return null;
  if (!(entry > 0)) return null;

  const vol = annualVolatilityPct;
  const pctTier = vol !== null && vol > HIGH_VOL_THRESHOLD_PCT ? HIGH_VOL_STOP_PCT : BLUECHIP_STOP_PCT;
  const atrDist = atr14 !== null && atr14 > 0 ? 2 * atr14 : 0;
  const stopDist = Math.max(atrDist, entry * pctTier);
  const stopLoss = entry - stopDist;
  const stopLossPct = (stopDist / entry) * 100;
  const structuralTargetDist = REWARD_RISK_RATIO * stopDist;
  const structuralTarget = entry + structuralTargetDist;
  const validForecastCeiling =
    forecastConstraint &&
    Number.isFinite(forecastConstraint.upperReturnPct) &&
    forecastConstraint.upperReturnPct > 0
      ? entry * (1 + forecastConstraint.upperReturnPct / 100)
      : null;
  const target =
    validForecastCeiling !== null
      ? Math.min(structuralTarget, validForecastCeiling)
      : structuralTarget;
  const targetDist = target - entry;
  const targetPct = (targetDist / entry) * 100;
  const rewardRiskRatio = stopDist > 0 ? targetDist / stopDist : 0;
  const forecastCapped = target < structuralTarget - 0.005;

  // Plausibility: target must fit inside +2.5σ over ~21 trading days (1 month).
  let meetsRewardRisk = rewardRiskRatio >= REWARD_RISK_RATIO - 0.005;
  let plausibilityNote = "";
  if (vol !== null && vol > 0) {
    const sigmaDaily = vol / 100 / Math.sqrt(252);
    const maxPlausiblePct =
      PLAUSIBILITY_SIGMAS * sigmaDaily * Math.sqrt(PLAUSIBILITY_TRADING_DAYS) * 100;
    if (targetPct > maxPlausiblePct) {
      meetsRewardRisk = false;
      plausibilityNote =
        ` However, the +${targetPct.toFixed(1)}% target exceeds the +${maxPlausiblePct.toFixed(1)}% ` +
        `plausibility clamp (+2.5σ over ~21 trading days at ${vol.toFixed(1)}% annualised vol), ` +
        `so a full 3:1 payoff is statistically unlikely within a month — meetsRewardRisk = false.`;
    } else {
      plausibilityNote =
        ` The target fits inside the +${maxPlausiblePct.toFixed(1)}% one-month plausibility clamp (+2.5σ√21d).`;
    }
  } else {
    meetsRewardRisk = false;
    plausibilityNote = " Volatility unavailable — plausibility could not be verified.";
  }

  const stopBasis =
    atrDist >= entry * pctTier
      ? `2×ATR14 (${inr(atrDist)})`
      : `${(pctTier * 100).toFixed(1)}% ${pctTier === BLUECHIP_STOP_PCT ? "bluechip" : "high-volatility"} floor`;

  const targetBasis = forecastCapped && forecastConstraint
    ? ` The raw 3:1 target was ${inr(structuralTarget)}, but the executable target was capped at ` +
      `${inr(target)} by ${forecastConstraint.label} (${forecastConstraint.horizonDays}-day upper return ` +
      `${forecastConstraint.upperReturnPct.toFixed(1)}%). The resulting reward:risk is ` +
      `${rewardRiskRatio.toFixed(2)}:1, so this is not a qualifying 3:1 trade.`
    : ` Target ${inr(target)} preserves the 3:1 reward:risk geometry.`;

  return {
    entry: round2(entry),
    stopLoss: round2(stopLoss),
    stopLossPct: round2(stopLossPct),
    target: round2(target),
    targetPct: round2(targetPct),
    rewardRiskRatio: round2(rewardRiskRatio),
    meetsRewardRisk,
    note:
      `Stop ${inr(stopLoss)} (−${stopLossPct.toFixed(1)}%) set by ${stopBasis}; ` +
      `target ${inr(target)} (+${targetPct.toFixed(1)}%).` +
      targetBasis +
      plausibilityNote,
  };
}

export interface InvestmentPlanInput {
  amount: number;
  price: number; // current price
  ticker: string;
  tradePlan: TradePlan | null;
  predictions: HorizonPrediction[];
  recommendation: "BUY" | "HOLD" | "AVOID";
}

/** Amount-aware plan: shares, fees, 2%-rule sizing, projections, warnings. */
export function buildInvestmentPlan(input: InvestmentPlanInput): InvestmentPlan {
  const { amount, price, ticker, tradePlan, predictions, recommendation } = input;
  const warnings: string[] = [];

  // Shares affordable at this amount (ensure buy fees still fit in `amount`).
  let shares = price > 0 ? Math.floor(amount / price) : 0;
  while (shares > 0 && shares * price + estimateBuyFees(shares * price) > amount) {
    shares -= 1;
  }
  const invested = round2(shares * price);
  const cashLeft = round2(amount - invested);

  if (shares === 0) {
    warnings.push(
      `shares = 0 — ${ticker} trades at ${inr(price)}, which exceeds what ${inr(amount)} can buy ` +
        `(1 share + fees). Increase the amount or pick a lower-priced stock.`
    );
  }

  // Fees on the actual position turnover.
  const fees = estimateRoundTripFees(invested);
  if (invested > 0 && fees.roundTripPct > 0.5) {
    warnings.push(
      `Estimated round-trip fees ${inr(fees.roundTrip)} are ${fees.roundTripPct.toFixed(2)}% of this ` +
        `position — positions this small are fee-inefficient (fees eat into any gain).`
    );
  }

  // Stop/target economics for the actual share count.
  let maxLossAtStop = 0;
  let gainAtTarget = 0;
  if (tradePlan) {
    maxLossAtStop = round2(shares * (tradePlan.entry - tradePlan.stopLoss));
    gainAtTarget = round2(shares * (tradePlan.target - tradePlan.entry));
    if (!tradePlan.meetsRewardRisk) {
      warnings.push(
        `The 3:1 target ${inr(tradePlan.target)} failed the one-month plausibility check — ` +
          `treat gainAtTarget as an optimistic scenario, not an expectation.`
      );
    }
  } else {
    warnings.push(
      recommendation === "AVOID"
        ? "Recommendation is AVOID — no trade plan was generated, so stop/target economics are not computed."
        : "No trade plan available — stop/target economics are not computed."
    );
  }

  // Owner's 2% rule (treats `amount` as the whole portfolio).
  const riskBudget = round2(amount * RISK_BUDGET_PCT);
  let suggestedShares = 0;
  let sizingNote: string;
  if (tradePlan) {
    const stopDist = tradePlan.entry - tradePlan.stopLoss;
    suggestedShares = stopDist > 0 ? Math.floor(riskBudget / stopDist) : 0;
    const affordable = price > 0 ? Math.floor(amount / price) : 0;
    if (suggestedShares > affordable) {
      suggestedShares = affordable;
      sizingNote =
        `2% rule: risking at most ${inr(riskBudget)} at the stop allows more shares than ` +
        `${inr(amount)} can buy — capital, not risk, is the constraint here (capped at ${affordable} shares).`;
    } else {
      sizingNote =
        `2% rule: if ${inr(amount)} is your whole portfolio, risk at most ${inr(riskBudget)} at the stop ` +
        `(${inr(stopDist)}/share) → ${suggestedShares} share${suggestedShares === 1 ? "" : "s"}.`;
    }
    if (suggestedShares === 0) {
      sizingNote += " 0 shares fit that risk budget — this position is too large for a 2%-risk portfolio.";
    }
  } else {
    sizingNote = "2% rule needs a stop-loss; no trade plan was generated for this stock.";
  }
  const suggestedInvestment = round2(suggestedShares * price);

  // Projections for the EXACT amount (reuse the quant engine's builder).
  const projections: ProjectionRow = buildProjections(price, predictions, [amount])[0];

  return {
    amount,
    shares,
    invested,
    cashLeft,
    maxLossAtStop,
    gainAtTarget,
    positionSizing2pct: {
      riskBudget,
      suggestedShares,
      suggestedInvestment,
      note: sizingNote,
    },
    estimatedFees: {
      perSide: fees.perSide,
      roundTrip: fees.roundTrip,
      roundTripPct: fees.roundTripPct,
      note: fees.note,
    },
    projections,
    warnings,
  };
}
