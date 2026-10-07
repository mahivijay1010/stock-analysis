/**
 * Layer-0 truth: liquidity profile + tradeability hard-gate. These pin the
 * Part-1 realities as CODE: median daily VALUE (not shares) drives sizing, a
 * tight circuit band and surveillance are HARD blocks (no score can override
 * them), delivery trend is descriptive, and days-to-exit is honest.
 */

import { computeLiquidityProfile, LiquidityDailyRow, MAX_PARTICIPATION } from "../src/services/shortterm/liquidityProfile";
import { checkTradeabilityGate, TRADEABILITY_RULES } from "../src/services/shortterm/tradeabilityGate";

function series(opts: { n: number; close: number; movePct?: number; turnoverLacs?: number; delivPct?: number; trades?: number }): LiquidityDailyRow[] {
  const rows: LiquidityDailyRow[] = [];
  let c = opts.close;
  for (let i = 0; i < opts.n; i++) {
    if (opts.movePct != null && i > 0) c = c * (1 + (i % 2 ? opts.movePct : -opts.movePct) / 100);
    rows.push({ date: `2026-0${1 + (i % 9)}-0${1 + (i % 9)}`, close: Math.round(c * 100) / 100, turnoverLacs: opts.turnoverLacs ?? 300, trades: opts.trades ?? 2000, delivPct: opts.delivPct ?? 40 });
  }
  return rows;
}

describe("computeLiquidityProfile", () => {
  test("median daily VALUE is turnover×₹1L, and days-to-exit follows participation", () => {
    const p = computeLiquidityProfile(series({ n: 60, close: 50, turnoverLacs: 500 })); // ₹5cr/day
    expect(p.medianDailyValueInr20d).toBe(50_000_000);
    // ₹1cr at 10% participation of ₹5cr/day ⇒ 1cr / (0.1×5cr) = 0.2 days.
    expect(p.daysToExitAt1crore).toBeCloseTo(1e7 / (MAX_PARTICIPATION * 5e7), 2);
  });

  test("a stock that never moves beyond ~5% is inferred to be on a 5% band", () => {
    const p = computeLiquidityProfile(series({ n: 60, close: 40, movePct: 4.8 }));
    expect(p.maxDailyMovePct60d).toBeLessThanOrEqual(5.6);
    expect(p.inferredCircuitBandPct).toBe(5);
  });

  test("a freely-moving stock infers no tight band", () => {
    const p = computeLiquidityProfile(series({ n: 60, close: 40, movePct: 14 }));
    expect(p.inferredCircuitBandPct).toBe(20);
  });

  test("delivery divergence = recent 5d minus 20d (accumulation signal)", () => {
    const rows = [...series({ n: 15, close: 30, delivPct: 20 }), ...series({ n: 5, close: 31, delivPct: 50 })];
    const p = computeLiquidityProfile(rows);
    expect(p.deliveryDivergencePp).toBeGreaterThan(0); // last 5d delivery well above the 20d mean
  });

  test("empty history yields a safe null profile, never a crash", () => {
    const p = computeLiquidityProfile([]);
    expect(p.medianDailyValueInr20d).toBeNull();
    expect(p.daysToExitAt1crore).toBeNull();
    expect(p.inferredCircuitBandPct).toBeNull();
  });
});

describe("checkTradeabilityGate — hard gates, not features", () => {
  const healthy = {
    surveillanceCodes: [] as string[],
    series: "EQ",
    medianDailyValueInr20d: 50_000_000,
    inferredCircuitBandPct: 20 as 5 | 10 | 20 | null,
    daysToExitAt1crore: 0.2,
    delivPct20d: 45,
    bigMoveDays20d: 0,
  };

  test("a clean, liquid, free-moving stock is tradeable with no blocks", () => {
    const v = checkTradeabilityGate(healthy);
    expect(v.tradeable).toBe(true);
    expect(v.hardBlocks).toHaveLength(0);
  });

  test("ANY surveillance code is a hard block", () => {
    const v = checkTradeabilityGate({ ...healthy, surveillanceCodes: ["GSM - IV (4)"] });
    expect(v.tradeable).toBe(false);
    expect(v.hardBlocks.join(" ")).toMatch(/surveillance/);
  });

  test("a trade-for-trade (BE) series is a hard block", () => {
    const v = checkTradeabilityGate({ ...healthy, series: "BE" });
    expect(v.tradeable).toBe(false);
    expect(v.hardBlocks.join(" ")).toMatch(/BE/);
  });

  test("illiquidity below the ₹50L floor is a hard block", () => {
    const v = checkTradeabilityGate({ ...healthy, medianDailyValueInr20d: TRADEABILITY_RULES.minMedianDailyValueInr - 1 });
    expect(v.tradeable).toBe(false);
    expect(v.hardBlocks.join(" ")).toMatch(/illiquid/);
  });

  test("a 5% circuit band is a hard block (cannot exit at stop)", () => {
    const v = checkTradeabilityGate({ ...healthy, inferredCircuitBandPct: 5 });
    expect(v.tradeable).toBe(false);
    expect(v.hardBlocks.join(" ")).toMatch(/5% circuit/);
  });

  test("thin-but-tradeable, low delivery and slow exit are WARNINGS, not blocks", () => {
    const v = checkTradeabilityGate({ ...healthy, medianDailyValueInr20d: 8_000_000, delivPct20d: 12, daysToExitAt1crore: 9 });
    expect(v.tradeable).toBe(true);
    expect(v.warnings.join(" ")).toMatch(/thin/);
    expect(v.warnings.join(" ")).toMatch(/delivery 12%/);
    expect(v.warnings.join(" ")).toMatch(/days to exit/);
  });
});
