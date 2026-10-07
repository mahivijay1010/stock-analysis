/**
 * Triple-barrier labeling (triple-barrier-v1) — PURE (López de Prado).
 *
 * The honest label for a supervised model: from an anchor, place an UPPER
 * barrier at +upperMult×ATR, a LOWER barrier at −lowerMult×ATR, and a TIME
 * barrier at horizon sessions. The label is whichever is touched first. This is
 * the SAME discipline as the live bracket grader (shadowFill.ts): gap-aware,
 * and a single bar that straddles both price barriers is AMBIGUOUS — the
 * adverse leg is assumed for safety and NO realized R is manufactured, so
 * training labels can never be more optimistic than what was observable.
 *
 * realizedR is in risk units: (exit − entry) / (lowerMult × ATR), net of a
 * round-trip cost+slippage haircut. This matches how the ledgers score live
 * trades, so training and evaluation never diverge.
 */

export const TRIPLE_BARRIER_VERSION = "triple-barrier-v1";

export interface TbBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type TbLabel = "TARGET" | "STOP" | "TIME" | "AMBIGUOUS" | "DATA_INVALID";

export interface TripleBarrierInput {
  /** Forward-adjusted OHLC AFTER the anchor (index 0 = first session post-anchor). */
  forward: TbBar[];
  entryPrice: number;
  atr: number;
  upperMult: number; // e.g. 2.0
  lowerMult: number; // e.g. 1.0
  horizonSessions: number;
  roundTripCostPct?: number; // default 0.3
  slippagePct?: number; // default 0.2
}

export interface TripleBarrierOutput {
  version: string;
  label: TbLabel;
  upper: number;
  lower: number;
  /** OBSERVED realized R after costs; NULL when ordering was unobservable. */
  realizedR: number | null;
  /** Conservative (adverse-assumed) R for a safety gate; equals realizedR when observed. */
  conservativeR: number | null;
  mfeR: number; // max favorable excursion in R
  maeR: number; // max adverse excursion in R
  exitIndex: number | null;
  exitPrice: number | null;
  holdingDays: number;
  ambiguous: boolean;
}

const r4 = (x: number): number => Math.round(x * 10000) / 10000;

export function labelTripleBarrier(input: TripleBarrierInput): TripleBarrierOutput {
  const { forward, entryPrice, atr, upperMult, lowerMult, horizonSessions } = input;
  const cost = (input.roundTripCostPct ?? 0.3) + (input.slippagePct ?? 0.2);
  const base: TripleBarrierOutput = {
    version: TRIPLE_BARRIER_VERSION,
    label: "DATA_INVALID",
    upper: NaN,
    lower: NaN,
    realizedR: null,
    conservativeR: null,
    mfeR: 0,
    maeR: 0,
    exitIndex: null,
    exitPrice: null,
    holdingDays: 0,
    ambiguous: false,
  };
  if (!(entryPrice > 0) || !(atr > 0) || !(upperMult > 0) || !(lowerMult > 0) || forward.length === 0) return base;

  const upper = entryPrice + upperMult * atr;
  const lower = entryPrice - lowerMult * atr;
  const risk = lowerMult * atr; // R unit
  const costInR = (entryPrice * cost) / 100 / risk;

  const last = Math.min(horizonSessions, forward.length) - 1;
  let mfeR = 0;
  let maeR = 0;
  for (let i = 0; i <= last; i++) {
    const b = forward[i];
    if (!(b.high >= b.low) || !(b.high > 0)) {
      return { ...base, label: "DATA_INVALID", upper: r4(upper), lower: r4(lower), holdingDays: i };
    }
    mfeR = Math.max(mfeR, (b.high - entryPrice) / risk);
    maeR = Math.min(maeR, (b.low - entryPrice) / risk);

    const gapUp = b.open >= upper;
    const gapDown = b.open <= lower;
    const hitUp = b.high >= upper;
    const hitDown = b.low <= lower;

    // A gap at the open is unambiguous — the open is the first tradeable price.
    if (gapDown) return finish("STOP", b.open, i);
    if (gapUp) return finish("TARGET", b.open, i);
    // Both barriers inside one bar: ordering unobservable → AMBIGUOUS (adverse).
    if (hitDown && hitUp) {
      const adverseR = r4((lower - entryPrice) / risk - costInR);
      return {
        ...base,
        label: "AMBIGUOUS",
        upper: r4(upper),
        lower: r4(lower),
        realizedR: null,
        conservativeR: adverseR,
        mfeR: r4(mfeR),
        maeR: r4(maeR),
        exitIndex: i,
        exitPrice: r4(lower),
        holdingDays: i + 1,
        ambiguous: true,
      };
    }
    if (hitDown) return finish("STOP", lower, i);
    if (hitUp) return finish("TARGET", upper, i);
  }
  // Time barrier — exit at the last observed close within the horizon.
  const exit = forward[last];
  return finish("TIME", exit.close, last);

  function finish(label: TbLabel, exitPrice: number, i: number): TripleBarrierOutput {
    const rr = r4((exitPrice - entryPrice) / risk - costInR);
    return {
      version: TRIPLE_BARRIER_VERSION,
      label,
      upper: r4(upper),
      lower: r4(lower),
      realizedR: rr,
      conservativeR: rr,
      mfeR: r4(mfeR),
      maeR: r4(maeR),
      exitIndex: i,
      exitPrice: r4(exitPrice),
      holdingDays: i + 1,
      ambiguous: false,
    };
  }
}
