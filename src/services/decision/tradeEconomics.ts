/**
 * TradeEconomics — the part of a trade that CAN be 100% exact.
 *
 * Owner ask: "lot size, how much to invest, what revenue overall, with tax —
 * 100% accurate." No prediction can be 100% accurate, and this module does not
 * pretend otherwise. What IS deterministic is the arithmetic AROUND a trade,
 * and this computes it to the rupee:
 *
 *   - quantity (risk-based, never budget/price) + capital required
 *   - every statutory/broker charge on both legs (versioned schedule from
 *     shortterm/costs.ts: brokerage, STT, exchange txn, SEBI, stamp, GST, DP)
 *   - breakeven price/move
 *   - P&L at TARGET and at STOP — presented as SCENARIOS, never forecasts
 *   - Indian tax on the gain scenario: STCG 20% / LTCG 12.5% over the ₹1.25L
 *     exemption (delivery, post 2024-07-23 rates) or slab rate (intraday,
 *     speculative business income), + 4% cess
 *
 * Honesty rules:
 *   - outcomes are labelled scenarios; nothing here states a probability
 *   - lot size: NSE cash equity trades in single shares (lot = 1); F&O lots
 *     are out of scope and said so
 *   - LTCG exemption is applied only when the caller says how much of the
 *     year's exemption is unused — never silently assumed
 *
 * PURE — no I/O, exhaustively unit-testable.
 */

import { activeCostSchedule, CostProductType, estimateSlippagePct, TransactionCostSchedule } from "../shortterm/costs";
import { computePositionSize } from "../shortterm/sizing";

export const TRADE_ECONOMICS_VERSION = "trade-economics-v1";

/** Indian equity capital-gains rates in force since 2024-07-23 (FY24-25 → FY25-26). */
export const TAX_SCHEDULE_2024_07 = {
  version: "in-cg-2024-07",
  effectiveFrom: "2024-07-23",
  stcgPct: 20, // §111A: listed equity held ≤ 12 months, STT paid
  ltcgPct: 12.5, // §112A: listed equity held > 12 months
  ltcgAnnualExemptionInr: 125_000, // §112A exemption per financial year
  cessPctOnTax: 4, // health & education cess
  longTermHoldingDays: 365,
} as const;

export interface TradeEconomicsInput {
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  budgetInr: number;
  /** % of budget risked to the stop. Default 1%. */
  riskPerTradePct?: number;
  productType?: CostProductType;
  /** Planned holding days (delivery): ≤365 ⇒ STCG, >365 ⇒ LTCG. Default 30. */
  holdingPeriodDays?: number;
  /** Marginal slab % for intraday (speculative business income). Default 30. */
  slabRatePct?: number;
  /** Unused §112A exemption this FY. Default 0 — never assumed. */
  ltcgExemptionRemainingInr?: number;
  /** Optional liquidity context for the slippage estimate. */
  atrPct?: number | null;
  relVolume?: number | null;
  advInr?: number | null;
}

export interface ChargesBreakdown {
  brokerage: number;
  stt: number;
  exchangeTxn: number;
  sebiFees: number;
  stampDuty: number;
  gst: number;
  dpCharge: number;
  total: number;
}

export interface TradeScenario {
  scenario: "TARGET_HIT" | "STOP_HIT";
  exitPrice: number;
  grossPnlInr: number;
  charges: ChargesBreakdown;
  netBeforeTaxInr: number;
  taxInr: number;
  taxBasis: string;
  netAfterTaxInr: number;
  netReturnOnCapitalPct: number;
}

export interface TradeEconomics {
  version: string;
  costScheduleVersion: string;
  taxScheduleVersion: string;
  /** NSE cash equity trades in single shares. F&O lot sizes are out of scope. */
  lotSize: 1;
  quantity: number;
  rawRiskBasedQty: number | null;
  capitalRequiredInr: number;
  capitalRemainingInr: number;
  riskAmountInr: number;
  lossAtStopInr: number | null;
  sizingConstraints: string[];
  breakevenPrice: number;
  breakevenMovePct: number;
  estimatedSlippagePct: number;
  scenarios: TradeScenario[];
  rewardToRiskAfterCosts: number | null;
  notes: string[];
}

const r2 = (x: number): number => Math.round(x * 100) / 100;
const r4 = (x: number): number => Math.round(x * 10000) / 10000;

function perSideBrokerage(v: TransactionCostSchedule["values"], orderValueInr: number): number {
  const pct = (v.brokeragePctPerSide / 100) * orderValueInr;
  return v.brokerageFlatInrPerOrderCap != null ? Math.min(v.brokerageFlatInrPerOrderCap, pct) : pct;
}

/** Exact rupee charges for one round trip of `qty` shares. PURE. */
export function computeCharges(qty: number, buyPrice: number, sellPrice: number, s: TransactionCostSchedule): ChargesBreakdown {
  const v = s.values;
  const buyValue = qty * buyPrice;
  const sellValue = qty * sellPrice;
  const brokerage = perSideBrokerage(v, buyValue) + perSideBrokerage(v, sellValue);
  const stt = (v.sttPctBuy / 100) * buyValue + (v.sttPctSell / 100) * sellValue;
  const exchangeTxn = (v.exchangeTxnPctPerSide / 100) * (buyValue + sellValue);
  const sebiFees = (v.sebiFeesPctPerSide / 100) * (buyValue + sellValue);
  const stampDuty = (v.stampDutyPctBuy / 100) * buyValue;
  const gst = (v.gstPctOnBrokerageAndTxn / 100) * (brokerage + exchangeTxn + sebiFees);
  const dpCharge = qty > 0 ? v.dpChargeInrPerSellOrder : 0;
  const total = brokerage + stt + exchangeTxn + sebiFees + stampDuty + gst + dpCharge;
  return {
    brokerage: r2(brokerage),
    stt: r2(stt),
    exchangeTxn: r2(exchangeTxn),
    sebiFees: r2(sebiFees),
    stampDuty: r2(stampDuty),
    gst: r2(gst),
    dpCharge: r2(dpCharge),
    total: r2(total),
  };
}

/** Tax on a POSITIVE net gain; a loss owes nothing (offset rules are noted, not modelled). */
export function computeTax(opts: {
  netGainInr: number;
  productType: CostProductType;
  holdingPeriodDays: number;
  slabRatePct: number;
  ltcgExemptionRemainingInr: number;
}): { taxInr: number; basis: string } {
  const t = TAX_SCHEDULE_2024_07;
  if (opts.netGainInr <= 0) {
    return {
      taxInr: 0,
      basis:
        opts.productType === "INTRADAY_EQUITY"
          ? "loss — speculative losses offset only speculative gains (not modelled here)"
          : "loss — capital losses can offset capital gains per IT rules (not modelled here)",
    };
  }
  if (opts.productType === "INTRADAY_EQUITY") {
    const base = (opts.slabRatePct / 100) * opts.netGainInr;
    const tax = base * (1 + t.cessPctOnTax / 100);
    return { taxInr: r2(tax), basis: `speculative business income @ slab ${opts.slabRatePct}% + ${t.cessPctOnTax}% cess` };
  }
  if (opts.holdingPeriodDays > t.longTermHoldingDays) {
    const taxable = Math.max(0, opts.netGainInr - Math.max(0, opts.ltcgExemptionRemainingInr));
    const tax = (t.ltcgPct / 100) * taxable * (1 + t.cessPctOnTax / 100);
    return {
      taxInr: r2(tax),
      basis: `LTCG §112A @ ${t.ltcgPct}% + cess on gain above the unused ₹${Math.max(0, opts.ltcgExemptionRemainingInr).toLocaleString("en-IN")} exemption`,
    };
  }
  const tax = (t.stcgPct / 100) * opts.netGainInr * (1 + t.cessPctOnTax / 100);
  return { taxInr: r2(tax), basis: `STCG §111A @ ${t.stcgPct}% + ${t.cessPctOnTax}% cess (held ≤ 12 months)` };
}

/** Exit price at which net P&L after ALL charges is exactly zero, by bisection
 *  (charges depend on the exit value, so closed form is messier than it looks). */
export function breakevenExitPrice(qty: number, entry: number, s: TransactionCostSchedule): number {
  if (!(qty > 0) || !(entry > 0)) return entry;
  let lo = entry;
  let hi = entry * 1.2;
  const net = (exit: number): number => qty * (exit - entry) - computeCharges(qty, entry, exit, s).total;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (net(mid) < 0) lo = mid;
    else hi = mid;
  }
  return r4((lo + hi) / 2);
}

export function computeTradeEconomics(input: TradeEconomicsInput): TradeEconomics {
  const { entryPrice, stopPrice, targetPrice, budgetInr } = input;
  if (!(entryPrice > 0) || !(budgetInr > 0)) throw new Error("entryPrice and budgetInr must be positive");
  if (!(stopPrice > 0) || stopPrice >= entryPrice) throw new Error("stopPrice must be below entryPrice (long-only)");
  if (!(targetPrice > entryPrice)) throw new Error("targetPrice must be above entryPrice (long-only)");

  const productType = input.productType ?? "DELIVERY_EQUITY";
  const schedule = activeCostSchedule(productType);
  const holdingDays = input.holdingPeriodDays ?? 30;
  const slab = input.slabRatePct ?? 30;
  const exemption = input.ltcgExemptionRemainingInr ?? 0;

  // Quantity: the SAME risk-based sizing the radar uses — costs and a gap
  // buffer are inside the per-share loss, so lossAtStop can't exceed the risk.
  const sizing = computePositionSize({
    budgetInr,
    riskPerTradePct: input.riskPerTradePct ?? 1,
    entryPrice,
    stopPrice,
    atrPct: input.atrPct ?? null,
    relVolume: input.relVolume ?? null,
    advInr: input.advInr ?? null,
  });
  const qty = sizing.positionSizeShares;

  const slippagePct = estimateSlippagePct({
    atrPct: input.atrPct ?? null,
    relVolume: input.relVolume ?? null,
    orderValueInr: qty * entryPrice,
    advInr: input.advInr ?? null,
  });

  const scenario = (name: TradeScenario["scenario"], exitPrice: number): TradeScenario => {
    const gross = qty * (exitPrice - entryPrice);
    const charges = computeCharges(qty, entryPrice, exitPrice, schedule);
    const netBeforeTax = r2(gross - charges.total);
    const { taxInr, basis } = computeTax({
      netGainInr: netBeforeTax,
      productType,
      holdingPeriodDays: holdingDays,
      slabRatePct: slab,
      ltcgExemptionRemainingInr: exemption,
    });
    const capital = qty * entryPrice;
    const netAfterTax = r2(netBeforeTax - taxInr);
    return {
      scenario: name,
      exitPrice: r4(exitPrice),
      grossPnlInr: r2(gross),
      charges,
      netBeforeTaxInr: netBeforeTax,
      taxInr,
      taxBasis: basis,
      netAfterTaxInr: netAfterTax,
      netReturnOnCapitalPct: capital > 0 ? r4((netAfterTax / capital) * 100) : 0,
    };
  };

  const scenarios = qty > 0 ? [scenario("TARGET_HIT", targetPrice), scenario("STOP_HIT", stopPrice)] : [];
  const breakeven = qty > 0 ? breakevenExitPrice(qty, entryPrice, schedule) : entryPrice;
  const win = scenarios.find((s) => s.scenario === "TARGET_HIT");
  const lose = scenarios.find((s) => s.scenario === "STOP_HIT");
  const rr =
    win && lose && lose.netBeforeTaxInr < 0 ? r2(win.netBeforeTaxInr / Math.abs(lose.netBeforeTaxInr)) : null;

  return {
    version: TRADE_ECONOMICS_VERSION,
    costScheduleVersion: schedule.version,
    taxScheduleVersion: TAX_SCHEDULE_2024_07.version,
    lotSize: 1,
    quantity: qty,
    rawRiskBasedQty: sizing.rawRiskBasedQty,
    capitalRequiredInr: r2(qty * entryPrice),
    capitalRemainingInr: r2(budgetInr - qty * entryPrice),
    riskAmountInr: sizing.riskAmount,
    lossAtStopInr: lose ? lose.netBeforeTaxInr : null,
    sizingConstraints: sizing.constraintsApplied,
    breakevenPrice: breakeven,
    breakevenMovePct: r4(((breakeven - entryPrice) / entryPrice) * 100),
    estimatedSlippagePct: slippagePct,
    scenarios,
    rewardToRiskAfterCosts: rr,
    notes: [
      "Charges and taxes are EXACT under the stated schedules; which scenario occurs is NOT predictable — no probability is stated here.",
      "NSE cash equity has no lot size: quantity is in single shares. Slippage is an estimate, not a charge.",
      "Tax simplifications: 4% cess included; surcharge, loss set-off/carry-forward and other income interactions are not modelled.",
    ],
  };
}
