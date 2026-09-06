/**
 * V9 E1 — PURE execution-stats math over the admin desk's CLOSED PaperTrade
 * P&Ls (no DB, no HTTP — fully unit-testable).
 *
 * The PaperTrade ledger IS the execution log (SPEC_V9 mandate — no duplicate
 * ExecutionLog entity). From the realized P&Ls of closed trades, newest first:
 *
 *  - measuredP = wins/(wins+losses) over the LAST `EXECUTION_WINDOW_SIZE`(=30)
 *    closed trades; APPLIED only when total closedTrades ≥ 30 (below that a
 *    win rate is small-sample noise).
 *  - measuredB = avgWin/|avgLoss| over the SAME window; APPLIED only when the
 *    window holds ≥ 10 closed trades with BOTH wins and losses (b is
 *    mathematically undefined with zero losses).
 *  - expectancy = winRate×avgWin − (1−winRate)×avgLoss — the same formula the
 *    prediction audit uses (computeTradeBreakdown is shared with it).
 *
 * Conventions match the audit: a win is pnl > 0, a loss is pnl ≤ 0.
 */

import {
  EntryContextSnapshot,
  FactorInsightSideStat,
  FactorInsightSplit,
  FactorInsightsBlock,
} from "../../types";

export const EXECUTION_WINDOW_SIZE = 30;
export const MIN_TRADES_FOR_MEASURED_P = 30;
export const MIN_TRADES_FOR_MEASURED_B = 10;
export const STRUCTURAL_PAYOFF_B = 1.5;

/** Exact reason mandated by SPEC_V9 for the zero-losses case. */
export const NO_LOSSES_REASON =
  "no losing trades yet — payoff unmeasurable, still using structural 1.5";

function round2(x: number): number {
  const r = Math.round(x * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

// ── Audit-shared breakdown (win/loss counts, averages, expectancy) ───────────

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
 * The prediction audit's closed-trade math (AdminService.getPredictionAudit
 * imports THIS — one implementation, never duplicated). Returns null for an
 * empty list so callers state the honest "no closed trades yet" story.
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

// ── Windowed execution stats (the "last 30" measurement) ────────────────────

export interface ExecutionWindowStats {
  /** Total CLOSED trades with a realized P&L (whole history, not the window). */
  closedTrades: number;
  window: { size: number; used: number };
  /** Counts and averages INSIDE the window. */
  wins: number;
  losses: number;
  avgWin: number | null; // ₹; null when the window has no winners
  avgLoss: number | null; // ₹ positive; null when the window has no losers
  measuredP: number | null; // wins/(wins+losses) in the window; null when empty
  measuredB: number | null; // avgWin/avgLoss; null unless both sides exist
  usableP: boolean; // closedTrades ≥ MIN_TRADES_FOR_MEASURED_P
  usableB: boolean; // window ≥ MIN_TRADES_FOR_MEASURED_B with both sides
  expectancy: number | null; // audit formula over the window
  reasons: string[]; // honest, human-readable — why an input is NOT applied
}

/**
 * Compute the windowed stats. `windowPnlsNewestFirst` may be longer than the
 * window — only the newest `windowSize` entries count (this is what makes the
 * "last 30" label true). `totalClosedTrades` is the whole-history count and
 * gates usableP.
 */
export function computeExecutionStats(
  windowPnlsNewestFirst: number[],
  totalClosedTrades: number,
  windowSize: number = EXECUTION_WINDOW_SIZE
): ExecutionWindowStats {
  const windowPnls = windowPnlsNewestFirst.slice(0, windowSize);
  const breakdown = computeTradeBreakdown(windowPnls);
  const used = windowPnls.length;
  const reasons: string[] = [];

  if (!breakdown) {
    reasons.push(
      "no closed trades yet — win rate and payoff are unmeasurable; model p and " +
        `structural ${STRUCTURAL_PAYOFF_B} apply until the desk closes real paper trades.`
    );
    return {
      closedTrades: totalClosedTrades,
      window: { size: windowSize, used: 0 },
      wins: 0,
      losses: 0,
      avgWin: null,
      avgLoss: null,
      measuredP: null,
      measuredB: null,
      usableP: false,
      usableB: false,
      expectancy: null,
      reasons,
    };
  }

  const usableP = totalClosedTrades >= MIN_TRADES_FOR_MEASURED_P;
  if (!usableP) {
    reasons.push(
      `only ${totalClosedTrades} closed trade${totalClosedTrades === 1 ? "" : "s"} — ` +
        `a measured win rate needs ≥${MIN_TRADES_FOR_MEASURED_P}; model p applies until then.`
    );
  }

  // b: undefined without both sides; noisy below MIN_TRADES_FOR_MEASURED_B.
  let measuredB: number | null = null;
  let usableB = false;
  if (breakdown.losses === 0) {
    reasons.push(NO_LOSSES_REASON);
  } else if (breakdown.wins === 0) {
    reasons.push(
      `no winning trades in the last-${windowSize} window — payoff unmeasurable, ` +
        `still using structural ${STRUCTURAL_PAYOFF_B}.`
    );
  } else if (breakdown.avgLoss <= 0) {
    // Both sides exist but every "loss" was exactly ₹0 — b would divide by zero.
    reasons.push(
      `losses in the last-${windowSize} window average ₹0 — payoff unmeasurable, ` +
        `still using structural ${STRUCTURAL_PAYOFF_B}.`
    );
  } else {
    measuredB = breakdown.avgWin / breakdown.avgLoss;
    if (used < MIN_TRADES_FOR_MEASURED_B) {
      reasons.push(
        `only ${used} closed trade${used === 1 ? "" : "s"} in the last-${windowSize} window — ` +
          `a measured payoff needs ≥${MIN_TRADES_FOR_MEASURED_B} with both wins and losses; ` +
          `structural ${STRUCTURAL_PAYOFF_B} applies until then.`
      );
    } else {
      usableB = true;
    }
  }

  return {
    closedTrades: totalClosedTrades,
    window: { size: windowSize, used },
    wins: breakdown.wins,
    losses: breakdown.losses,
    avgWin: breakdown.wins > 0 ? breakdown.avgWin : null,
    avgLoss: breakdown.losses > 0 ? breakdown.avgLoss : null,
    measuredP: breakdown.winRate,
    measuredB,
    usableP,
    usableB,
    expectancy: breakdown.expectancy,
    reasons,
  };
}

// ── Applied-pair selection (E2 rule) ─────────────────────────────────────────

/**
 * SPEC_V9 lists the first three; 'measured-p+structural-b' covers the real
 * (if rare) state of ≥30 closed trades whose last-30 window has no losses —
 * p is measured while b must stay structural. Mapping it onto any of the
 * three listed labels would be dishonest.
 */
export type KellyAppliedPair =
  | "measured-p+measured-b"
  | "model-p+measured-b"
  | "model-p+structural-b"
  | "measured-p+structural-b";

export interface AppliedSelection {
  p: number;
  b: number;
  applied: KellyAppliedPair;
}

/**
 * E2 selection rule: p := measuredP when usableP (≥30 closed) else model p
 * (V8 unchanged); b := measuredB when usableB (≥10 in-window, both sides)
 * else `fallbackB`.
 *
 * V10 B3: `fallbackB` defaults to the structural 1.5 but callers with a
 * stored DCF for the ticker pass the DCF-implied prior instead — measured b
 * ALWAYS wins once usable, and the applied LABEL vocabulary is unchanged
 * (the b source detail lives in the position-size payoff.source, per spec).
 */
export function selectAppliedPair(
  stats: Pick<ExecutionWindowStats, "usableP" | "usableB" | "measuredP" | "measuredB">,
  modelP: number,
  fallbackB: number = STRUCTURAL_PAYOFF_B
): AppliedSelection {
  const pMeasured = stats.usableP && stats.measuredP !== null;
  const bMeasured = stats.usableB && stats.measuredB !== null;
  const p = pMeasured ? (stats.measuredP as number) : modelP;
  const b = bMeasured ? (stats.measuredB as number) : fallbackB;
  const applied: KellyAppliedPair = pMeasured
    ? bMeasured
      ? "measured-p+measured-b"
      : "measured-p+structural-b"
    : bMeasured
      ? "model-p+measured-b"
      : "model-p+structural-b";
  return { p, b, applied };
}

// ── V10 B4: factor insights (win-rate splits by entry-context factor) ────────

export const FACTOR_INSIGHTS_MIN_TRADES = 20;
export const FACTOR_INSIGHTS_MIN_SIDE = 8;

/** A closed trade with its P&L and (possibly null) entry-context snapshot. */
export interface ContextTrade {
  pnl: number;
  context: EntryContextSnapshot | null;
}

/** Numeric factor splits: high side is `value ≥ threshold`. */
const NUMERIC_FACTOR_SPLITS: Array<{
  factor: "quantScore" | "masterScore" | "entryTimingScore" | "intelligenceQuality";
  threshold: number;
}> = [
  { factor: "quantScore", threshold: 60 },
  { factor: "masterScore", threshold: 60 },
  { factor: "entryTimingScore", threshold: 62 }, // the BUY_TODAY line
  { factor: "intelligenceQuality", threshold: 50 },
];

function sideStat(label: string, pnls: number[]): FactorInsightSideStat {
  const wins = pnls.filter((p) => p > 0).length; // audit convention: win = pnl > 0
  return {
    label,
    n: pnls.length,
    wins,
    winRatePct: pnls.length > 0 ? round2((wins / pnls.length) * 100) : 0,
  };
}

/**
 * V10 B4 — win-rate splits of CLOSED trades by their entry-context factors.
 * PURE. Gating (both mandated by SPEC_V10):
 *  - the whole block unlocks only at ≥FACTOR_INSIGHTS_MIN_TRADES (20) closed
 *    trades WITH an entry_context snapshot;
 *  - a split is emitted only when BOTH sides hold ≥FACTOR_INSIGHTS_MIN_SIDE
 *    (8) trades — thinner cells are small-sample noise, not insight.
 * Trades missing a given factor are excluded from that factor's split only.
 */
export function computeFactorInsights(trades: ContextTrade[]): FactorInsightsBlock {
  const withContext = trades.filter((t) => t.context !== null && Number.isFinite(t.pnl));
  const n = withContext.length;

  if (n < FACTOR_INSIGHTS_MIN_TRADES) {
    return {
      unlocked: false,
      closedWithContext: n,
      required: FACTOR_INSIGHTS_MIN_TRADES,
      minPerSide: FACTOR_INSIGHTS_MIN_SIDE,
      splits: [],
      note: `insights unlock at ${FACTOR_INSIGHTS_MIN_TRADES} closed trades with entry snapshots — currently ${n}`,
    };
  }

  const splits: FactorInsightSplit[] = [];

  for (const { factor, threshold } of NUMERIC_FACTOR_SPLITS) {
    const highPnls: number[] = [];
    const lowPnls: number[] = [];
    for (const t of withContext) {
      const v = t.context![factor];
      if (v === null || !Number.isFinite(v)) continue;
      (v >= threshold ? highPnls : lowPnls).push(t.pnl);
    }
    if (highPnls.length < FACTOR_INSIGHTS_MIN_SIDE || lowPnls.length < FACTOR_INSIGHTS_MIN_SIDE) {
      continue;
    }
    const high = sideStat(`${factor} ≥ ${threshold}`, highPnls);
    const low = sideStat(`${factor} < ${threshold}`, lowPnls);
    splits.push({
      factor,
      threshold,
      high,
      low,
      deltaPp: round2(high.winRatePct - low.winRatePct),
    });
  }

  // Regime is categorical: risk-on vs the rest (neutral/risk-off).
  {
    const riskOn: number[] = [];
    const rest: number[] = [];
    for (const t of withContext) {
      const r = t.context!.regime;
      if (r === null || r === undefined) continue;
      (r === "risk-on" ? riskOn : rest).push(t.pnl);
    }
    if (riskOn.length >= FACTOR_INSIGHTS_MIN_SIDE && rest.length >= FACTOR_INSIGHTS_MIN_SIDE) {
      const high = sideStat("regime = risk-on", riskOn);
      const low = sideStat("regime = neutral/risk-off", rest);
      splits.push({
        factor: "regime",
        threshold: "risk-on",
        high,
        low,
        deltaPp: round2(high.winRatePct - low.winRatePct),
      });
    }
  }

  const note =
    splits.length > 0
      ? `Win-rate splits over ${n} closed trades with entry-context snapshots; only splits where ` +
        `both sides hold ≥${FACTOR_INSIGHTS_MIN_SIDE} trades are shown — smaller cells are noise. ` +
        `These are descriptive measurements of YOUR fills, not predictions.`
      : `${n} closed trades carry entry snapshots, but no factor currently has ≥${FACTOR_INSIGHTS_MIN_SIDE} ` +
        `trades on BOTH sides of its split — no honest read yet.`;

  return {
    unlocked: true,
    closedWithContext: n,
    required: FACTOR_INSIGHTS_MIN_TRADES,
    minPerSide: FACTOR_INSIGHTS_MIN_SIDE,
    splits,
    note,
  };
}
