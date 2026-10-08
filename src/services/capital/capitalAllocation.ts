/**
 * Pure capital-allocation engine (no I/O). Consumes the short-term engine's
 * persisted candidate views, the user's holdings, the market regime, the
 * circuit breaker and a risk profile; emits ALLOCATE / WATCH / rejected lists,
 * the cash position and a labelled SCENARIO. It reuses:
 *   - computePositionSize   (risk-based sizing, costs+slippage+gap inside)
 *   - regimeGateFor / setupAllowedInRegime
 *   - the engine's own qualification flags (qualified, tier, action, EV80 lower)
 * It never invents a price, level, probability or expected return.
 */

import { computePositionSize } from "../shortterm/sizing";
import { regimeGateFor, setupAllowedInRegime } from "../shortterm/regimeGates";
import { HORIZON_TD, ShortTermHorizon } from "../shortterm/types";
import { macroRiskAdjustment, RiskProfile } from "./riskProfiles";
import {
  CAPITAL_DESK_VERSION,
  CAPITAL_POLICY_VERSION,
  CapitalCandidateInput,
  CapitalHoldingInput,
  CapitalHorizon,
  CapitalPlanResult,
  CashSummary,
  EnvLabel,
  MarketContextInput,
  PlannedAllocation,
  REASON_TEXT,
  ReasonCode,
  RejectedCandidate,
  ScenarioSummary,
  WithdrawalDecision,
} from "./types";
import { decideWithdrawals } from "./capitalWithdrawal";

export interface BuildPlanInput {
  asOf: string;
  capitalAvailableInr: number;
  holdings: CapitalHoldingInput[];
  candidates: CapitalCandidateInput[];
  market: MarketContextInput;
  profile: RiskProfile;
  horizon: CapitalHorizon;
  /** Optional user override of simultaneous positions (clamped to the profile). */
  maxPositions?: number;
}

const r2 = (v: number): number => Math.round(v * 100) / 100;
const TIER_RANK: Record<string, number> = { A: 4, B: 3, C: 2, D: 1 };

function horizonOf(expectedHoldingDays: number): ShortTermHorizon {
  if (expectedHoldingDays <= 3) return "1-3d";
  if (expectedHoldingDays <= 5) return "3-5d";
  if (expectedHoldingDays <= 10) return "5-10d";
  return "10-21d";
}

function horizonCompatible(expectedHoldingDays: number, wanted: CapitalHorizon): boolean {
  const h = horizonOf(expectedHoldingDays);
  if (h === wanted) return true;
  // Allow one bucket of tolerance so a 4-session plan still fits "5-10d".
  const w = HORIZON_TD[wanted];
  return expectedHoldingDays >= Math.max(1, w.min - 2) && expectedHoldingDays <= w.max + 2;
}

function entryPriceOf(c: CapitalCandidateInput): number | null {
  const p = c.plan;
  if (p.entryType === "BREAKOUT_TRIGGER" && p.entryTriggerPrice != null) return p.entryTriggerPrice;
  return p.entryZoneHigh ?? p.entryTriggerPrice ?? c.currentPrice;
}

function geometryValid(entry: number | null, stop: number | null, target: number | null): boolean {
  return entry != null && stop != null && target != null && stop > 0 && stop < entry && target > entry;
}

/** Hard reasons that make a candidate ineligible for both ALLOCATE and WATCH. */
function hardReasons(c: CapitalCandidateInput, profile: RiskProfile, market: MarketContextInput, horizon: CapitalHorizon, held: Set<string>): ReasonCode[] {
  const out: ReasonCode[] = [];
  if (held.has(c.ticker)) out.push("ALREADY_HELD");
  if (c.tradeability && !c.tradeability.tradeable) out.push("NOT_TRADEABLE");
  if (c.freshnessV2 === "STALE" || market.freshness.quoteType === "STALE") out.push("STALE_DATA");
  if (c.modelHealth === "SUSPENDED") out.push("MODEL_HEALTH_INSUFFICIENT");
  if ((TIER_RANK[c.tier] ?? 0) < (TIER_RANK[profile.minEvidenceTier] ?? 4)) out.push("EVIDENCE_TIER_INSUFFICIENT");
  const entry = entryPriceOf(c);
  if (!geometryValid(entry, c.plan.initialStop, c.plan.target1)) out.push("INVALID_GEOMETRY");
  const rr = c.plan.rewardRiskToTarget1;
  if (rr == null || rr < profile.minRewardRisk) out.push("REWARD_RISK_BELOW_MIN");
  if (!c.ev || c.ev.ev80LowerPct == null) out.push("EV_UNAVAILABLE");
  else if (profile.requireEv80LowerPositive && c.ev.ev80LowerPct <= 0) out.push("EV_LOWER_BOUND_NEGATIVE");
  if (!horizonCompatible(c.plan.expectedHoldingDays, horizon)) out.push("HORIZON_MISMATCH");
  const gate = regimeGateFor(market.regime);
  if (gate.sizeMultiplier <= 0) out.push("REGIME_ENTRIES_OFF");
  else if (!setupAllowedInRegime(c.setupType, gate.allowedSetups)) out.push("REGIME_CONFLICT");
  if (!market.breakerCanEnter) out.push("CIRCUIT_BREAKER");
  if (c.aiCapAction === "CAP_TO_NO_TRADE") out.push("AI_CAP_NO_TRADE");
  return out;
}

const WATCHABLE_ACTIONS = new Set(["ZONE_REACHED", "WAIT_FOR_CONFIRMATION", "SETUP_DETECTED", "RESEARCH_WATCH"]);

export function buildCapitalPlan(input: BuildPlanInput): CapitalPlanResult {
  const { profile, market } = input;
  const macro = macroRiskAdjustment(market.global ?? null);
  const maxPositions = Math.max(1, Math.min(profile.maxPositions, Math.round(input.maxPositions ?? profile.maxPositions)) + macro.maxPositionsDelta);
  const gate = regimeGateFor(market.regime);
  const indiaEnv: EnvLabel = market.regime === "CRISIS" ? "STRESS" : market.regime === "TREND_DOWN" || market.regime === "HIGH_VOL" ? "HEADWIND" : market.regime === "TREND_UP" ? "TAILWIND" : "NEUTRAL";
  const globalEnv: EnvLabel = market.global ? market.global.transmission : "NEUTRAL";
  const sectorEnvOf = (sector: string | null): EnvLabel => (sector && market.global?.sectorLabels[sector]) || "NEUTRAL";
  const capitalAvailable = Math.max(0, input.capitalAvailableInr);
  const invested = input.holdings.reduce((s, h) => s + (h.markedValueInr ?? h.investedInr), 0);
  const totalEquity = capitalAvailable + invested;
  const held = new Set(input.holdings.map((h) => h.ticker));

  // ── Existing holdings: HOLD / TRAIL / REDUCE / EXIT (reuses plan levels) ──
  const holdDecisions = decideWithdrawals({ holdings: input.holdings, market, profile, totalEquityInr: totalEquity });
  const holds: WithdrawalDecision[] = holdDecisions.filter((d) => d.action === "HOLD" || d.action === "TRAIL");
  const withdrawals: WithdrawalDecision[] = holdDecisions.filter((d) => d.action === "REDUCE" || d.action === "EXIT");

  // ── Cash and risk budgets ──
  const cashReserve = r2((profile.cashReservePct / 100) * totalEquity);
  let deployable = Math.max(0, capitalAvailable - cashReserve);
  const riskBudget = r2((profile.maxPortfolioRiskPct / 100) * totalEquity);
  // Risk already open in holdings = qty × (price − stop) where a plan stop exists.
  let riskUsed = 0;
  for (const h of input.holdings) {
    const stop = h.evidence?.plan.initialStop ?? null;
    if (h.price != null && stop != null && stop < h.price) riskUsed += h.qty * (h.price - stop);
  }
  riskUsed = r2(riskUsed);
  const openPositions = input.holdings.filter((h) => h.qty > 0).length;
  const sectorInUse = new Map<string, number>();
  for (const h of input.holdings) {
    const s = h.sector ?? "Unclassified";
    sectorInUse.set(s, (sectorInUse.get(s) ?? 0) + (h.markedValueInr ?? h.investedInr));
  }

  const whyCash: string[] = [];
  if (gate.sizeMultiplier <= 0) whyCash.push(REASON_TEXT.REGIME_ENTRIES_OFF);
  if (!market.breakerCanEnter) whyCash.push(REASON_TEXT.CIRCUIT_BREAKER + (market.breakerReason ? ` (${market.breakerReason})` : ""));
  if (market.freshness.quoteType === "STALE") whyCash.push(REASON_TEXT.STALE_DATA);
  if (deployable <= 0 && capitalAvailable > 0) whyCash.push(REASON_TEXT.CASH_RESERVE_BINDING);

  // ── Candidates ──
  const sorted = [...input.candidates].sort((a, b) => {
    const ra = a.rank ?? Number.MAX_SAFE_INTEGER;
    const rb = b.rank ?? Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return (b.evidenceScore ?? b.rankingScore ?? 0) - (a.evidenceScore ?? a.rankingScore ?? 0);
  });

  const allocations: PlannedAllocation[] = [];
  const conditional: PlannedAllocation[] = [];
  const rejected: RejectedCandidate[] = [];
  let positionsPlanned = openPositions;
  const seen = new Set<string>();

  for (const c of sorted) {
    if (seen.has(c.ticker)) continue; // duplicate rows: first (best-ranked) wins
    seen.add(c.ticker);
    const reasons = hardReasons(c, profile, market, input.horizon, held);
    const confirmed = c.qualified && c.action === "ENTRY_CONFIRMED";
    const watchable = !confirmed && (WATCHABLE_ACTIONS.has(c.action) || c.aiCapAction === "CAP_TO_WATCH");
    if (!confirmed) reasons.push("ENTRY_NOT_CONFIRMED");
    if (c.aiCapAction === "CAP_TO_WATCH") reasons.push("AI_CAP_WATCH");
    const hard = reasons.filter((r) => r !== "ENTRY_NOT_CONFIRMED" && r !== "AI_CAP_WATCH");
    if (hard.length > 0 || (!confirmed && !watchable)) {
      rejected.push(reject(c, reasons));
      continue;
    }
    // Only confirmed setups consume a position slot; WATCH is conditional.
    if (confirmed && positionsPlanned >= maxPositions) {
      rejected.push(reject(c, ["MAX_POSITIONS_REACHED"]));
      continue;
    }
    const entry = entryPriceOf(c) as number;
    const stop = c.plan.initialStop as number;
    const target1 = c.plan.target1 as number;
    const atrPct = c.plan.atr14 != null && entry > 0 ? (c.plan.atr14 / entry) * 100 : null;
    const sizing = computePositionSize({
      budgetInr: totalEquity,
      riskPerTradePct: profile.riskPerTradePct * gate.sizeMultiplier * macro.multiplier,
      entryPrice: entry,
      stopPrice: stop,
      atrPct,
      relVolume: c.relVolume,
      advInr: c.plan.advInr,
      sectorCapitalInUseInr: sectorInUse.get(c.sector ?? "Unclassified") ?? 0,
    });
    const constraints = [...sizing.constraintsApplied];
    const codes: ReasonCode[] = confirmed ? ["QUALIFIED_SETUP"] : ["ENTRY_NOT_CONFIRMED"];
    if (c.aiCapAction === "CAP_TO_WATCH") codes.push("AI_CAP_WATCH");
    if (gate.sizeMultiplier < 1) constraints.push(`regime ${gate.regime}: size ×${gate.sizeMultiplier}`);
    if (macro.multiplier < 1) constraints.push(`global macro risk: size ×${macro.multiplier} (${market.global?.regime})`);

    let qty = sizing.positionSizeShares;
    const perShareLoss = sizing.lossAtStop != null && qty > 0 ? sizing.lossAtStop / qty : entry - stop;
    const maxAmount = r2((profile.maxPositionPctOfCapital / 100) * totalEquity * macro.multiplier);
    if (qty * entry > maxAmount) {
      qty = Math.floor(maxAmount / entry);
      constraints.push(REASON_TEXT.POSITION_CAP_BINDING);
      codes.push("POSITION_CAP_BINDING");
    }
    if (confirmed && qty * entry > deployable) {
      qty = Math.floor(deployable / entry);
      constraints.push(deployable <= 0 ? REASON_TEXT.CASH_RESERVE_BINDING : "capped by deployable cash after reserve");
      if (deployable <= 0) codes.push("CASH_RESERVE_BINDING");
    }
    const riskRemaining = Math.max(0, riskBudget - riskUsed);
    if (confirmed && qty * perShareLoss > riskRemaining) {
      qty = Math.floor(riskRemaining / Math.max(perShareLoss, 1e-9));
      constraints.push(REASON_TEXT.RISK_BUDGET_EXHAUSTED);
      codes.push("RISK_BUDGET_EXHAUSTED");
    }
    if (qty <= 0) {
      const code: ReasonCode =
        sizing.constraintsApplied.some((s) => /ADV|participation/i.test(s))
          ? "LIQUIDITY_INSUFFICIENT"
          : confirmed && deployable <= 0
            ? "CASH_RESERVE_BINDING"
            : confirmed && riskRemaining <= 0
              ? "RISK_BUDGET_EXHAUSTED"
              : "CAPITAL_TOO_SMALL_FOR_ONE_SHARE";
      rejected.push(reject(c, [...reasons.filter((r) => r !== "ENTRY_NOT_CONFIRMED"), code], constraints));
      continue;
    }
    const amount = r2(qty * entry);
    const riskAmount = r2(qty * perShareLoss);
    const planned: PlannedAllocation = {
      ticker: c.ticker,
      name: c.name,
      sector: c.sector,
      action: confirmed ? "ALLOCATE" : "WATCH",
      recommendedAmountInr: amount,
      recommendedQuantity: qty,
      maxAmountInr: Math.min(maxAmount, r2(Math.max(amount, Math.floor(maxAmount / entry) * entry))),
      percentageOfCapital: totalEquity > 0 ? r2((amount / totalEquity) * 100) : 0,
      entryPrice: entry,
      entryZoneLow: c.plan.entryZoneLow,
      entryZoneHigh: c.plan.entryZoneHigh,
      entryType: c.plan.entryType,
      stopPrice: stop,
      target1,
      target2: c.plan.target2,
      target3: c.plan.target3,
      expectedHoldingSessions: c.plan.expectedHoldingDays,
      riskAmountInr: riskAmount,
      rewardRisk: c.plan.rewardRiskToTarget1 as number,
      evAfterCostsPct: c.ev?.meanEvAfterCostsPct ?? null,
      ev80LowerPct: c.ev?.ev80LowerPct ?? null,
      evidenceTier: c.tier,
      evidenceScore: c.evidenceScore,
      setupType: c.setupType,
      probability: c.probability.status === "AVAILABLE" ? c.probability : { status: c.probability.status, targetBeforeStop: null },
      reasonCodes: codes,
      riskReasons: [
        `loss if stop ${stop} is hit: ₹${riskAmount.toLocaleString("en-IN")} incl. costs and slippage`,
        ...(c.plan.invalidationReason ? [c.plan.invalidationReason] : []),
        ...c.ceilingReasons,
      ],
      invalidationReasons: [
        `close below ${c.plan.invalidationPrice ?? stop} invalidates the setup`,
        `plan expires if not filled within 3 sessions`,
        ...(market.regime !== "TREND_UP" ? [`regime ${market.regime}: size already reduced ×${gate.sizeMultiplier}`] : []),
      ],
      sizingConstraints: constraints,
      environment: (() => {
        const sectorEnv = sectorEnvOf(c.sector);
        const hostile = globalEnv === "HEADWIND" || globalEnv === "STRESS" || indiaEnv === "HEADWIND" || indiaEnv === "STRESS" || sectorEnv === "HEADWIND";
        return {
          global: globalEnv,
          india: indiaEnv,
          sector: sectorEnv,
          setup: confirmed ? ("PASS" as const) : ("FAIL" as const),
          label: confirmed ? (hostile ? "Qualified setup with elevated macro risk" : "Qualified setup") : hostile ? "Conditional setup in a hostile environment" : "Conditional setup",
          macroRiskMultiplier: macro.multiplier,
        };
      })(),
      decisionSnapshotId: c.decisionSnapshotId,
      changesIf: confirmed
        ? [
            `a close below ${c.plan.invalidationPrice ?? stop} → EXIT`,
            `a close at or above ${target1} → take half, trail the rest`,
            `regime moves to CRISIS or the circuit breaker trips → no new entries`,
            `EV lower bound turns ≤ 0 on the next scan → downgraded to WATCH`,
          ]
        : [
            ...c.whyNotEntry.map((w) => `entry becomes confirmed when: ${w}`),
            `max ₹${amount.toLocaleString("en-IN")} if the entry trigger is reached and gates still pass`,
          ],
    };
    if (confirmed) {
      allocations.push(planned);
      positionsPlanned += 1;
      deployable = r2(deployable - amount);
      riskUsed = r2(riskUsed + riskAmount);
      sectorInUse.set(c.sector ?? "Unclassified", (sectorInUse.get(c.sector ?? "Unclassified") ?? 0) + amount);
    } else {
      conditional.push(planned);
    }
  }

  const deployment = r2(allocations.reduce((s, a) => s + a.recommendedAmountInr, 0));
  const recommendedCash = r2(capitalAvailable - deployment);
  if (allocations.length === 0 && whyCash.length === 0) {
    whyCash.push(
      input.candidates.length === 0
        ? "no short-term candidates on file — nothing to evaluate"
        : "no candidate cleared every gate at this profile — holding cash is the correct result, not a failure",
    );
  }
  if (recommendedCash > cashReserve && allocations.length > 0) whyCash.push(`₹${r2(recommendedCash - cashReserve).toLocaleString("en-IN")} stays in cash because no further candidate qualified`);

  const cash: CashSummary = {
    capitalAvailableInr: r2(capitalAvailable),
    capitalInvestedInr: r2(invested),
    totalEquityInr: r2(totalEquity),
    cashReserveInr: cashReserve,
    cashReservePct: profile.cashReservePct,
    recommendedDeploymentInr: deployment,
    recommendedCashInr: recommendedCash,
    maxDeployableInr: r2(Math.max(0, capitalAvailable - cashReserve)),
    riskBudgetInr: riskBudget,
    riskUsedInr: riskUsed,
    unusedRiskBudgetInr: r2(Math.max(0, riskBudget - riskUsed)),
    whyCash,
  };

  const scenario = buildScenario(allocations, input.holdings, totalEquity);
  const noNew = allocations.length === 0;
  const summary = noNew
    ? `NO NEW CAPITAL ALLOCATION TODAY. ${conditional.length} conditional setup${conditional.length === 1 ? "" : "s"} on watch; ${withdrawals.length} holding${withdrawals.length === 1 ? "" : "s"} flagged to reduce or exit.`
    : `${allocations.length} qualified setup${allocations.length === 1 ? "" : "s"}: deploy ₹${deployment.toLocaleString("en-IN")} of ₹${r2(capitalAvailable).toLocaleString("en-IN")}, keep ₹${recommendedCash.toLocaleString("en-IN")} in cash. Scenario loss if every stop hits: ₹${scenario.maxPortfolioLossInr.toLocaleString("en-IN")}. This is a system recommendation on measured evidence, not a profit forecast.`;

  return {
    version: CAPITAL_DESK_VERSION,
    policyVersion: CAPITAL_POLICY_VERSION,
    asOf: input.asOf,
    riskProfile: profile.name,
    horizon: input.horizon,
    maxPositions,
    regime: { regime: market.regime, reasons: market.regimeReasons, sizeMultiplier: gate.sizeMultiplier },
    global: { regime: market.global?.regime ?? null, transmission: market.global?.transmission ?? null, macroRiskMultiplier: macro.multiplier, maxPositionsAfterMacro: maxPositions, policy: "global-risk-policy-v1", reasons: [...macro.reasons, ...(market.global?.transmissionReasons.slice(0, 2) ?? [])], globalDataAsOf: market.global?.globalDataAsOf ?? null, indiaDataAsOf: market.global?.indiaDataAsOf ?? null },
    circuitBreaker: { canEnter: market.breakerCanEnter, reason: market.breakerReason },
    freshness: market.freshness,
    allocations,
    conditional,
    holds,
    withdrawals,
    rejected,
    cash,
    scenario,
    summary,
    noNewAllocation: noNew,
    candidatesEvaluated: seen.size,
  };
}

function reject(c: CapitalCandidateInput, codes: ReasonCode[], extra: string[] = []): RejectedCandidate {
  const uniq = [...new Set(codes)];
  return {
    ticker: c.ticker,
    name: c.name,
    setupType: c.setupType,
    tier: c.tier,
    action: c.action,
    reasonCodes: uniq,
    whyNot: [...uniq.map((k) => REASON_TEXT[k]), ...c.whyNotEntry, ...extra],
    gateFailures: c.gateFailures,
  };
}

function buildScenario(allocations: PlannedAllocation[], holdings: CapitalHoldingInput[], totalEquity: number): ScenarioSummary {
  const lossNew = allocations.reduce((s, a) => s + a.riskAmountInr, 0);
  let lossHeld = 0;
  for (const h of holdings) {
    const stop = h.evidence?.plan.initialStop ?? null;
    if (h.price != null && stop != null && stop < h.price) lossHeld += h.qty * (h.price - stop);
  }
  const upside = allocations.reduce((s, a) => {
    const gross = a.recommendedQuantity * (a.target1 - a.entryPrice);
    const costPct = 0.3; // round-trip delivery cost scenario, matches the shadow ledger default
    return s + gross - a.recommendedAmountInr * (costPct / 100);
  }, 0);
  const values = [...allocations.map((a) => a.recommendedAmountInr), ...holdings.map((h) => h.markedValueInr ?? h.investedInr)];
  const largest = values.length ? Math.max(...values) : 0;
  return {
    label: "SCENARIO — not a prediction",
    maxPortfolioLossInr: r2(lossNew + lossHeld),
    maxPortfolioLossPct: totalEquity > 0 ? r2(((lossNew + lossHeld) / totalEquity) * 100) : 0,
    maxUpsideAtTarget1Inr: r2(upside),
    maxUpsideAtTarget1Pct: totalEquity > 0 ? r2((upside / totalEquity) * 100) : 0,
    riskPerPositionInr: allocations.map((a) => a.riskAmountInr),
    concentrationLargestPct: totalEquity > 0 ? r2((largest / totalEquity) * 100) : 0,
    positions: allocations.length + holdings.filter((h) => h.qty > 0).length,
  };
}
