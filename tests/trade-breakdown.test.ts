/**
 * computeTradeBreakdown — the prediction audit's shared closed-trade formula.
 * These assertions are PRESERVED from the archived execution-analytics suite
 * (upgrade-audit §3 row 1: "keep TradeBreakdown assertions") because the
 * math is still consumed by the keeper AdminService.getPredictionAudit.
 */
import { computeTradeBreakdown } from "../src/services/admin/tradeBreakdown";

describe("computeTradeBreakdown — the audit's shared formula", () => {
  it("expectancy = winRate×avgWin − (1−winRate)×avgLoss, rounded to 2dp", () => {
    // 3 wins avg 100, 2 losses avg 50 → 0.6×100 − 0.4×50 = 40.00
    const b = computeTradeBreakdown([100, 100, 100, -50, -50]);
    expect(b).not.toBeNull();
    expect(b!.winRate).toBeCloseTo(0.6, 12);
    expect(b!.avgWin).toBeCloseTo(100, 12);
    expect(b!.avgLoss).toBeCloseTo(50, 12);
    expect(b!.expectancy).toBe(40);
  });

  it("pnl of exactly 0 counts as a loss (audit convention p ≤ 0)", () => {
    const b = computeTradeBreakdown([10, 0]);
    expect(b!.wins).toBe(1);
    expect(b!.losses).toBe(1);
    expect(b!.avgLoss).toBe(0);
  });

  it("returns null on an empty list so callers state the honest story", () => {
    expect(computeTradeBreakdown([])).toBeNull();
  });
});
