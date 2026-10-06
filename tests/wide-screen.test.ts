/**
 * Wide-universe sub-₹100 screen, pinned: exclusions fire for the right
 * reasons, the rank is tradeability only, and a split is flagged, not scored.
 */
import { DailyRow, SCREEN_RULES, ScreenRow, computeMetrics, exclusionsFor, rankPassing } from "../src/services/shortterm/wideScreen";

function series(n: number, opts: { close?: (i: number) => number; turnover?: number; trades?: number; deliv?: number } = {}): DailyRow[] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
    return { d, close: opts.close ? opts.close(i) : 50, turnoverLacs: opts.turnover ?? 500, trades: opts.trades ?? 5000, delivPct: opts.deliv ?? 40 };
  });
}

describe("wide screen", () => {
  it("computes returns, drawdown and distance from high on exchange prints", () => {
    const m = computeMetrics("X", series(300, { close: (i) => (i < 250 ? 100 : 80) }));
    expect(m.price).toBe(80);
    expect(m.ret20Pct).toBeCloseTo(0);
    expect(m.maxDrawdown1yPct).toBeCloseTo(-20);
    expect(m.pctFrom1yHigh).toBeCloseTo(-20);
    expect(m.corporateActionSuspect).toBe(false);
  });

  it("flags a split-like move instead of scoring it", () => {
    const m = computeMetrics("X", series(300, { close: (i) => (i < 290 ? 100 : 50) }));
    expect(m.corporateActionSuspect).toBe(true);
  });

  it("excludes surveillance, penny, illiquid, thin and short-history stocks with reasons", () => {
    const base = computeMetrics("X", series(300));
    expect(exclusionsFor(base, [], "2020-01-01")).toEqual([]);
    expect(exclusionsFor(base, [{ code: "GSM - I (1)", description: "GSM Stage I", observedAt: "2026-10-06" }], null)[0]).toMatch(/surveillance/);
    expect(exclusionsFor(computeMetrics("X", series(300, { close: () => 4 })), [], null)[0]).toMatch(/penny/);
    expect(exclusionsFor(computeMetrics("X", series(100)), [], null)[0]).toMatch(/history/);
    expect(exclusionsFor(computeMetrics("X", series(300, { turnover: 50 })), [], null)[0]).toMatch(/illiquid/);
    expect(exclusionsFor(computeMetrics("X", series(300, { trades: 100 })), [], null)[0]).toMatch(/thin/);
    expect(exclusionsFor(base, [], "2025-09-01")[0]).toMatch(/listed < 1 year/);
  });

  it("ranks by liquidity and stability only — a bigger past return earns nothing", () => {
    const mk = (symbol: string, turnover: number, vol: (i: number) => number): ScreenRow => ({
      ...computeMetrics(symbol, series(300, { turnover, close: vol })),
      companyName: null, industry: null, indices: [], listingDate: null, surveillance: [], passed: true, exclusions: [], rank: null,
    });
    const calmLiquid = mk("A", 5000, () => 50);
    const wildRunner = mk("B", 300, (i) => 50 * (1 + 0.004 * i) * (i % 2 ? 1.08 : 1)); // +hundreds of %, very volatile
    const rows = [wildRunner, calmLiquid];
    rankPassing(rows);
    expect(calmLiquid.rank!.score).toBeGreaterThan(wildRunner.rank!.score);
    expect(wildRunner.ret250Pct!).toBeGreaterThan(calmLiquid.ret250Pct!);
  });

  it("keeps the rules where the report can cite them", () => {
    expect(SCREEN_RULES.maxPrice).toBe(100);
    expect(SCREEN_RULES.minMedianTurnoverLacs).toBe(200);
  });
});
