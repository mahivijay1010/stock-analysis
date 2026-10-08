/**
 * Risk profiles for the Money Desk. A profile is NOT a multiplier on size: it
 * changes the cash reserve, the per-position cap, the portfolio risk budget,
 * the risk per trade, the minimum reward:risk, the evidence threshold and the
 * number of simultaneous positions. Every value is overridable per call, but
 * ABSOLUTE_LIMITS are the ceiling no override may exceed (fail-closed).
 */

import { RISK_LIMITS, SIZING_LIMITS } from "../shortterm/sizing";
import { RiskProfileName } from "./types";

export interface RiskProfile {
  name: RiskProfileName;
  /** Cash that must stay undeployed, % of total equity (available + invested). */
  cashReservePct: number;
  /** Largest single position, % of total equity. */
  maxPositionPctOfCapital: number;
  /** Sum of loss-at-stop across open + new positions, % of total equity. */
  maxPortfolioRiskPct: number;
  /** Risk per trade handed to the existing risk-based sizer, % of total equity. */
  riskPerTradePct: number;
  /** Minimum reward:risk to target 1. */
  minRewardRisk: number;
  /** Minimum setup-evidence tier for a new allocation. */
  minEvidenceTier: "A" | "B";
  /** EV 80% lower bound must be > 0 after costs. Always true today; kept explicit. */
  requireEv80LowerPositive: boolean;
  maxPositions: number;
  /** In CRISIS / breaker-tripped regimes, holdings are reduced to this % of their value. */
  riskOffHoldPct: number;
}

/** Hard ceilings. Overrides are clamped to these, never the other way round. */
export const ABSOLUTE_LIMITS = {
  minCashReservePct: 5,
  maxPositionPctOfCapital: SIZING_LIMITS.maxSingleStockPctOfBudget, // 35
  maxPortfolioRiskPct: RISK_LIMITS.maxWeeklyLossPctOfBudget, // 3.0
  maxRiskPerTradePct: 1.0,
  minRewardRiskFloor: 1.2,
  maxPositions: RISK_LIMITS.maxOpenPositions, // 5
} as const;

export const RISK_PROFILES: Record<RiskProfileName, RiskProfile> = {
  CONSERVATIVE: {
    name: "CONSERVATIVE",
    cashReservePct: 40,
    maxPositionPctOfCapital: 15,
    maxPortfolioRiskPct: 1.0,
    riskPerTradePct: 0.25,
    minRewardRisk: 2.0,
    minEvidenceTier: "A",
    requireEv80LowerPositive: true,
    maxPositions: 2,
    riskOffHoldPct: 25,
  },
  BALANCED: {
    name: "BALANCED",
    cashReservePct: 25,
    maxPositionPctOfCapital: 25,
    maxPortfolioRiskPct: 2.0,
    riskPerTradePct: 0.5,
    minRewardRisk: 1.8,
    minEvidenceTier: "A",
    requireEv80LowerPositive: true,
    maxPositions: 3,
    riskOffHoldPct: 50,
  },
  AGGRESSIVE: {
    name: "AGGRESSIVE",
    cashReservePct: 10,
    maxPositionPctOfCapital: 35,
    maxPortfolioRiskPct: 3.0,
    riskPerTradePct: 1.0,
    minRewardRisk: 1.5,
    minEvidenceTier: "A",
    requireEv80LowerPositive: true,
    maxPositions: 5,
    riskOffHoldPct: 60,
  },
};

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Resolve a profile with optional overrides, clamped to ABSOLUTE_LIMITS. */
export function resolveRiskProfile(name: RiskProfileName, overrides: Partial<RiskProfile> = {}): RiskProfile {
  const base = RISK_PROFILES[name] ?? RISK_PROFILES.BALANCED;
  const p: RiskProfile = { ...base, ...overrides, name: base.name };
  return {
    ...p,
    cashReservePct: clamp(p.cashReservePct, ABSOLUTE_LIMITS.minCashReservePct, 95),
    maxPositionPctOfCapital: clamp(p.maxPositionPctOfCapital, 1, ABSOLUTE_LIMITS.maxPositionPctOfCapital),
    maxPortfolioRiskPct: clamp(p.maxPortfolioRiskPct, 0.1, ABSOLUTE_LIMITS.maxPortfolioRiskPct),
    riskPerTradePct: clamp(p.riskPerTradePct, 0.05, ABSOLUTE_LIMITS.maxRiskPerTradePct),
    minRewardRisk: Math.max(ABSOLUTE_LIMITS.minRewardRiskFloor, p.minRewardRisk),
    maxPositions: clamp(Math.round(p.maxPositions), 1, ABSOLUTE_LIMITS.maxPositions),
    riskOffHoldPct: clamp(p.riskOffHoldPct, 0, 100),
    minEvidenceTier: p.minEvidenceTier === "B" ? "B" : "A",
  };
}

export function isRiskProfileName(v: unknown): v is RiskProfileName {
  return v === "CONSERVATIVE" || v === "BALANCED" || v === "AGGRESSIVE";
}

/**
 * Global macro-risk policy (spec §36). Multipliers apply to risk per trade and
 * to the position cap; the position count is reduced only in RISK_OFF /
 * STRESSED. A multiplier below 1 is applied ONLY when the regime's own
 * historical evidence is displayable (n ≥ 20) and shows a worse-than-
 * unconditional NIFTY 5-session median; otherwise the regime is context only
 * and the multiplier stays 1 with the reason stated. Configurable via env.
 */
export const GLOBAL_RISK_POLICY = {
  version: "global-risk-policy-v1",
  multipliers: {
    RISK_ON: 1.0,
    NEUTRAL: 1.0,
    CAUTIOUS: Number(process.env.GLOBAL_RISK_MULT_CAUTIOUS ?? 0.75),
    RISK_OFF: Number(process.env.GLOBAL_RISK_MULT_RISK_OFF ?? 0.5),
    STRESSED: Number(process.env.GLOBAL_RISK_MULT_STRESSED ?? 0.25),
  } as Record<string, number>,
  maxPositionsDelta: { RISK_ON: 0, NEUTRAL: 0, CAUTIOUS: 0, RISK_OFF: -1, STRESSED: -2 } as Record<string, number>,
  requireEvidence: process.env.GLOBAL_RISK_REQUIRE_EVIDENCE !== "0",
  minEvidenceN: 20,
  /** Transmission can tighten one notch further (HEADWIND ×0.85, STRESS ×0.7) — again only with evidence. */
  transmissionMultipliers: { TAILWIND: 1.0, NEUTRAL: 1.0, HEADWIND: Number(process.env.GLOBAL_RISK_MULT_HEADWIND ?? 0.85), STRESS: Number(process.env.GLOBAL_RISK_MULT_STRESS ?? 0.7) } as Record<string, number>,
} as const;

export interface MacroRiskDecision {
  multiplier: number;
  maxPositionsDelta: number;
  reasons: string[];
  evidenceBacked: boolean;
}

/** Pure: decide the macro-risk adjustment from the global context and its evidence. */
export function macroRiskAdjustment(g: { regime: string; transmission: string; evidence: { n: number; niftyMedian5dPct: number | null; unconditionalMedian5dPct: number | null } | null } | null | undefined): MacroRiskDecision {
  if (!g) return { multiplier: 1, maxPositionsDelta: 0, reasons: ["no global snapshot — no macro adjustment"], evidenceBacked: false };
  const P = GLOBAL_RISK_POLICY;
  const regimeMult = P.multipliers[g.regime] ?? 1;
  const transMult = P.transmissionMultipliers[g.transmission] ?? 1;
  const reasons: string[] = [];
  if (regimeMult >= 1 && transMult >= 1) return { multiplier: 1, maxPositionsDelta: 0, reasons: [`global regime ${g.regime} / transmission ${g.transmission}: no reduction under ${P.version}`], evidenceBacked: false };
  const ev = g.evidence;
  const worse = ev && ev.n >= P.minEvidenceN && ev.niftyMedian5dPct != null && ev.unconditionalMedian5dPct != null && ev.niftyMedian5dPct < ev.unconditionalMedian5dPct;
  if (P.requireEvidence && !worse) {
    reasons.push(`global regime ${g.regime}${g.transmission !== "NEUTRAL" ? ` / transmission ${g.transmission}` : ""} is context only: ${ev ? `evidence n=${ev.n}${ev.niftyMedian5dPct != null ? `, NIFTY 5d median ${ev.niftyMedian5dPct}% vs unconditional ${ev.unconditionalMedian5dPct}%` : ""}` : "no regime evidence"} does not demonstrate materially higher risk (needs n ≥ ${P.minEvidenceN} and a worse-than-unconditional median)`);
    return { multiplier: 1, maxPositionsDelta: 0, reasons, evidenceBacked: false };
  }
  const multiplier = Math.max(0, Math.min(1, regimeMult * transMult));
  reasons.push(`global regime ${g.regime} ×${regimeMult}${transMult < 1 ? ` · transmission ${g.transmission} ×${transMult}` : ""} = ×${Math.round(multiplier * 100) / 100} on risk per trade and position cap (${P.version}; evidence n=${ev?.n}, NIFTY 5d median ${ev?.niftyMedian5dPct}% vs ${ev?.unconditionalMedian5dPct}%)`);
  return { multiplier, maxPositionsDelta: P.maxPositionsDelta[g.regime] ?? 0, reasons, evidenceBacked: true };
}
