/**
 * Tradeability hard-gate (tradeability-gate-v1) — PURE.
 *
 * Part 1 doctrine: surveillance status, restricted series and circuit bands are
 * HARD GATES, not features. A stock in GSM, on the BE/trade-for-trade series,
 * or so illiquid you cannot exit ₹1 crore in a few days is not tradeable for
 * this purpose — no score, no AI opinion, can make it a BUY. This gate returns
 * the honest verdict plus the exact reasons, so the UI can SAY why a name is
 * off-limits rather than silently dropping it.
 *
 * `tradeable=false` ⇒ the Conviction Board caps it to LOW and never BUY-grade.
 * Warnings keep the stock tradeable but dampen conviction.
 */

export const TRADEABILITY_GATE_VERSION = "tradeability-gate-v1";

export const TRADEABILITY_RULES = {
  /** Below this median daily VALUE you cannot size without large impact cost. */
  minMedianDailyValueInr: 5_000_000, // ₹50 lakh — hard block
  /** Below this you can trade only tiny size — a warning, not a block. */
  softMedianDailyValueInr: 20_000_000, // ₹2 crore
  /** A 5% circuit band means you often cannot exit at your stop — hard block. */
  hardCircuitBandPct: 5,
  /** More than this many trading days to exit ₹1cr ⇒ warning. */
  maxDaysToExit: 3,
  /** Delivery below this is speculative/intraday-dominated ⇒ warning. */
  minDelivPct20d: 20,
  /** Frequent large moves ⇒ volatility/lock-risk warning. */
  maxBigMoveDays20d: 4,
} as const;

/** Surveillance / series inputs are strings as NSE emits them. */
export interface TradeabilityInput {
  /** Exchange surveillance codes present today (ASM-*, GSM-*, ESM-*, IBC-*). Empty = clean. */
  surveillanceCodes: string[];
  /** NSE series — "EQ" is normal; "BE"/"BZ"/"T2T" are trade-for-trade. */
  series?: string | null;
  medianDailyValueInr20d: number | null;
  inferredCircuitBandPct: 5 | 10 | 20 | null;
  daysToExitAt1crore: number | null;
  delivPct20d: number | null;
  bigMoveDays20d: number;
}

export interface TradeabilityVerdict {
  version: string;
  tradeable: boolean;
  /** Reasons the stock is NOT tradeable (empty ⇒ tradeable). */
  hardBlocks: string[];
  /** Tradeable, but these raise risk and dampen conviction. */
  warnings: string[];
}

const RESTRICTED_SERIES = new Set(["BE", "BZ", "T2T", "IL", "SM"]);

export function checkTradeabilityGate(input: TradeabilityInput): TradeabilityVerdict {
  const R = TRADEABILITY_RULES;
  const hardBlocks: string[] = [];
  const warnings: string[] = [];

  // Surveillance — ANY active code is a hard block (restrictions / 100% margin /
  // periodic call auction + the exchange's own abnormal-price judgement).
  if (input.surveillanceCodes.length > 0) {
    hardBlocks.push(`exchange surveillance: ${input.surveillanceCodes.join(", ")}`);
  }

  // Restricted series — trade-for-trade means no intraday, delivery-only, often
  // the destination for surveilled names.
  const series = (input.series ?? "EQ").toUpperCase();
  if (RESTRICTED_SERIES.has(series)) {
    hardBlocks.push(`restricted series ${series} (trade-for-trade / delivery-only)`);
  }

  // Liquidity floor — below this you cannot size without punishing impact cost.
  const val = input.medianDailyValueInr20d;
  if (val != null && val < R.minMedianDailyValueInr) {
    hardBlocks.push(`illiquid: median daily value ₹${(val / 1e5).toFixed(1)}L < ₹${R.minMedianDailyValueInr / 1e5}L`);
  }

  // 5% circuit band — you frequently cannot exit at your stop.
  if (input.inferredCircuitBandPct === R.hardCircuitBandPct) {
    hardBlocks.push(`likely ${R.hardCircuitBandPct}% circuit band — cannot reliably exit at stop`);
  }

  // ── Warnings (still tradeable) ──────────────────────────────────────────
  if (val != null && val >= R.minMedianDailyValueInr && val < R.softMedianDailyValueInr) {
    warnings.push(`thin: median daily value ₹${(val / 1e5).toFixed(1)}L < ₹${R.softMedianDailyValueInr / 1e5}L — size small`);
  }
  if (input.daysToExitAt1crore != null && input.daysToExitAt1crore > R.maxDaysToExit) {
    warnings.push(`~${input.daysToExitAt1crore} days to exit ₹1cr — exit risk`);
  }
  if (input.delivPct20d != null && input.delivPct20d < R.minDelivPct20d) {
    warnings.push(`delivery ${input.delivPct20d}% < ${R.minDelivPct20d}% — intraday-speculative`);
  }
  if (input.inferredCircuitBandPct === 10) {
    warnings.push("likely 10% circuit band — gap/exit risk");
  }
  if (input.bigMoveDays20d > R.maxBigMoveDays20d) {
    warnings.push(`${input.bigMoveDays20d} large-move days in 20 — unstable`);
  }

  return {
    version: TRADEABILITY_GATE_VERSION,
    tradeable: hardBlocks.length === 0,
    hardBlocks,
    warnings,
  };
}
