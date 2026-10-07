/**
 * Paper portfolio decision engine — the integration of the whole risk stack
 * into order decisions. These pin that the circuit breaker and CRISIS regime
 * block ALL entries, that regime caps size and restricts setups, that sizing
 * respects fixed-risk when there's no calibrated p, that portfolio caps reject
 * an over-concentrated add, and that geometry/affordability are enforced.
 */

import { decidePaperOrders, markToMarket, fillSlippageBps, PaperCandidate, OpenPosition } from "../src/services/shortterm/paperPortfolio";

function noise(seed: number, n = 60): number[] {
  const out: number[] = [];
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out.push(((s / 0x7fffffff) * 2 - 1) * 0.02);
  }
  return out;
}

const cand = (over: Partial<PaperCandidate>): PaperCandidate => ({
  ticker: "A.NS",
  sector: "Power",
  setupType: "PULLBACK",
  entry: 50,
  stop: 47,
  target1: 58,
  rewardToRisk: 2.67,
  pWin: null,
  convictionScore: 45,
  tradeabilityBlocked: false,
  returns: noise(1),
  ...over,
});

describe("decidePaperOrders — composing the risk stack", () => {
  const base = { cashInr: 100000, capitalInr: 100000, openPositions: [] as OpenPosition[], regime: "TREND_UP" as string | null, breakerCanEnter: true };

  test("the circuit breaker blocks EVERY entry", () => {
    const plan = decidePaperOrders({ ...base, candidates: [cand({})], breakerCanEnter: false });
    expect(plan.breakerBlocked).toBe(true);
    expect(plan.orders).toHaveLength(0);
    expect(plan.rejected[0].reasons[0]).toMatch(/circuit breaker/);
  });

  test("CRISIS regime turns new entries off entirely", () => {
    const plan = decidePaperOrders({ ...base, candidates: [cand({})], regime: "CRISIS" });
    expect(plan.orders).toHaveLength(0);
    expect(plan.regimeSizeMultiplier).toBe(0);
    expect(plan.rejected[0].reasons[0]).toMatch(/new entries off/);
  });

  test("a clean candidate in a benign regime produces a risk-sized order", () => {
    const plan = decidePaperOrders({ ...base, candidates: [cand({})] });
    expect(plan.orders).toHaveLength(1);
    const o = plan.orders[0];
    // fixed risk 0.5% of ₹100k = ₹500 over ₹3/share ⇒ ~166 shares, capped by cash.
    expect(o.qty).toBeGreaterThan(0);
    expect(o.riskInr).toBeLessThanOrEqual(500 + 3); // ~ one share of rounding
    expect(o.sizingBasis).toMatch(/fixed risk/i);
  });

  test("invalid geometry and tradeability blocks are rejected with reasons", () => {
    const plan = decidePaperOrders({
      ...base,
      candidates: [cand({ ticker: "BAD.NS", stop: 55 }), cand({ ticker: "BLK.NS", tradeabilityBlocked: true })],
    });
    expect(plan.orders).toHaveLength(0);
    expect(plan.rejected.find((r) => r.ticker === "BAD.NS")!.reasons[0]).toMatch(/geometry/);
    expect(plan.rejected.find((r) => r.ticker === "BLK.NS")!.reasons[0]).toMatch(/not tradeable/);
  });

  test("CHOPPY regime rejects a breakout (mean-reversion only)", () => {
    const plan = decidePaperOrders({ ...base, regime: "CHOPPY", candidates: [cand({ setupType: "BREAKOUT", convictionScore: 60 })] });
    expect(plan.orders).toHaveLength(0);
    expect(plan.rejected[0].reasons[0]).toMatch(/not allowed/);
  });

  test("portfolio single-stock cap rejects an over-sized add", () => {
    // Force a huge position via a tiny per-share risk so qty×entry blows the 10% cap.
    const plan = decidePaperOrders({
      ...base,
      candidates: [cand({ entry: 50, stop: 49.99, target1: 60, convictionScore: 60 })],
      config: { maxRiskPctPerTrade: 5, fixedRiskPct: 5, limits: { ...{ maxSingleStockPct: 10, maxSectorPct: 30, maxPortfolioCvar95Pct: 8, correlationThreshold: 0.7 } } },
    });
    // A ₹0.01 per-share risk ⇒ enormous qty ⇒ value far beyond 10% of capital ⇒ rejected.
    expect(plan.orders).toHaveLength(0);
    expect(plan.rejected[0].reasons.join(" ")).toMatch(/capital|cap 10/);
  });

  test("conviction below the regime-adjusted bar is rejected", () => {
    const plan = decidePaperOrders({ ...base, regime: "TREND_DOWN", candidates: [cand({ setupType: "MOMENTUM", convictionScore: 35 })], config: { minConvictionToAct: 30 } });
    // TREND_DOWN adds +10 ⇒ needs 40; 35 < 40.
    expect(plan.orders).toHaveLength(0);
    expect(plan.rejected[0].reasons[0]).toMatch(/conviction 35 < 40/);
  });
});

describe("accounting", () => {
  test("markToMarket sums cash + market value and unrealized P&L", () => {
    const pos: OpenPosition[] = [{ ticker: "A.NS", sector: "S", qty: 100, entryPrice: 50, valueInr: 5000, returns: [] }];
    const eq = markToMarket(pos, new Map([["A.NS", 55]]), 95000);
    expect(eq.deployedInr).toBe(5500);
    expect(eq.equityInr).toBe(100500);
    expect(eq.unrealizedPnlInr).toBe(500);
  });

  test("fillSlippageBps measures intended vs actual in bps", () => {
    expect(fillSlippageBps(100, 100.5)).toBe(50); // paid 0.5% more
    expect(fillSlippageBps(100, 99.8)).toBe(-20); // filled better
  });
});
