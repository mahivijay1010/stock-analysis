/**
 * TransactionCostSchedule (S5) — VERSIONED cost model; regulations are data,
 * not hardcoded forever. EV calculations must include every leg + slippage.
 */

export type CostProductType = "DELIVERY_EQUITY" | "INTRADAY_EQUITY";

export interface TransactionCostSchedule {
  version: string;
  effectiveFrom: string;
  market: "NSE";
  productType: CostProductType;
  values: {
    brokeragePctPerSide: number; // discount brokers: 0 for delivery
    /** Discount-broker intraday brokerage is "₹X or Y% per order, whichever is
     *  LOWER". When set, per-side brokerage = min(this flat ₹, pct × order value). */
    brokerageFlatInrPerOrderCap?: number;
    sttPctBuy: number;
    sttPctSell: number;
    exchangeTxnPctPerSide: number;
    sebiFeesPctPerSide: number;
    stampDutyPctBuy: number;
    gstPctOnBrokerageAndTxn: number;
    dpChargeInrPerSellOrder: number;
  };
}

/** India delivery-equity schedule in force since 2024-10-01 (STT 0.1% both legs). */
export const COST_SCHEDULE_2024_10: TransactionCostSchedule = {
  version: "in-delivery-2024-10",
  effectiveFrom: "2024-10-01",
  market: "NSE",
  productType: "DELIVERY_EQUITY",
  values: {
    brokeragePctPerSide: 0,
    sttPctBuy: 0.1,
    sttPctSell: 0.1,
    exchangeTxnPctPerSide: 0.00297,
    sebiFeesPctPerSide: 0.0001,
    stampDutyPctBuy: 0.015,
    gstPctOnBrokerageAndTxn: 18,
    dpChargeInrPerSellOrder: 15.93,
  },
};

/**
 * India INTRADAY-equity schedule (docs/intraday-study-notes.md §1.5). It is a
 * genuinely different schedule from delivery, not a discount on it: STT is
 * 0.025% on the SELL side only (vs 0.1% both legs), stamp duty 0.003% (vs
 * 0.015%), no DP charge (no delivery, nothing leaves the demat), but discount
 * brokerage is NOT zero — ₹20 or 0.03% per executed order, whichever is lower
 * (Zerodha's published schedule). The flat ₹40 round-trip brokerage floor is
 * exactly why SEBI found 79% of sub-₹5k-ticket intraday traders lose: it does
 * not shrink with the trade. Any intraday P&L/EV must use THIS schedule.
 */
export const COST_SCHEDULE_INTRADAY_2024_10: TransactionCostSchedule = {
  version: "in-intraday-2024-10",
  effectiveFrom: "2024-10-01",
  market: "NSE",
  productType: "INTRADAY_EQUITY",
  values: {
    brokeragePctPerSide: 0.03,
    brokerageFlatInrPerOrderCap: 20,
    sttPctBuy: 0,
    sttPctSell: 0.025,
    exchangeTxnPctPerSide: 0.00297,
    sebiFeesPctPerSide: 0.0001,
    stampDutyPctBuy: 0.003,
    gstPctOnBrokerageAndTxn: 18,
    dpChargeInrPerSellOrder: 0,
  },
};

export function activeCostSchedule(productType: CostProductType = "DELIVERY_EQUITY"): TransactionCostSchedule {
  return productType === "INTRADAY_EQUITY" ? COST_SCHEDULE_INTRADAY_2024_10 : COST_SCHEDULE_2024_10;
}

/** Per-side brokerage as a % of order value, honouring a flat-₹ cap when the schedule has one. */
function brokeragePctPerSide(v: TransactionCostSchedule["values"], orderValueInr: number): number {
  if (v.brokerageFlatInrPerOrderCap == null || !(orderValueInr > 0)) return v.brokeragePctPerSide;
  const flatAsPct = (v.brokerageFlatInrPerOrderCap / orderValueInr) * 100;
  return Math.min(v.brokeragePctPerSide, flatAsPct);
}

/** Round-trip percentage cost for a given order value (excl. slippage). */
export function roundTripCostPct(orderValueInr: number, s: TransactionCostSchedule = activeCostSchedule()): number {
  const v = s.values;
  const perSideTxn = v.exchangeTxnPctPerSide + v.sebiFeesPctPerSide + brokeragePctPerSide(v, orderValueInr);
  const gst = (2 * perSideTxn * v.gstPctOnBrokerageAndTxn) / 100;
  const pct = v.sttPctBuy + v.sttPctSell + 2 * perSideTxn + v.stampDutyPctBuy + gst;
  const dpPct = orderValueInr > 0 ? (v.dpChargeInrPerSellOrder / orderValueInr) * 100 : 0;
  return Math.round((pct + dpPct) * 10000) / 10000;
}

/**
 * Slippage estimate (per round trip, %): grows with ATR% and thins with
 * relative volume + order size vs ADV. Conservative floor 0.10%.
 */
export function estimateSlippagePct(opts: {
  atrPct: number | null;
  relVolume: number | null;
  orderValueInr: number;
  advInr: number | null;
}): number {
  const atr = opts.atrPct ?? 3;
  const rv = Math.max(0.2, Math.min(3, opts.relVolume ?? 1));
  const participation = opts.advInr != null && opts.advInr > 0 ? opts.orderValueInr / opts.advInr : 0.001;
  const impact = Math.min(0.5, participation * 100 * 0.05); // 5bp per 1% of ADV, capped
  const base = 0.05 * atr * (1 / Math.sqrt(rv));
  return Math.round(Math.max(0.1, base + impact) * 10000) / 10000;
}
