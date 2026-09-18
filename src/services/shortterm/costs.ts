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

// ── Fill-ratio slippage model (docs/tsp-study-notes.md §1.1, §4 item 1) ──────
//
// The percentage model above cannot be checked against reality: its constants
// (0.05 × ATR%, 1/√relVolume, 5bp per 1% of ADV, the 0.10% floor) were invented,
// and nothing observable maps onto them. docs/system-trust-review.md §8 flags
// that as the weakest calibrated area in the system.
//
// Seykota's TSP "Skid and Trading Frequency" study (Stone) models a stop fill
// instead as a FRACTION OF THE BAR'S ADVERSE EXCURSION BEYOND THE STOP:
//
//     fill(buy / cover short) = stop + (high − stop) × ratio
//     fill(sell / short)      = stop − (stop − low)  × ratio
//
// ratio 0 = a perfect fill at the stop; ratio 1 = the worst price the bar
// printed after the level was breached. The virtue is that every term is
// OBSERVABLE — stop, high, low and the achieved fill are all recorded — so the
// ratio can be MEASURED from real fills instead of assumed. That is what makes
// calibration possible at all.
//
// This is deliberately ADDITIVE. Nothing in the pipeline switches to it until
// it has been calibrated against real Upstox fills; importing the futures
// study's own numbers into Indian equities would be exactly the
// unvalidated-threshold mistake the trust review exists to prevent.

/** Perfect fill at the stop — the optimistic bound. */
export const SLIPPAGE_RATIO_BEST = 0;
/** Worst price printed in the breaching bar — the pessimistic bound. */
export const SLIPPAGE_RATIO_WORST = 1;
/**
 * Placeholder used ONLY by the stress sweep's mid case. It is a guess, is
 * labelled as one everywhere it appears, and must be replaced by a measured
 * value before any number derived from it is trusted.
 */
export const SLIPPAGE_RATIO_UNCALIBRATED_MID = 0.5;

export type FillSide = "BUY" | "SELL";

/**
 * Fill price for a stop that was breached inside a bar. PURE.
 *
 * `side` is the direction of the ORDER being filled: a long's protective stop
 * is a SELL, a stop-entry into a long is a BUY. Slippage always works against
 * the trader, so BUY fills at or above the stop and SELL at or below it.
 *
 * Returns null when the bar could not have filled the order (the level was
 * never reached) or the inputs are not finite — never a fabricated price.
 */
export function fillPriceFromRatio(opts: {
  side: FillSide;
  stop: number;
  barHigh: number;
  barLow: number;
  ratio: number;
}): number | null {
  const { side, stop, barHigh, barLow, ratio } = opts;
  if (![stop, barHigh, barLow, ratio].every((v) => Number.isFinite(v))) return null;
  if (!(barHigh >= barLow) || !(stop > 0)) return null;
  const r = Math.min(SLIPPAGE_RATIO_WORST, Math.max(SLIPPAGE_RATIO_BEST, ratio));

  if (side === "BUY") {
    if (barHigh < stop) return null; // never traded up to the level
    return stop + (barHigh - stop) * r;
  }
  if (barLow > stop) return null; // never traded down to the level
  return stop - (stop - barLow) * r;
}

/**
 * Recover the realised slippage ratio from an ACHIEVED fill. PURE — this is
 * the calibration primitive: run it over real fills and the distribution of
 * ratios is the empirical slippage model, replacing today's invented one.
 *
 * Returns null when the bar offers no adverse excursion to normalise against
 * (high == stop for a buy), because the ratio is undefined there rather than 0.
 */
export function slippageRatioFromFill(opts: {
  side: FillSide;
  stop: number;
  barHigh: number;
  barLow: number;
  actualFill: number;
}): number | null {
  const { side, stop, barHigh, barLow, actualFill } = opts;
  if (![stop, barHigh, barLow, actualFill].every((v) => Number.isFinite(v))) return null;
  if (!(barHigh >= barLow)) return null;

  const excursion = side === "BUY" ? barHigh - stop : stop - barLow;
  if (!(excursion > 0)) return null; // no adverse room in this bar ⇒ undefined
  const slip = side === "BUY" ? actualFill - stop : stop - actualFill;
  // A better-than-stop fill clamps to 0 rather than reporting negative slippage.
  return Math.min(SLIPPAGE_RATIO_WORST, Math.max(SLIPPAGE_RATIO_BEST, slip / excursion));
}

/**
 * Express a fill ratio as a percentage of the entry price, so it can be
 * compared against — or eventually replace — estimateSlippagePct. PURE.
 * Per-side, not round trip.
 */
export function ratioToSlippagePct(opts: {
  side: FillSide;
  stop: number;
  barHigh: number;
  barLow: number;
  ratio: number;
  referencePrice: number;
}): number | null {
  const fill = fillPriceFromRatio(opts);
  if (fill == null || !(opts.referencePrice > 0)) return null;
  const slip = opts.side === "BUY" ? fill - opts.stop : opts.stop - fill;
  return Math.round((slip / opts.referencePrice) * 100 * 10000) / 10000;
}
