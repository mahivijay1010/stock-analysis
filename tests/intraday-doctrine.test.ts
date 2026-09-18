/**
 * docs/intraday-study-notes.md §4 items 1–5 — the five doctrine gaps found by
 * reading Zerodha Varsity (TA module 2, Risk Management module 9) and SEBI's
 * July-2024 intraday study, each now encoded and tested:
 *
 *  1. intraday cost schedule (STT 0.025% sell-only, ₹20/order brokerage cap)
 *  2. hard reward/risk gate at 1.5 (Varsity 18.5/18.6), stops never tightened
 *  3. "S&R more than 4% from the stop ⇒ skip" (Varsity 19.5)
 *  4. risk-per-trade ceiling 3% (Varsity RM 14.1) — controller bound
 *  5. drawdown kill switch fed from the real paper equity curve
 */

import {
  COST_SCHEDULE_2024_10,
  COST_SCHEDULE_INTRADAY_2024_10,
  activeCostSchedule,
  roundTripCostPct,
} from "../src/services/shortterm/costs";
import { GATE_THRESHOLDS } from "../src/services/shortterm/ranking";
import { assessLevels, MAX_STOP_TO_SUPPORT_PCT } from "../src/services/shortterm/plausibility";
import { computeEquityDrawdownPct, assessPortfolioRisk, RISK_LIMITS } from "../src/services/shortterm/sizing";

describe("1. intraday cost schedule", () => {
  test("delivery schedule is unchanged (regression guard)", () => {
    expect(activeCostSchedule().version).toBe(COST_SCHEDULE_2024_10.version);
    expect(activeCostSchedule("DELIVERY_EQUITY").productType).toBe("DELIVERY_EQUITY");
    const pct = roundTripCostPct(100_000);
    expect(pct).toBeGreaterThan(0.2); // 0.1 + 0.1 STT alone
    expect(pct).toBeLessThan(0.5);
  });

  test("intraday schedule: STT sell-side only, no DP charge, non-zero brokerage", () => {
    const v = COST_SCHEDULE_INTRADAY_2024_10.values;
    expect(COST_SCHEDULE_INTRADAY_2024_10.productType).toBe("INTRADAY_EQUITY");
    expect(v.sttPctBuy).toBe(0);
    expect(v.sttPctSell).toBe(0.025);
    expect(v.dpChargeInrPerSellOrder).toBe(0);
    expect(v.brokeragePctPerSide).toBeGreaterThan(0);
    expect(v.brokerageFlatInrPerOrderCap).toBe(20);
    expect(activeCostSchedule("INTRADAY_EQUITY").version).toBe(COST_SCHEDULE_INTRADAY_2024_10.version);
  });

  test("brokerage is min(₹20, 0.03%) per order: pct-bound on small tickets, flat-bound on large", () => {
    const intraday = COST_SCHEDULE_INTRADAY_2024_10;
    // ₹20,000 ticket: 0.03% = ₹6 < ₹20 ⇒ pct applies ⇒ brokerage 0.03%/side.
    const small = roundTripCostPct(20_000, intraday);
    // ₹1,00,00,000 ticket: 0.03% = ₹3,000 > ₹20 ⇒ flat ₹20 applies ⇒ ≈0.0002%/side.
    const large = roundTripCostPct(10_000_000, intraday);
    expect(small).toBeGreaterThan(large);
    // Floor sanity: STT 0.025 + stamp 0.003 + 2×txn ≈ 0.034% is the irreducible percentage part.
    expect(large).toBeGreaterThan(0.03);
    expect(large).toBeLessThan(0.05);
    // Small ticket: 2 × 0.03% brokerage + GST on it dominates.
    expect(small).toBeGreaterThan(0.1);
  });

  test("on a large ticket intraday is cheaper than delivery; on a tiny ticket the flat brokerage bites (SEBI: 79% of <₹5k tickets lose)", () => {
    expect(roundTripCostPct(1_000_000, COST_SCHEDULE_INTRADAY_2024_10)).toBeLessThan(roundTripCostPct(1_000_000));
    // ₹4,000 ticket: 0.03% = ₹1.20 < ₹20, so brokerage is pct-bound at 0.03%/side;
    // 2×0.03% + STT 0.025% + stamp 0.003% + txn + GST ≈ 0.106% — roughly 3× the
    // large-ticket figure, where the ₹20 flat cap shrinks brokerage to ~0.0002%/side.
    const tiny = roundTripCostPct(4_000, COST_SCHEDULE_INTRADAY_2024_10);
    expect(tiny).toBeGreaterThan(0.1);
    expect(tiny).toBeGreaterThan(2.5 * roundTripCostPct(10_000_000, COST_SCHEDULE_INTRADAY_2024_10));
  });
});

describe("2. reward/risk gate", () => {
  test("gate is Varsity's active-trader minimum, 1.5", () => {
    expect(GATE_THRESHOLDS.minRewardRisk1).toBe(1.5);
  });
});

describe("3. stop-to-support 4% rule", () => {
  const base = { entry: 100, target1: 106, atr14: 2, ev: null, gapPctRecent: 0 };

  test("stop within 4% of support is structural", () => {
    const r = assessLevels({ ...base, stop: 96, supportPrice: 96.5 });
    expect(r.stopToSupportPct).toBeCloseTo(0.5, 2);
    expect(r.stopStructural).toBe(true);
    expect(r.reasons.join(" ")).not.toMatch(/nearest support/);
  });

  test("stop more than 4% from support is NOT structural and carries a penalty + reason", () => {
    const r = assessLevels({ ...base, stop: 96, supportPrice: 90 }); // |96−90|/100 = 6%
    expect(r.stopToSupportPct).toBeCloseTo(6, 2);
    expect(r.stopStructural).toBe(false);
    expect(r.qualityPenalty).toBeGreaterThanOrEqual(15);
    expect(r.reasons.join(" ")).toMatch(/nearest support/);
  });

  test("exactly at the 4% threshold passes (rule is strictly greater-than); just over fails", () => {
    // entry 100, stop 96: support at 92 ⇒ |96−92|/100 = 4.00% ⇒ not > 4 ⇒ structural.
    const at = assessLevels({ ...base, stop: 96, supportPrice: 96 - MAX_STOP_TO_SUPPORT_PCT });
    expect(at.stopToSupportPct).toBeCloseTo(MAX_STOP_TO_SUPPORT_PCT, 6);
    expect(at.stopStructural).toBe(true);
    // support at 91.99 ⇒ 4.01% ⇒ fails.
    const over = assessLevels({ ...base, stop: 96, supportPrice: 96 - (MAX_STOP_TO_SUPPORT_PCT + 0.01) });
    expect(over.stopStructural).toBe(false);
  });

  test("no support level known ⇒ rule does not fire (null, not a fabricated pass/fail)", () => {
    const r = assessLevels({ ...base, stop: 96 });
    expect(r.stopToSupportPct).toBeNull();
    expect(r.stopStructural).toBe(true);
  });

  test("noise-stop rule still applies independently", () => {
    const r = assessLevels({ ...base, stop: 99.2, supportPrice: 99.2 }); // 0.4 ATR — inside noise, but at support
    expect(r.stopStructural).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/daily noise/);
  });
});

describe("5. equity drawdown feeds the kill switch", () => {
  test("no history ⇒ 0% drawdown (never fabricated)", () => {
    expect(computeEquityDrawdownPct(100_000, [])).toBe(0);
  });

  test("non-positive budget ⇒ null", () => {
    expect(computeEquityDrawdownPct(0, [100])).toBeNull();
  });

  test("measures current equity against the running peak, not the start", () => {
    // 100k → +10k (110k peak) → −5.5k → 104.5k ⇒ −5% from peak (not +4.5% from start)
    expect(computeEquityDrawdownPct(100_000, [10_000, -5_500])).toBeCloseTo(-5, 2);
  });

  test("recovering to a new high resets drawdown to 0", () => {
    expect(computeEquityDrawdownPct(100_000, [-3_000, 5_000])).toBe(0);
  });

  test("ignores non-finite entries", () => {
    expect(computeEquityDrawdownPct(100_000, [NaN, -6_000])).toBeCloseTo(-6, 2);
  });

  test("a real drawdown beyond the limit now disables new entries via the risk manager", () => {
    const dd = computeEquityDrawdownPct(100_000, [-(RISK_LIMITS.drawdownKillSwitchPct * 1000 + 100)]); // just past −6%
    expect(dd).toBeLessThan(-RISK_LIMITS.drawdownKillSwitchPct);
    const v = assessPortfolioRisk({ budgetInr: 100_000, openPositions: [], realizedTodayInr: 0, realizedWeekInr: 0, equityDrawdownPct: dd });
    expect(v.newEntriesAllowed).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/drawdown kill switch/);
  });
});
