/**
 * Gates + ShortTermRankingService (S7) — hard gates first, then a
 * risk-adjusted ranking objective. UP TO five; candidate #5 passes the same
 * gates as #1 or it does not appear. Zero qualified is a valid, displayed
 * outcome.
 */

import { ShortTermFeatures } from "./features";
import { SetupClassification } from "./setups";
import { GateResult, ShortTermForecast, TradePlan } from "./types";

export const GATE_THRESHOLDS = {
  minAdvInrDefault: 20_000_000, // ₹2 crore/day default liquidity floor (AUTO)
  maxZeroVolumeBars20: 1,
  maxBarAgeDays: 4,
  minSetupScore: 45,
  minRewardRisk1: 1.2,
  minEvAfterCostsPct: 0.25,
  maxAtrPct: 6,
  maxSlippagePct: 0.6,
} as const;

export function evaluateGates(opts: {
  features: ShortTermFeatures;
  setup: SetupClassification;
  plan: TradePlan;
  forecast: ShortTermForecast;
  barAgeDays: number;
  dataQuality: number;
  modelHealthState: string | null;
  minAdvInr: number | null;
  riskAllowed: boolean;
}): GateResult {
  const T = GATE_THRESHOLDS;
  const failures: GateResult["failures"] = [];
  const fail = (gate: string, current: string, required: string) => failures.push({ gate, current, required });

  if (opts.barAgeDays > T.maxBarAgeDays) fail("data freshness", `last completed bar ${opts.barAgeDays}d old`, `≤${T.maxBarAgeDays}d`);
  if (opts.dataQuality < 60) fail("market data quality", `${opts.dataQuality}`, "≥60");
  const advFloor = opts.minAdvInr ?? T.minAdvInrDefault;
  if (opts.features.advInr20 == null || opts.features.advInr20 < advFloor)
    fail("liquidity", `ADV ₹${Math.round((opts.features.advInr20 ?? 0) / 1e6)}M`, `≥₹${Math.round(advFloor / 1e6)}M/day`);
  if (opts.features.zeroVolumeBars20 > T.maxZeroVolumeBars20)
    fail("liquidity", `${opts.features.zeroVolumeBars20} zero-volume bars in 20`, `≤${T.maxZeroVolumeBars20}`);
  if (opts.modelHealthState === "SUSPENDED") fail("model health", "SUSPENDED", "not SUSPENDED (a suspended model may not support entries)");
  if (["NO_SETUP", "LATE_TREND", "FAILED_BREAKOUT", "HIGH_EVENT_RISK"].includes(opts.setup.setupType))
    fail("setup", opts.setup.setupType, "a constructive setup type");
  if (opts.setup.setupScore < T.minSetupScore) fail("setup strength", `${opts.setup.setupScore}`, `≥${T.minSetupScore}`);
  if (opts.plan.entryType === "NONE") fail("entry plan", "none derivable", "a structural entry with stop and targets");
  if (opts.plan.rewardRiskToTarget1 != null && opts.plan.rewardRiskToTarget1 < T.minRewardRisk1)
    fail("reward/risk", `${opts.plan.rewardRiskToTarget1} to T1`, `≥${T.minRewardRisk1} (stop is structural, never tightened to pass)`);
  if (opts.plan.expectedValueAfterCostsPct == null || opts.plan.expectedValueAfterCostsPct < T.minEvAfterCostsPct)
    fail("expected value", `${opts.plan.expectedValueAfterCostsPct ?? "n/a"}% after costs`, `≥${T.minEvAfterCostsPct}%`);
  if ((opts.features.atrPct ?? 99) > T.maxAtrPct) fail("volatility", `ATR ${opts.features.atrPct?.toFixed(1)}%`, `≤${T.maxAtrPct}% (extreme vol makes stops unreliable)`);
  if (opts.plan.estimatedSlippagePct > T.maxSlippagePct)
    fail("slippage", `${opts.plan.estimatedSlippagePct}%`, `≤${T.maxSlippagePct}%`);
  if (!opts.riskAllowed) fail("portfolio risk", "limit reached", "risk manager must allow new entries");

  return { passed: failures.length === 0, failures };
}

/**
 * Ranking objective for PASSING candidates only: risk-adjusted EV with
 * explicit penalties. Descriptive weights, versioned; not a probability.
 */
export function rankingScore(opts: {
  features: ShortTermFeatures;
  setup: SetupClassification;
  plan: TradePlan;
  forecast: ShortTermForecast;
  entryQuality: number | null;
  aiDisagreement: number | null;
}): number {
  const ev = opts.plan.expectedValueAfterCostsPct ?? 0;
  const excess = opts.forecast.expectedExcessReturnPct ?? 0;
  const rr = Math.min(3, opts.plan.rewardRiskToTarget1 ?? 0);
  const eq = (opts.entryQuality ?? 50) / 100;
  const liq = Math.min(1, (opts.features.advInr20 ?? 0) / 100_000_000);

  let score = ev * 8 + excess * 3 + rr * 6 + eq * 10 + liq * 4 + opts.setup.setupScore / 10;
  // Penalties.
  score -= opts.plan.estimatedSlippagePct * 10;
  if ((opts.features.atrPct ?? 0) > 4) score -= ((opts.features.atrPct ?? 0) - 4) * 3;
  if ((opts.features.relVolume ?? 1) < 0.7) score -= 3;
  if (opts.aiDisagreement != null) score -= opts.aiDisagreement / 20;
  return Math.round(score * 100) / 100;
}
