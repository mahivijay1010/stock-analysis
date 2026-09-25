/**
 * Full trade plan composer (full-plan-v1) — PURE.
 *
 * One payload per shortlisted stock that answers, in order: should a trade
 * exist at all (direction), where it enters, where it exits (stop / trail /
 * time / event), what it costs and returns in EXACT ₹ (charges + Indian
 * capital-gains tax, via computeTradeEconomics), and what measured evidence
 * backs the setup (shadow-ledger expectancy with sample size, governed
 * probability, never an invented number).
 *
 * COMPOSES what the system already computed — the candidate view's plan,
 * sizing, tiers, gates and governed forecast — and refuses to re-derive any
 * of it. Honesty invariants:
 *  - direction is NO_TRADE unless the candidate is QUALIFIED and affordable;
 *    the reasons are the gate's own words, never softened.
 *  - long-only cash equity: SHORT is not offered (no F&O/SLB support), stated
 *    rather than silently omitted.
 *  - scenario P&L is labelled scenarios; probabilities appear ONLY via the
 *    governed probability block (resolveProbability invariant upstream).
 *  - shadow expectancy is withheld below the LIVE_AUTHORITY minimum with the
 *    sample size that caused the withholding.
 */

import { ShortTermCandidateView } from "./types";
import { computeTradeEconomics, TradeEconomics } from "../decision/tradeEconomics";
import { LIVE_AUTHORITY } from "./shortTermHealth";

export const FULL_PLAN_VERSION = "full-plan-v1";

export interface ShadowSetupStats {
  resolved: number;
  distinctDates: number;
  /** Conservative (ambiguous bars at their adverse leg) — the SAFETY number. */
  expectancyR: number | null;
  /** Observed-only (ambiguous excluded) — the reportable track record. */
  realizedExpectancyR: number | null;
  ambiguousTrades: number;
}

export interface FullPlanParams {
  budgetInr: number;
  riskPerTradePct: number;
  /** Marginal income-tax slab % — only used for INTRADAY scenarios. */
  slabRatePct: number;
}

export const FULL_PLAN_DEFAULTS: FullPlanParams = {
  budgetInr: 200_000,
  riskPerTradePct: 1,
  slabRatePct: 30,
};

interface ScenarioMoney {
  exitPrice: number;
  grossInr: number;
  chargesInr: number;
  taxInr: number;
  taxBasis: string;
  netAfterTaxInr: number;
  netReturnOnCapitalPct: number;
}

export interface FullTradePlan {
  version: string;
  ticker: string;
  name: string;
  evaluatedAt: string | null;
  direction: "LONG" | "NO_TRADE";
  directionBasis: string;
  noTradeReasons: string[];
  qualified: boolean;
  tier: string;
  action: string;
  state: string;
  freshness: ShortTermCandidateView["freshness"];
  freshnessV2: string;
  riskLevel: string;
  dataQuality: number;
  modelHealth: string;
  entry: {
    type: string;
    zoneLow: number | null;
    zoneHigh: number | null;
    trigger: string | null;
    triggerPrice: number | null;
    orderType: "LIMIT_IN_ZONE" | "STOP_BUY_ABOVE_TRIGGER" | null;
  };
  stops: {
    initial: number | null;
    basis: string | null;
    trailingRule: string;
    timeStopSessions: number;
    eventStop: { price: number | null; reason: string | null };
    orderType: "SL_M_GTT";
  };
  targets: Array<{
    level: 1 | 2 | 3;
    price: number;
    rewardRisk: number | null;
    orderType: "LIMIT_GTT_OCO";
  }>;
  /** Governed probability — passthrough of the forecast block, never re-derived. */
  probability: {
    status: string;
    targetBeforeStop: number | null;
    statement: string;
    p10Pct: number | null;
    p50Pct: number | null;
    p90Pct: number | null;
    sampleSize: number | null;
    modelConfidence: string;
  };
  economics: {
    params: FullPlanParams & { productType: "DELIVERY_EQUITY"; holdingPeriodDays: number };
    quantity: number;
    lotSize: number;
    capitalRequiredInr: number;
    riskAmountInr: number;
    breakevenPrice: number | null;
    sizingConstraints: string[];
    atStop: ScenarioMoney | null;
    atT1: ScenarioMoney | null;
    atT2: ScenarioMoney | null;
    atT3: ScenarioMoney | null;
  } | null;
  evidence: {
    setupType: string;
    setupScore: number;
    shadow:
      | { status: "SHOWN"; resolved: number; distinctDates: number; conservativeExpectancyR: number | null; realizedExpectancyR: number | null; ambiguousTrades: number }
      | { status: "WITHHELD"; resolved: number; distinctDates: number; reason: string };
    whyCandidate: string[];
    whatCanGoWrong: string[];
    contradictions: Array<{ code: string; message: string; cap: string }>;
  };
  honesty: string[];
}

const money = (t: TradeEconomics, which: "TARGET_HIT" | "STOP_HIT"): ScenarioMoney | null => {
  const s = t.scenarios.find((x) => x.scenario === which);
  if (!s) return null;
  return { exitPrice: s.exitPrice, grossInr: s.grossPnlInr, chargesInr: s.charges.total, taxInr: s.taxInr, taxBasis: s.taxBasis, netAfterTaxInr: s.netAfterTaxInr, netReturnOnCapitalPct: s.netReturnOnCapitalPct };
};
const winOf = (t: TradeEconomics): ScenarioMoney | null => money(t, "TARGET_HIT");
const stopOf = (t: TradeEconomics): ScenarioMoney | null => money(t, "STOP_HIT");

export function composeFullTradePlan(
  view: ShortTermCandidateView,
  shadow: ShadowSetupStats | null,
  params: Partial<FullPlanParams> = {},
  evaluatedAt: string | null = null
): FullTradePlan {
  const p: FullPlanParams = { ...FULL_PLAN_DEFAULTS, ...params };
  const plan = view.plan;

  // Entry price the economics are computed at: the zone's limit (top of zone,
  // matching the shadow-fill convention) or the breakout trigger.
  const entryPrice = plan.entryType === "BREAKOUT_TRIGGER" ? plan.entryTriggerPrice : plan.entryZoneHigh;
  const geometryComplete = entryPrice != null && plan.initialStop != null && plan.target1 != null && plan.initialStop < entryPrice && plan.target1 > entryPrice;

  const noTradeReasons: string[] = [];
  if (!view.qualified) {
    noTradeReasons.push(...view.ceilingReasons, ...view.whyNotEntry);
    for (const f of view.gates.failures) noTradeReasons.push(`${f.gate}: ${f.current} (required ${f.required})`);
    if (noTradeReasons.length === 0) noTradeReasons.push(`not qualified (tier ${view.tier}) — see research watchlist rationale`);
  }
  if (!geometryComplete) noTradeReasons.push("plan geometry incomplete — no priced entry/stop/target to trade");

  // ── Exact ₹ economics at each target (same entry/stop/budget ⇒ same qty) ──
  let economics: FullTradePlan["economics"] = null;
  if (geometryComplete) {
    const holdingPeriodDays = Math.max(1, plan.expectedHoldingDays);
    const mk = (target: number | null): TradeEconomics | null => {
      if (target == null || !(target > (entryPrice as number))) return null;
      try {
        return computeTradeEconomics({
          entryPrice: entryPrice as number,
          stopPrice: plan.initialStop as number,
          targetPrice: target,
          budgetInr: p.budgetInr,
          riskPerTradePct: p.riskPerTradePct,
          holdingPeriodDays,
          slabRatePct: p.slabRatePct,
          atrPct: plan.atr14 != null && entryPrice ? (plan.atr14 / entryPrice) * 100 : null,
          productType: "DELIVERY_EQUITY",
        });
      } catch {
        return null;
      }
    };
    const t1 = mk(plan.target1);
    const t2 = mk(plan.target2);
    const t3 = mk(plan.target3);
    if (t1) {
      economics = {
        params: { ...p, productType: "DELIVERY_EQUITY", holdingPeriodDays },
        quantity: t1.quantity,
        lotSize: t1.lotSize,
        capitalRequiredInr: t1.capitalRequiredInr,
        riskAmountInr: t1.riskAmountInr,
        breakevenPrice: t1.breakevenPrice ?? null,
        sizingConstraints: t1.sizingConstraints,
        atStop: stopOf(t1),
        atT1: winOf(t1),
        atT2: t2 ? winOf(t2) : null,
        atT3: t3 ? winOf(t3) : null,
      };
      if (t1.quantity === 0) noTradeReasons.push(`unaffordable at this risk budget: ${t1.sizingConstraints.join("; ") || "cannot size one share"}`);
    } else {
      noTradeReasons.push("economics unavailable — target geometry rejected by the cost model");
    }
  }

  const direction: "LONG" | "NO_TRADE" = view.qualified && geometryComplete && (economics?.quantity ?? 0) > 0 ? "LONG" : "NO_TRADE";

  // ── Shadow-ledger evidence, withheld below the LIVE_AUTHORITY minimum ────
  const minN = LIVE_AUTHORITY.minEffectiveShadowTrades;
  const eff = shadow ? Math.min(shadow.resolved, shadow.distinctDates) : 0;
  const shadowBlock: FullTradePlan["evidence"]["shadow"] =
    shadow && eff >= minN
      ? {
          status: "SHOWN",
          resolved: shadow.resolved,
          distinctDates: shadow.distinctDates,
          conservativeExpectancyR: shadow.expectancyR,
          realizedExpectancyR: shadow.realizedExpectancyR,
          ambiguousTrades: shadow.ambiguousTrades,
        }
      : {
          status: "WITHHELD",
          resolved: shadow?.resolved ?? 0,
          distinctDates: shadow?.distinctDates ?? 0,
          reason: `only ${eff} independent resolved shadow trades for this setup (< ${minN} minimum) — expectancy would be noise, not evidence`,
        };

  const honesty: string[] = [
    "Long-only cash equity: SHORT setups are not offered (no F&O or SLB support in this system).",
    "₹ figures at stop/T1/T2/T3 are SCENARIOS with exact charges and tax — not forecasts, and no probability is attached to them beyond the governed block above.",
    view.forecast.probabilityStatement,
  ];
  if (view.freshness.state !== "LIVE") honesty.push(`data freshness is ${view.freshnessV2} — verify price before placing any order.`);
  if (direction === "NO_TRADE") honesty.push("NO_TRADE is a decision, not an absence of one: the burden of proof was not met.");

  return {
    version: FULL_PLAN_VERSION,
    ticker: view.ticker,
    name: view.name,
    evaluatedAt,
    direction,
    directionBasis:
      direction === "LONG"
        ? `qualified tier-${view.tier} ${plan.entryType.toLowerCase().replace(/_/g, " ")} with complete, affordable geometry`
        : "fail-closed: qualification, geometry or affordability was not met",
    noTradeReasons,
    qualified: view.qualified,
    tier: view.tier,
    action: view.action,
    state: view.state,
    freshness: view.freshness,
    freshnessV2: view.freshnessV2,
    riskLevel: view.riskLevel,
    dataQuality: view.dataQuality,
    modelHealth: view.modelHealth,
    entry: {
      type: plan.entryType,
      zoneLow: plan.entryZoneLow,
      zoneHigh: plan.entryZoneHigh,
      trigger: plan.entryTrigger,
      triggerPrice: plan.entryTriggerPrice,
      orderType: plan.entryType === "BREAKOUT_TRIGGER" ? "STOP_BUY_ABOVE_TRIGGER" : entryPrice != null ? "LIMIT_IN_ZONE" : null,
    },
    stops: {
      initial: plan.initialStop,
      basis: plan.stopBasis,
      trailingRule: "after T1 fills: exit half, trail the remainder at (close − 1.5×ATR14), never lowered — managed by the position state machine",
      timeStopSessions: plan.expectedHoldingDays,
      eventStop: { price: plan.invalidationPrice, reason: plan.invalidationReason },
      orderType: "SL_M_GTT",
    },
    targets: ([
      plan.target1 != null ? { level: 1 as const, price: plan.target1, rewardRisk: plan.rewardRiskToTarget1, orderType: "LIMIT_GTT_OCO" as const } : null,
      plan.target2 != null ? { level: 2 as const, price: plan.target2, rewardRisk: plan.rewardRiskToTarget2, orderType: "LIMIT_GTT_OCO" as const } : null,
      plan.target3 != null ? { level: 3 as const, price: plan.target3, rewardRisk: null, orderType: "LIMIT_GTT_OCO" as const } : null,
    ].filter(Boolean) as FullTradePlan["targets"]),
    probability: {
      status: view.forecast.probabilityStatus,
      targetBeforeStop: view.forecast.probabilityTargetBeforeStop,
      statement: view.forecast.probabilityStatement,
      p10Pct: view.forecast.p10Pct,
      p50Pct: view.forecast.p50Pct,
      p90Pct: view.forecast.p90Pct,
      sampleSize: view.forecast.setupSampleSize,
      modelConfidence: view.forecast.modelConfidence,
    },
    economics,
    evidence: {
      setupType: view.setupType,
      setupScore: view.setupScore,
      shadow: shadowBlock,
      whyCandidate: view.whyCandidate,
      whatCanGoWrong: view.whatCanGoWrong,
      contradictions: view.contradictions,
    },
    honesty,
  };
}
