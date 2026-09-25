/**
 * TradeEconomics — the deterministic arithmetic around a trade. These tests
 * hand-compute the statutory charges so the module's rupee math is verified
 * against the schedules, not against itself. Outcomes stay SCENARIOS: the
 * module never emits a probability, and that is asserted too.
 */

import { computeCharges, computeTax, computeTradeEconomics, breakevenExitPrice, TAX_SCHEDULE_2024_07 } from "../src/services/decision/tradeEconomics";
import { activeCostSchedule } from "../src/services/shortterm/costs";

describe("computeCharges — exact statutory math (delivery)", () => {
  const s = activeCostSchedule("DELIVERY_EQUITY");
  test("100 shares bought at ₹1000, sold at ₹1100 — hand-computed legs", () => {
    const c = computeCharges(100, 1000, 1100, s);
    // buyValue 1,00,000; sellValue 1,10,000; turnover 2,10,000
    expect(c.brokerage).toBe(0); // discount delivery
    expect(c.stt).toBe(210); // 0.1% × 210000
    expect(c.exchangeTxn).toBeCloseTo(6.24, 2); // 0.00297% × 210000
    expect(c.sebiFees).toBeCloseTo(0.21, 2); // 0.0001% × 210000
    expect(c.stampDuty).toBe(15); // 0.015% × 100000 (buy only)
    expect(c.gst).toBeCloseTo(0.18 * (0 + 6.237 + 0.21), 2); // 18% on brokerage+txn+sebi
    expect(c.dpCharge).toBe(15.93);
    expect(c.total).toBeCloseTo(210 + 6.24 + 0.21 + 15 + 1.16 + 15.93, 1);
  });
  test("intraday: brokerage capped at ₹20/order and STT only on sell", () => {
    const si = activeCostSchedule("INTRADAY_EQUITY");
    const c = computeCharges(1000, 500, 505, si); // orders of 5L / 5.05L
    expect(c.brokerage).toBe(40); // ₹20+₹20 (0.03% would be ₹150+₹151.5)
    expect(c.stt).toBeCloseTo(126.25, 2); // 0.025% × 505000, sell only
    expect(c.dpCharge).toBe(0); // nothing leaves the demat
  });
});

describe("computeTax — Indian CG schedule in force since 2024-07-23", () => {
  test("STCG: delivery held ≤ 365 days ⇒ 20% + 4% cess", () => {
    const { taxInr, basis } = computeTax({ netGainInr: 10000, productType: "DELIVERY_EQUITY", holdingPeriodDays: 30, slabRatePct: 30, ltcgExemptionRemainingInr: 0 });
    expect(taxInr).toBe(2080); // 2000 + 4% cess
    expect(basis).toContain("STCG");
  });
  test("LTCG: > 365 days ⇒ 12.5% + cess, only above the UNUSED exemption", () => {
    const { taxInr } = computeTax({ netGainInr: 200000, productType: "DELIVERY_EQUITY", holdingPeriodDays: 400, slabRatePct: 30, ltcgExemptionRemainingInr: TAX_SCHEDULE_2024_07.ltcgAnnualExemptionInr });
    expect(taxInr).toBe(9750); // 12.5% × 75000 × 1.04
    // Exemption is NEVER silently assumed: with none remaining, the full gain is taxed.
    const none = computeTax({ netGainInr: 200000, productType: "DELIVERY_EQUITY", holdingPeriodDays: 400, slabRatePct: 30, ltcgExemptionRemainingInr: 0 });
    expect(none.taxInr).toBe(26000); // 12.5% × 200000 × 1.04
  });
  test("intraday gain ⇒ slab rate as speculative business income", () => {
    const { taxInr, basis } = computeTax({ netGainInr: 10000, productType: "INTRADAY_EQUITY", holdingPeriodDays: 0, slabRatePct: 30, ltcgExemptionRemainingInr: 0 });
    expect(taxInr).toBe(3120); // 30% + cess
    expect(basis).toContain("speculative");
  });
  test("a loss owes zero tax and says why", () => {
    const { taxInr, basis } = computeTax({ netGainInr: -5000, productType: "DELIVERY_EQUITY", holdingPeriodDays: 30, slabRatePct: 30, ltcgExemptionRemainingInr: 0 });
    expect(taxInr).toBe(0);
    expect(basis).toContain("loss");
  });
});

describe("computeTradeEconomics — the full picture", () => {
  const base = { entryPrice: 1000, stopPrice: 950, targetPrice: 1100, budgetInr: 200000, riskPerTradePct: 1 };

  test("quantity is RISK-based (never budget/price) and loss at stop ≤ risk budget", () => {
    const t = computeTradeEconomics(base);
    // risk ₹2000 over ₹50/share price risk ⇒ ≤40 shares; cost-inclusive is fewer.
    expect(t.quantity).toBeGreaterThan(0);
    expect(t.quantity).toBeLessThanOrEqual(40);
    expect(t.riskAmountInr).toBe(2000);
    expect(Math.abs(t.lossAtStopInr!)).toBeLessThanOrEqual(t.riskAmountInr);
    expect(t.capitalRequiredInr).toBe(t.quantity * 1000);
    expect(t.lotSize).toBe(1); // cash equity trades in single shares
  });

  test("scenarios carry exact charges + tax; no probability appears anywhere", () => {
    const t = computeTradeEconomics(base);
    const win = t.scenarios.find((s) => s.scenario === "TARGET_HIT")!;
    const lose = t.scenarios.find((s) => s.scenario === "STOP_HIT")!;
    expect(win.netAfterTaxInr).toBeLessThan(win.netBeforeTaxInr); // tax deducted on the gain
    expect(win.taxBasis).toContain("STCG");
    expect(lose.taxInr).toBe(0);
    expect(lose.netAfterTaxInr).toBe(lose.netBeforeTaxInr);
    // Scenarios, never forecasts: no probability FIELD exists anywhere in the
    // data (the prose notes may mention the word — to say none is stated).
    const { notes: _notes, ...data } = t;
    expect(JSON.stringify(data)).not.toMatch(/probabilit/i);
  });

  test("breakeven exit nets exactly ~zero after all charges", () => {
    const t = computeTradeEconomics(base);
    const s = activeCostSchedule("DELIVERY_EQUITY");
    const be = breakevenExitPrice(t.quantity, 1000, s);
    const netAtBe = t.quantity * (be - 1000) - computeCharges(t.quantity, 1000, be, s).total;
    expect(Math.abs(netAtBe)).toBeLessThan(1); // within ₹1
    expect(t.breakevenPrice).toBeGreaterThan(1000); // costs mean breakeven > entry
  });

  test("invalid geometry is refused, never silently sized", () => {
    expect(() => computeTradeEconomics({ ...base, stopPrice: 1001 })).toThrow(/stopPrice/);
    expect(() => computeTradeEconomics({ ...base, targetPrice: 999 })).toThrow(/targetPrice/);
    expect(() => computeTradeEconomics({ ...base, budgetInr: 0 })).toThrow(/budget/);
  });

  test("a budget too small to risk one share reports the constraint honestly", () => {
    const t = computeTradeEconomics({ entryPrice: 3000, stopPrice: 2999.5, targetPrice: 3100, budgetInr: 4000, riskPerTradePct: 0.01 });
    expect(t.quantity).toBe(0);
    expect(t.sizingConstraints.join(" ")).toMatch(/cannot afford/);
    expect(t.scenarios).toHaveLength(0); // no fabricated P&L for a trade that can't exist
  });
});
