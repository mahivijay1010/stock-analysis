/**
 * Pure withdrawal engine: HOLD / TRAIL / REDUCE / EXIT for existing holdings.
 * It does NOT invent exit logic. It applies the plan's OWN levels that the
 * short-term engine already produced (invalidation, initial stop, targets,
 * the trailing rule "after T1 exit half, trail close − 1.5×ATR14", the
 * expected holding period), plus the regime gate, the circuit breaker and the
 * profile's concentration cap. A holding with no evaluation on file is HELD
 * with that fact stated — never guessed at.
 */

import { regimeGateFor } from "../shortterm/regimeGates";
import { RiskProfile } from "./riskProfiles";
import { CapitalHoldingInput, MarketContextInput, REASON_TEXT, ReasonCode, WithdrawalDecision } from "./types";

const r2 = (v: number): number => Math.round(v * 100) / 100;

export interface WithdrawalInput {
  holdings: CapitalHoldingInput[];
  market: MarketContextInput;
  profile: RiskProfile;
  totalEquityInr: number;
}

export function decideWithdrawals(input: WithdrawalInput): WithdrawalDecision[] {
  return input.holdings.filter((h) => h.qty > 0).map((h) => decideOne(h, input));
}

function decideOne(h: CapitalHoldingInput, input: WithdrawalInput): WithdrawalDecision {
  const { profile, market } = input;
  const gate = regimeGateFor(market.regime);
  const value = h.markedValueInr ?? (h.price != null ? r2(h.qty * h.price) : null);
  const pnl = value != null ? r2(value - h.investedInr) : null;
  const pnlPct = pnl != null && h.investedInr > 0 ? r2((pnl / h.investedInr) * 100) : null;
  const base = {
    ticker: h.ticker,
    name: h.name,
    qty: h.qty,
    currentValueInr: value,
    investedInr: r2(h.investedInr),
    pnlInr: pnl,
    pnlPct,
    evidenceAsOf: h.evidenceAsOf,
  };
  const codes: ReasonCode[] = [];
  const reasons: string[] = [];
  const invalidation: string[] = [];

  if (h.price == null || value == null) {
    return { ...base, action: "HOLD", recommendedRemainingInr: null, amountToWithdrawInr: null, qtyToSell: null, trailStopPrice: null, reasonCodes: ["PRICE_UNAVAILABLE"], reasons: [REASON_TEXT.PRICE_UNAVAILABLE], invalidation: ["a priced quote is required before any exit rule can be applied"] };
  }
  const price = h.price;
  const ev = h.evidence;
  const plan = ev?.plan ?? null;

  const reduceTo = (keepPct: number, action: "REDUCE" | "EXIT", trail: number | null): WithdrawalDecision => {
    const keepValue = action === "EXIT" ? 0 : r2(value * (keepPct / 100));
    const qtyKeep = action === "EXIT" ? 0 : Math.floor(keepValue / price);
    const qtySell = h.qty - qtyKeep;
    const remaining = r2(qtyKeep * price);
    return {
      ...base,
      action,
      recommendedRemainingInr: remaining,
      amountToWithdrawInr: r2(value - remaining),
      qtyToSell: qtySell,
      trailStopPrice: trail,
      reasonCodes: codes,
      reasons,
      invalidation,
    };
  };

  // 1. Plan-level exits (the engine's own levels).
  if (plan) {
    const inv = plan.invalidationPrice;
    const stop = plan.initialStop;
    if (ev && (ev.action === "EXIT" || ev.action === "INVALIDATED")) {
      codes.push("INVALIDATION_HIT");
      reasons.push(`engine action is ${ev.action}${plan.invalidationReason ? `: ${plan.invalidationReason}` : ""}`);
      invalidation.push("nothing — the plan is already invalidated; a fresh setup must re-qualify");
      return reduceTo(0, "EXIT", null);
    }
    if (inv != null && price <= inv) {
      codes.push("INVALIDATION_HIT");
      reasons.push(`price ${price} ≤ invalidation ${inv}${plan.invalidationReason ? ` (${plan.invalidationReason})` : ""}`);
      invalidation.push("nothing — invalidation is a full exit by the plan's own rule");
      return reduceTo(0, "EXIT", null);
    }
    if (stop != null && price <= stop) {
      codes.push("STOP_HIT");
      reasons.push(`price ${price} ≤ initial stop ${stop}`);
      invalidation.push("nothing — the stop is the loss the plan defined first");
      return reduceTo(0, "EXIT", null);
    }
    const t1 = plan.target1;
    const t2 = plan.target2;
    const atr = plan.atr14;
    const trail = atr != null ? r2(price - 1.5 * atr) : stop;
    if (t2 != null && price >= t2) {
      codes.push("TARGET2_REACHED");
      reasons.push(`price ${price} ≥ target 2 ${t2} — plan: reduce to a quarter, trail close − 1.5×ATR`);
      invalidation.push(`a close below the trailing stop ${trail} exits the remainder`);
      return reduceTo(25, "REDUCE", trail);
    }
    if (t1 != null && price >= t1) {
      codes.push("TARGET1_REACHED");
      reasons.push(`price ${price} ≥ target 1 ${t1} — plan: exit half, trail close − 1.5×ATR`);
      invalidation.push(`a close below the trailing stop ${trail} exits the remainder`);
      return reduceTo(50, "REDUCE", trail);
    }
    // Reward/risk compression and setup deterioration.
    if (t1 != null && stop != null && price > stop && price < t1) {
      const remainingRr = (t1 - price) / (price - stop);
      const evLower = ev?.ev?.ev80LowerPct ?? null;
      if (remainingRr < 0.8 && evLower != null && evLower <= 0) {
        codes.push("REWARD_RISK_COMPRESSED", "SETUP_DETERIORATED");
        reasons.push(`remaining reward/risk ${remainingRr.toFixed(2)} < 0.8 and EV lower bound ${evLower.toFixed(2)}% ≤ 0`);
        invalidation.push(`EV lower bound back above 0 on the next scan would return this to TRAIL`);
        return reduceTo(50, "REDUCE", trail);
      }
      if (remainingRr < 0.8) {
        codes.push("REWARD_RISK_COMPRESSED");
        reasons.push(`remaining reward/risk ${remainingRr.toFixed(2)} < 0.8 — tighten the stop rather than add`);
        invalidation.push(`a close below ${trail} exits; a close above ${t1} switches to the target-1 rule`);
        return { ...base, action: "TRAIL", recommendedRemainingInr: value, amountToWithdrawInr: 0, qtyToSell: 0, trailStopPrice: trail, reasonCodes: codes, reasons, invalidation };
      }
    }
    if (ev && ev.modelHealth === "SUSPENDED") {
      codes.push("MODEL_HEALTH_INSUFFICIENT");
      reasons.push("short-term model health SUSPENDED for this setup — tighten the stop");
      invalidation.push(`a close below ${trail} exits`);
      return { ...base, action: "TRAIL", recommendedRemainingInr: value, amountToWithdrawInr: 0, qtyToSell: 0, trailStopPrice: trail, reasonCodes: codes, reasons, invalidation };
    }
  }

  // 2. Regime / breaker risk-off.
  if (gate.sizeMultiplier <= 0 || !market.breakerCanEnter) {
    codes.push("REGIME_RISK_OFF");
    reasons.push(gate.sizeMultiplier <= 0 ? `regime ${market.regime}: ${gate.note}` : `circuit breaker: ${market.breakerReason ?? "tripped"}`);
    invalidation.push("regime leaving CRISIS / breaker resetting restores HOLD");
    return reduceTo(profile.riskOffHoldPct, "REDUCE", plan?.initialStop ?? null);
  }

  // 3. Concentration cap.
  const cap = (profile.maxPositionPctOfCapital / 100) * input.totalEquityInr;
  if (input.totalEquityInr > 0 && value > cap) {
    codes.push("CONCENTRATION_ABOVE_CAP");
    reasons.push(`position ₹${value.toLocaleString("en-IN")} is ${r2((value / input.totalEquityInr) * 100)}% of equity; profile cap ${profile.maxPositionPctOfCapital}%`);
    invalidation.push("a larger total equity or a less conservative profile raises the cap");
    const keepPct = (cap / value) * 100;
    return reduceTo(keepPct, "REDUCE", plan?.initialStop ?? null);
  }

  // 4. No evaluation on file.
  if (!plan) {
    codes.push("NO_EVALUATION_ON_FILE");
    reasons.push(REASON_TEXT.NO_EVALUATION_ON_FILE);
    invalidation.push("run a short-term scan that covers this ticker to get plan-level exit rules");
    return { ...base, action: "HOLD", recommendedRemainingInr: value, amountToWithdrawInr: 0, qtyToSell: 0, trailStopPrice: null, reasonCodes: codes, reasons, invalidation };
  }

  // 5. Healthy hold.
  codes.push("PLAN_HEALTHY");
  reasons.push(`price ${price} is above stop ${plan.initialStop ?? "—"} and below target 1 ${plan.target1 ?? "—"}`);
  invalidation.push(`a close below ${plan.invalidationPrice ?? plan.initialStop} → EXIT`, `a close at or above ${plan.target1} → REDUCE half`);
  return { ...base, action: "HOLD", recommendedRemainingInr: value, amountToWithdrawInr: 0, qtyToSell: 0, trailStopPrice: plan.initialStop, reasonCodes: codes, reasons, invalidation };
}
