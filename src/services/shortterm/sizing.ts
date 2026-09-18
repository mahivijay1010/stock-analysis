/**
 * Risk-based position sizing + portfolio risk manager (S6).
 *
 * positionSize = (budget × riskPct) / riskPerShare — NEVER budget/price — then
 * capital, liquidity, single-stock and sector-concentration constraints, all
 * reported. The full budget is never auto-deployed.
 */

import { PositionSizing } from "./types";
import { estimateSlippagePct, roundTripCostPct } from "./costs";

export const SIZING_LIMITS = {
  maxSingleStockPctOfBudget: 35, // one trade may use at most 35% of the budget
  maxParticipationPctOfAdv: 2, // order ≤ 2% of 20d average daily value
  maxSectorPctOfBudget: 50,
} as const;

export function computePositionSize(opts: {
  budgetInr: number;
  riskPerTradePct: number;
  entryPrice: number;
  stopPrice: number;
  atrPct: number | null;
  relVolume: number | null;
  advInr: number | null;
  sectorCapitalInUseInr?: number;
}): PositionSizing {
  const constraints: string[] = [];
  const riskAmount = Math.round(opts.budgetInr * (opts.riskPerTradePct / 100));
  const riskPerShare = opts.entryPrice - opts.stopPrice;
  if (!(riskPerShare > 0) || !(opts.entryPrice > 0)) {
    return {
      riskAmount,
      riskPerShare: null,
      rawRiskBasedQty: null,
      positionSizeShares: 0,
      capitalRequired: 0,
      capitalRemaining: opts.budgetInr,
      constraintsApplied: ["invalid entry/stop geometry — no size"],
      lossAtStop: null,
    };
  }

  // P0 #7 — solve qty against the FULL per-share loss at the stop: price risk
  // + round-trip costs + slippage + a gap buffer (adverse fill beyond the
  // stop). Costs are added BEFORE sizing so realized lossAtStop can never
  // exceed the risk budget. `costPctAsymptotic` drops the fixed DP fee (tiny,
  // per-order) so the per-share figure is well-defined.
  const costPctAsymptotic = roundTripCostPct(10_000_000);
  const slipPctEst = estimateSlippagePct({ atrPct: opts.atrPct, relVolume: opts.relVolume, orderValueInr: opts.budgetInr, advInr: opts.advInr });
  const atrValue = opts.atrPct != null ? (opts.atrPct / 100) * opts.entryPrice : 0;
  const GAP_BUFFER_ATR = 0.2; // adverse gap-through-stop allowance
  const perShareLoss =
    riskPerShare + (opts.entryPrice * (costPctAsymptotic + slipPctEst)) / 100 + GAP_BUFFER_ATR * atrValue;
  const rawQty = Math.floor(riskAmount / riskPerShare); // price-only (reported for transparency)
  let qty = Math.floor(riskAmount / perShareLoss); // cost-inclusive (the one actually used)
  if (qty < 1) constraints.push("risk budget cannot afford 1 share once costs, slippage and a gap buffer are included");

  // Capital constraint: 35% of budget max on a single trade.
  const maxCapital = opts.budgetInr * (SIZING_LIMITS.maxSingleStockPctOfBudget / 100);
  if (qty * opts.entryPrice > maxCapital) {
    qty = Math.floor(maxCapital / opts.entryPrice);
    constraints.push(`capped by single-stock allocation (${SIZING_LIMITS.maxSingleStockPctOfBudget}% of budget)`);
  }
  // Absolute budget constraint.
  if (qty * opts.entryPrice > opts.budgetInr) {
    qty = Math.floor(opts.budgetInr / opts.entryPrice);
    constraints.push("capped by total budget");
  }
  // Liquidity constraint: ≤ 2% of ADV.
  if (opts.advInr != null && opts.advInr > 0) {
    const maxByAdv = Math.floor((opts.advInr * (SIZING_LIMITS.maxParticipationPctOfAdv / 100)) / opts.entryPrice);
    if (qty > maxByAdv) {
      qty = maxByAdv;
      constraints.push(`capped by liquidity (≤${SIZING_LIMITS.maxParticipationPctOfAdv}% of 20d ADV)`);
    }
  }
  // Sector concentration.
  if (opts.sectorCapitalInUseInr != null) {
    const sectorRoom = opts.budgetInr * (SIZING_LIMITS.maxSectorPctOfBudget / 100) - opts.sectorCapitalInUseInr;
    if (qty * opts.entryPrice > sectorRoom) {
      qty = Math.max(0, Math.floor(sectorRoom / opts.entryPrice));
      constraints.push(`capped by sector concentration (≤${SIZING_LIMITS.maxSectorPctOfBudget}% of budget per sector)`);
    }
  }
  qty = Math.max(0, qty);

  const capitalRequired = Math.round(qty * opts.entryPrice);
  const orderValue = Math.max(1, capitalRequired);
  const costPct = roundTripCostPct(orderValue);
  const slipPct = estimateSlippagePct({ atrPct: opts.atrPct, relVolume: opts.relVolume, orderValueInr: orderValue, advInr: opts.advInr });
  const lossAtStop = qty > 0 ? Math.round(qty * riskPerShare + (orderValue * (costPct + slipPct)) / 100) : null;

  return {
    riskAmount,
    riskPerShare: Math.round(riskPerShare * 100) / 100,
    rawRiskBasedQty: rawQty,
    positionSizeShares: qty,
    capitalRequired,
    capitalRemaining: Math.max(0, Math.round(opts.budgetInr - capitalRequired)),
    constraintsApplied: constraints.length ? constraints : ["risk-based size within all limits"],
    lossAtStop,
  };
}

// ── Portfolio-level risk manager (S6) ───────────────────────────────────────

/**
 * Equity drawdown from peak, %, over the realized paper P&L history — the
 * input the drawdown kill switch needs (docs/system-trust-review.md §5.4
 * flagged it as inert because ScanService passed null). PURE.
 *
 * Equity starts at `budgetInr`; each entry is one day's realized P&L in
 * chronological order. Drawdown is measured on the CURRENT equity vs the
 * running peak (Varsity RM 11.3, "recovery trauma": −5% needs +5.3% back,
 * −10% needs +11.1%, −60% needs +150%). Returns 0 with no history and null
 * only when the budget is not a positive number.
 */
export function computeEquityDrawdownPct(budgetInr: number, dailyRealizedPnlInr: number[]): number | null {
  if (!(budgetInr > 0)) return null;
  let equity = budgetInr;
  let peak = budgetInr;
  for (const pnl of dailyRealizedPnlInr) {
    if (!Number.isFinite(pnl)) continue;
    equity += pnl;
    if (equity > peak) peak = equity;
  }
  if (!(peak > 0)) return -100;
  return Math.round(((equity - peak) / peak) * 10000) / 100;
}

export const RISK_LIMITS = {
  maxOpenRiskPctOfBudget: 2.0, // sum of open lossAtStop
  maxOpenPositions: 5,
  maxDailyLossPctOfBudget: 1.5,
  maxWeeklyLossPctOfBudget: 3.0,
  drawdownKillSwitchPct: 6.0, // paper-equity drawdown from peak
} as const;

export interface RiskManagerVerdict {
  newEntriesAllowed: boolean;
  reasons: string[];
  openRiskInr: number;
  openPositions: number;
}

export function assessPortfolioRisk(opts: {
  budgetInr: number;
  openPositions: Array<{ lossAtStop: number; sector: string }>;
  realizedTodayInr: number;
  realizedWeekInr: number;
  equityDrawdownPct: number | null;
}): RiskManagerVerdict {
  const reasons: string[] = [];
  const openRisk = opts.openPositions.reduce((a, p) => a + Math.max(0, p.lossAtStop), 0);
  let allowed = true;

  if (opts.openPositions.length >= RISK_LIMITS.maxOpenPositions) {
    allowed = false;
    reasons.push(`maximum open positions (${RISK_LIMITS.maxOpenPositions}) reached`);
  }
  if (openRisk > opts.budgetInr * (RISK_LIMITS.maxOpenRiskPctOfBudget / 100)) {
    allowed = false;
    reasons.push(`total open risk ₹${openRisk} exceeds ${RISK_LIMITS.maxOpenRiskPctOfBudget}% of budget`);
  }
  if (-opts.realizedTodayInr > opts.budgetInr * (RISK_LIMITS.maxDailyLossPctOfBudget / 100)) {
    allowed = false;
    reasons.push(`daily loss limit reached (${RISK_LIMITS.maxDailyLossPctOfBudget}% of budget) — no new trades today`);
  }
  if (-opts.realizedWeekInr > opts.budgetInr * (RISK_LIMITS.maxWeeklyLossPctOfBudget / 100)) {
    allowed = false;
    reasons.push(`weekly loss limit reached (${RISK_LIMITS.maxWeeklyLossPctOfBudget}% of budget)`);
  }
  if (opts.equityDrawdownPct != null && opts.equityDrawdownPct <= -RISK_LIMITS.drawdownKillSwitchPct) {
    allowed = false;
    reasons.push(`drawdown kill switch: paper equity ${opts.equityDrawdownPct.toFixed(1)}% from peak (limit ${RISK_LIMITS.drawdownKillSwitchPct}%)`);
  }
  if (allowed) reasons.push("all portfolio risk limits respected");
  return { newEntriesAllowed: allowed, reasons, openRiskInr: openRisk, openPositions: opts.openPositions.length };
}
