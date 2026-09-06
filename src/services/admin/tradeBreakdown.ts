/**
 * Trade-breakdown math (win/loss counts, averages, expectancy) — PURE, no DB.
 *
 * EXTRACTED (Phase B1, upgrade-audit §3 row 1) from the removed
 * `executionStats.ts` because the KEEPER prediction-audit
 * (AdminService.getPredictionAudit) uses this exact formula. The Kelly /
 * adaptive-execution machinery that used to surround it is archived under
 * `archive/` — this file carries only the shared, still-consumed math.
 *
 * Conventions (unchanged from V9): a win is pnl > 0, a loss is pnl ≤ 0;
 * expectancy = winRate×avgWin − (1−winRate)×avgLoss (Zerodha Varsity M9 /
 * Van Tharp), rounded to 2dp.
 */

function round2(x: number): number {
  const r = Math.round(x * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

export interface TradeBreakdown {
  count: number;
  wins: number;
  losses: number;
  winRate: number; // wins / count
  avgWin: number; // ₹ over winners only; 0 when there are none
  avgLoss: number; // ₹ POSITIVE over losers only; 0 when there are none
  expectancy: number; // round2(winRate×avgWin − (1−winRate)×avgLoss)
}

/**
 * The prediction audit's closed-trade math — one implementation, never
 * duplicated. Returns null for an empty list so callers state the honest
 * "no closed trades yet" story instead of fabricating zeros.
 */
export function computeTradeBreakdown(pnls: number[]): TradeBreakdown | null {
  if (pnls.length === 0) return null;
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p <= 0);
  const winRate = wins.length / pnls.length;
  const avgWin = wins.length ? wins.reduce((s, p) => s + p, 0) / wins.length : 0;
  const avgLoss = losses.length
    ? Math.abs(losses.reduce((s, p) => s + p, 0) / losses.length)
    : 0;
  const expectancy = round2(winRate * avgWin - (1 - winRate) * avgLoss);
  return {
    count: pnls.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    avgWin,
    avgLoss,
    expectancy,
  };
}
