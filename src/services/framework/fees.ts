/**
 * Indian equity DELIVERY fee model (Module V2-C) — discount-broker style,
 * all constants in this one file per the V2 spec:
 *
 *   - Brokerage:            ₹0 per side (discount broker, delivery)
 *   - STT:                  0.1% of turnover on EACH side
 *   - Exchange + SEBI + stamp: ≈ 0.0157% buy / 0.0107% sell (approximation —
 *     NSE txn 0.00297% + SEBI 0.0001% + stamp 0.015% buy-only ≈ these rates)
 *   - DP charge:            ₹15.93 flat per SELL execution (₹13.5 + 18% GST,
 *     already GST-inclusive — no further GST applied to it)
 *   - GST:                  18% on the exchange/SEBI charge component
 *     (STT and stamp duty do not attract GST)
 *
 * Reality check: on a ₹1,000 position the round trip is ≈ ₹18-19 (~1.9%),
 * which is why small positions are fee-inefficient and ALWAYS flagged.
 */

export const DELIVERY_FEE_MODEL = {
  brokeragePerSide: 0, // ₹, discount broker delivery
  sttRate: 0.001, // 0.1% of turnover, each side
  buyChargesRate: 0.000157, // exchange + SEBI + stamp, buy side (≈0.0157%)
  sellChargesRate: 0.000107, // exchange + SEBI, sell side (≈0.0107%)
  dpChargeOnSell: 15.93, // ₹ flat per sell execution, GST-inclusive
  gstRate: 0.18, // on exchange/SEBI charges (not on STT/stamp/DP)
} as const;

function round2(x: number): number {
  const r = Math.round(x * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

/** Total buy-side fees for a given buy turnover (₹). Linear in turnover. */
export function estimateBuyFees(buyTurnover: number): number {
  if (!(buyTurnover > 0)) return 0;
  const m = DELIVERY_FEE_MODEL;
  const stt = buyTurnover * m.sttRate;
  const charges = buyTurnover * m.buyChargesRate;
  return round2(m.brokeragePerSide + stt + charges * (1 + m.gstRate));
}

/** Total sell-side fees for a given sell turnover (₹), incl. flat DP charge. */
export function estimateSellFees(sellTurnover: number): number {
  if (!(sellTurnover > 0)) return 0;
  const m = DELIVERY_FEE_MODEL;
  const stt = sellTurnover * m.sttRate;
  const charges = sellTurnover * m.sellChargesRate;
  return round2(
    m.brokeragePerSide + stt + charges * (1 + m.gstRate) + m.dpChargeOnSell
  );
}

export interface RoundTripFees {
  perSide: number; // average of buy and sell side fees
  buySide: number;
  sellSide: number;
  roundTrip: number;
  roundTripPct: number; // % of the position turnover (0 when turnover is 0)
  note: string;
}

/** Full round-trip fee estimate for a position of the given turnover (₹). */
export function estimateRoundTripFees(turnover: number): RoundTripFees {
  const buySide = estimateBuyFees(turnover);
  const sellSide = estimateSellFees(turnover);
  const roundTrip = round2(buySide + sellSide);
  const roundTripPct = turnover > 0 ? round2((roundTrip / turnover) * 100) : 0;
  const note =
    turnover > 0
      ? `Delivery fee model: ₹0 brokerage, 0.1% STT each side, ` +
        `~0.0157%/0.0107% exchange+SEBI+stamp (buy/sell, +18% GST on charges), ` +
        `₹${DELIVERY_FEE_MODEL.dpChargeOnSell.toFixed(2)} flat DP charge on sell. ` +
        `Buy side ₹${buySide.toFixed(2)}, sell side ₹${sellSide.toFixed(2)}, ` +
        `round trip ₹${roundTrip.toFixed(2)} = ${roundTripPct.toFixed(2)}% of the position.`
      : "No shares purchasable at this amount — fee estimate not applicable (₹0).";
  return {
    perSide: round2(roundTrip / 2),
    buySide,
    sellSide,
    roundTrip,
    roundTripPct,
    note,
  };
}
