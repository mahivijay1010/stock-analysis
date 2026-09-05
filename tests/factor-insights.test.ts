/**
 * V10 B4 — factorInsights gating (SPEC_V10 gate: "factorInsights gating"):
 *  - the block unlocks only at ≥20 closed trades WITH entry_context,
 *  - a split is emitted only when BOTH sides hold ≥8 trades,
 *  - trades missing a factor are excluded from that factor's split only,
 *  - win rates are exact (hand-checked — the live gate seeds the same set).
 */

import {
  computeFactorInsights,
  ContextTrade,
  FACTOR_INSIGHTS_MIN_SIDE,
  FACTOR_INSIGHTS_MIN_TRADES,
} from "../src/services/admin/executionStats";
import { EntryContextSnapshot } from "../src/types";

const ctx = (over: Partial<EntryContextSnapshot>): EntryContextSnapshot => ({
  quantScore: null,
  masterScore: null,
  entryTimingScore: null,
  intelligenceQuality: null,
  regime: null,
  ...over,
});

const trade = (pnl: number, over: Partial<EntryContextSnapshot>): ContextTrade => ({
  pnl,
  context: ctx(over),
});

/**
 * The SAME synthetic set the live verification seeds (24 tagged trades):
 *  - 12 with quantScore 70 (high side): 9 wins of +15, 3 losses of −10 → 75%
 *  - 12 with quantScore 50 (low side):  4 wins of +15, 8 losses of −10 → 33.33%
 * All other factors null except regime: the 12 high are 'risk-on', the 12 low
 * are 'neutral' → the regime split mirrors the quantScore split exactly.
 */
function syntheticSet(): ContextTrade[] {
  const t: ContextTrade[] = [];
  for (let i = 0; i < 9; i++) t.push(trade(15, { quantScore: 70, regime: "risk-on" }));
  for (let i = 0; i < 3; i++) t.push(trade(-10, { quantScore: 70, regime: "risk-on" }));
  for (let i = 0; i < 4; i++) t.push(trade(15, { quantScore: 50, regime: "neutral" }));
  for (let i = 0; i < 8; i++) t.push(trade(-10, { quantScore: 50, regime: "neutral" }));
  return t;
}

describe("computeFactorInsights — the 20-trade unlock gate", () => {
  it("0 trades → locked with the exact spec note", () => {
    const b = computeFactorInsights([]);
    expect(b.unlocked).toBe(false);
    expect(b.splits).toEqual([]);
    expect(b.note).toBe(
      "insights unlock at 20 closed trades with entry snapshots — currently 0"
    );
  });

  it("19 with context → still locked; the count is context-trades only", () => {
    const nineteen = syntheticSet().slice(0, 19);
    // Plus 10 closed trades WITHOUT context — they must not count.
    const withNulls = [...nineteen, ...Array(10).fill({ pnl: 5, context: null })];
    const b = computeFactorInsights(withNulls);
    expect(b.unlocked).toBe(false);
    expect(b.closedWithContext).toBe(19);
    expect(b.note).toContain("currently 19");
    expect(FACTOR_INSIGHTS_MIN_TRADES).toBe(20);
  });

  it("20 with context → unlocked", () => {
    const b = computeFactorInsights(syntheticSet().slice(0, 20));
    expect(b.unlocked).toBe(true);
  });
});

describe("computeFactorInsights — both-sides n≥8 split gate", () => {
  it("suppresses a split whose thin side has <8 trades", () => {
    // 24 trades: 20 high-quantScore, only 4 low — the split must NOT emit.
    const trades: ContextTrade[] = [
      ...Array.from({ length: 20 }, (_, i) => trade(i % 2 ? 10 : -5, { quantScore: 80 })),
      ...Array.from({ length: 4 }, () => trade(10, { quantScore: 40 })),
    ];
    const b = computeFactorInsights(trades);
    expect(b.unlocked).toBe(true);
    expect(b.splits.find((s) => s.factor === "quantScore")).toBeUndefined();
    expect(b.note).toContain("no factor currently has ≥8");
    expect(FACTOR_INSIGHTS_MIN_SIDE).toBe(8);
  });

  it("emits when both sides reach exactly 8", () => {
    const trades: ContextTrade[] = [
      ...Array.from({ length: 8 }, () => trade(10, { quantScore: 80 })),
      ...Array.from({ length: 8 }, () => trade(-10, { quantScore: 40 })),
      ...Array.from({ length: 5 }, () => trade(1, {})), // context, no quantScore
    ];
    const b = computeFactorInsights(trades);
    const split = b.splits.find((s) => s.factor === "quantScore")!;
    expect(split).toBeDefined();
    expect(split.high.n).toBe(8);
    expect(split.low.n).toBe(8);
  });

  it("trades missing a factor are excluded from that factor's split only", () => {
    const trades = [
      ...syntheticSet(),
      // 6 extra trades with NO quantScore — they must not shift its split.
      ...Array.from({ length: 6 }, () => trade(100, { intelligenceQuality: 90 })),
    ];
    const b = computeFactorInsights(trades);
    const split = b.splits.find((s) => s.factor === "quantScore")!;
    expect(split.high.n + split.low.n).toBe(24);
  });
});

describe("computeFactorInsights — the live-gate hand check (24 tagged trades)", () => {
  const b = computeFactorInsights(syntheticSet());

  it("quantScore ≥60 vs <60: 75.0% (n=12) vs 33.33% (n=12), Δ +41.67pp", () => {
    const s = b.splits.find((x) => x.factor === "quantScore")!;
    expect(s.threshold).toBe(60);
    expect(s.high.n).toBe(12);
    expect(s.high.wins).toBe(9);
    expect(s.high.winRatePct).toBeCloseTo(75, 6);
    expect(s.low.n).toBe(12);
    expect(s.low.wins).toBe(4);
    expect(s.low.winRatePct).toBeCloseTo(33.33, 2);
    expect(s.deltaPp).toBeCloseTo(41.67, 2);
  });

  it("regime risk-on vs rest mirrors the same 12/12 sides", () => {
    const s = b.splits.find((x) => x.factor === "regime")!;
    expect(s.threshold).toBe("risk-on");
    expect(s.high.n).toBe(12);
    expect(s.high.winRatePct).toBeCloseTo(75, 6);
    expect(s.low.n).toBe(12);
    expect(s.low.winRatePct).toBeCloseTo(33.33, 2);
  });

  it("factors that are all-null never emit (masterScore, entryTiming, intelligence)", () => {
    for (const f of ["masterScore", "entryTimingScore", "intelligenceQuality"]) {
      expect(b.splits.find((x) => x.factor === f)).toBeUndefined();
    }
  });

  it("a win is pnl > 0 (audit convention) and n counts are honest", () => {
    expect(b.closedWithContext).toBe(24);
    expect(b.required).toBe(20);
    expect(b.minPerSide).toBe(8);
    expect(b.note).toContain("24 closed trades");
  });
});
