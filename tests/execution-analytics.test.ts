/**
 * V9 E1/E2 — execution-analytics math tests (SPEC_V9 gates):
 *   1. measuredP is computed over the LAST-30 window ONLY,
 *   2. measuredB needs BOTH wins and losses,
 *   3. zero losses → usableB:false with the exact spec reason,
 *   4. the applied-pair selection matrix,
 * plus the audit-shared expectancy formula and the adapted-Kelly hand checks
 * used by the live verification (p=0.5333, b=1.5 → f*=0.2222, half=0.1111).
 */

import {
  computeExecutionStats,
  computeTradeBreakdown,
  selectAppliedPair,
  EXECUTION_WINDOW_SIZE,
  MIN_TRADES_FOR_MEASURED_B,
  MIN_TRADES_FOR_MEASURED_P,
  NO_LOSSES_REASON,
  STRUCTURAL_PAYOFF_B,
} from "../src/services/admin/executionStats";
import { computeKelly } from "../src/services/quant/kelly";

/** newest-first P&L list: 16 wins of +15 then 14 losses of −10 (the window), then older tail. */
const WINDOW_16W_14L = [
  ...Array(16).fill(15),
  ...Array(14).fill(-10),
];

describe("computeExecutionStats — window math (p over the last 30 only)", () => {
  it("ignores trades older than the window: 5 huge old losses never touch p or b", () => {
    // 35 closed total; the newest 30 are 16 wins (+15) / 14 losses (−10);
    // the 5 OLDEST are −500 each. If the window leaked, p would be 16/35
    // and avgLoss would explode.
    const pnlsNewestFirst = [...WINDOW_16W_14L, -500, -500, -500, -500, -500];
    const s = computeExecutionStats(pnlsNewestFirst, 35);

    expect(s.closedTrades).toBe(35);
    expect(s.window).toEqual({ size: EXECUTION_WINDOW_SIZE, used: 30 });
    expect(s.wins).toBe(16);
    expect(s.losses).toBe(14);
    expect(s.measuredP).toBeCloseTo(16 / 30, 12); // 0.5333…, NOT 16/35 = 0.4571
    expect(s.measuredP).not.toBeCloseTo(16 / 35, 3);
    expect(s.avgWin).toBeCloseTo(15, 12);
    expect(s.avgLoss).toBeCloseTo(10, 12); // −500s excluded
    expect(s.measuredB).toBeCloseTo(1.5, 12);
    expect(s.usableP).toBe(true); // 35 ≥ 30 closed
    expect(s.usableB).toBe(true); // 30 in window ≥ 10, both sides
    // expectancy over the WINDOW: 16/30×15 − 14/30×10 = 8 − 4.6667 = 3.33
    expect(s.expectancy).toBe(3.33);
  });

  it("p is computable below 30 closed but NOT usable (model p applies until 30)", () => {
    const s = computeExecutionStats([12, -8, 20, -5], 4);
    expect(s.measuredP).toBeCloseTo(0.5, 12);
    expect(s.usableP).toBe(false);
    expect(s.reasons.join(" ")).toContain("only 4 closed trades");
    expect(s.reasons.join(" ")).toContain("model p applies");
  });

  it("usableP flips exactly at 30 total closed trades", () => {
    const window = [...Array(15).fill(10), ...Array(15).fill(-10)];
    expect(computeExecutionStats(window, 29).usableP).toBe(false);
    expect(computeExecutionStats(window, 30).usableP).toBe(true);
    expect(MIN_TRADES_FOR_MEASURED_P).toBe(30);
  });

  it("empty history: everything null/false with an honest reason", () => {
    const s = computeExecutionStats([], 0);
    expect(s.closedTrades).toBe(0);
    expect(s.window.used).toBe(0);
    expect(s.measuredP).toBeNull();
    expect(s.measuredB).toBeNull();
    expect(s.expectancy).toBeNull();
    expect(s.usableP).toBe(false);
    expect(s.usableB).toBe(false);
    expect(s.reasons.length).toBeGreaterThan(0);
    expect(s.reasons.join(" ")).toContain("no closed trades yet");
  });
});

describe("computeExecutionStats — b needs both sides", () => {
  it("zero losses → measuredB null, usableB false, EXACT spec reason", () => {
    const s = computeExecutionStats(Array(35).fill(25), 35);
    expect(s.measuredB).toBeNull();
    expect(s.usableB).toBe(false);
    expect(s.reasons).toContain(NO_LOSSES_REASON);
    expect(NO_LOSSES_REASON).toBe(
      "no losing trades yet — payoff unmeasurable, still using structural 1.5"
    );
    // p is still measured (35 ≥ 30) — only b falls back.
    expect(s.usableP).toBe(true);
    expect(s.measuredP).toBe(1);
  });

  it("zero wins → measuredB null, usableB false, honest reason", () => {
    const s = computeExecutionStats(Array(12).fill(-10), 12);
    expect(s.measuredB).toBeNull();
    expect(s.usableB).toBe(false);
    expect(s.reasons.join(" ")).toContain("no winning trades");
    expect(s.reasons.join(" ")).toContain("structural 1.5");
  });

  it("both sides but fewer than 10 in the window → value present, usable false", () => {
    const s = computeExecutionStats([20, 20, -10, -10], 4);
    expect(s.measuredB).toBeCloseTo(2, 12);
    expect(s.usableB).toBe(false);
    expect(s.reasons.join(" ")).toContain(`≥${MIN_TRADES_FOR_MEASURED_B}`);
  });

  it("usableB flips at 10 in-window trades with both sides", () => {
    const nine = [...Array(5).fill(10), ...Array(4).fill(-5)];
    const ten = [...Array(5).fill(10), ...Array(5).fill(-5)];
    expect(computeExecutionStats(nine, 9).usableB).toBe(false);
    expect(computeExecutionStats(ten, 10).usableB).toBe(true);
    expect(computeExecutionStats(ten, 10).measuredB).toBeCloseTo(2, 12);
  });

  it("losses that average exactly ₹0 cannot define b (no division by zero)", () => {
    const s = computeExecutionStats([...Array(8).fill(10), 0, 0], 10);
    expect(s.losses).toBe(2); // pnl ≤ 0 counts as a loss (audit convention)
    expect(s.measuredB).toBeNull();
    expect(s.usableB).toBe(false);
    expect(s.reasons.join(" ")).toContain("average ₹0");
  });
});

describe("selectAppliedPair — the E2 selection matrix", () => {
  const MODEL_P = 0.51;

  it("usableP && usableB → measured-p+measured-b", () => {
    const sel = selectAppliedPair(
      { usableP: true, usableB: true, measuredP: 0.6, measuredB: 2 },
      MODEL_P
    );
    expect(sel).toEqual({ p: 0.6, b: 2, applied: "measured-p+measured-b" });
  });

  it("!usableP && usableB → model-p+measured-b", () => {
    const sel = selectAppliedPair(
      { usableP: false, usableB: true, measuredP: 0.75, measuredB: 1.8 },
      MODEL_P
    );
    expect(sel).toEqual({ p: MODEL_P, b: 1.8, applied: "model-p+measured-b" });
  });

  it("!usableP && !usableB → model-p+structural-b (V8 pair, bit-identical)", () => {
    const sel = selectAppliedPair(
      { usableP: false, usableB: false, measuredP: null, measuredB: null },
      MODEL_P
    );
    expect(sel).toEqual({
      p: MODEL_P,
      b: STRUCTURAL_PAYOFF_B,
      applied: "model-p+structural-b",
    });
  });

  it("usableP && !usableB (≥30 closed, no losses in window) → measured-p+structural-b", () => {
    const sel = selectAppliedPair(
      { usableP: true, usableB: false, measuredP: 1, measuredB: null },
      MODEL_P
    );
    expect(sel).toEqual({
      p: 1,
      b: STRUCTURAL_PAYOFF_B,
      applied: "measured-p+structural-b",
    });
  });

  it("end-to-end: stats → selection → Kelly (the live-verification hand check)", () => {
    // Same synthetic set the live gate seeds: 16×(+15), 14×(−10) in-window,
    // 5×(−500) older. p = 0.5333, b = 1.5:
    //   f* = p − (1−p)/b = 0.533333 − 0.466667/1.5 = 0.222222
    //   half-Kelly = 0.111111 → 11.11% of capital.
    const stats = computeExecutionStats(
      [...WINDOW_16W_14L, -500, -500, -500, -500, -500],
      35
    );
    const sel = selectAppliedPair(stats, MODEL_P);
    expect(sel.applied).toBe("measured-p+measured-b");
    const k = computeKelly(sel.p, sel.b);
    expect(k.rawKelly).toBeCloseTo(0.222222, 5);
    expect(k.kellyFraction).toBeCloseTo(0.222222, 5);
    expect(k.halfKelly).toBeCloseTo(0.111111, 5);
    expect(k.noEdge).toBe(false);
    expect(k.capped).toBe(false);
  });
});

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
