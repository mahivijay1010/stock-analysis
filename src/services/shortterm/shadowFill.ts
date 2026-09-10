/**
 * Fill-aware bracket simulation (P0 #2/#3/#8) — PURE.
 *
 * Proves an ENTRY actually occurred before crediting/debiting any outcome:
 *   WAITING_FOR_ENTRY → (fill within the entry window) → OPEN → TARGET/STOP/TIMEOUT
 * or NEVER_ENTERED if price never reached the entry over the window.
 *
 * - Levels and OHLC are on the SAME adjusted basis (#8): the caller passes an
 *   adjusted OHLC series (raw OHLC × adjClose/close), consistent with the
 *   adjusted-close levels the plan was built on.
 * - Gap-aware fills (#2): a gap through a limit/trigger fills at the OPEN.
 * - Same-bar ambiguity: stop/target are evaluated from the bar AFTER the fill,
 *   and if a single later bar straddles both levels the STOP is assumed first
 *   (conservative). A gap that opens beyond a level fills the exit at the open.
 * - Realized R (#3): netR = (exit − fill)/(fill − stop) − costsInR, where
 *   costsInR converts round-trip % cost+slippage into risk units. NEVER a raw
 *   percentage relabelled as R.
 */

export interface OhlcBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type FillOutcome = "NEVER_ENTERED" | "TARGET_FIRST" | "STOP_FIRST" | "TIMEOUT";

export interface BracketResult {
  outcome: FillOutcome;
  filled: boolean;
  fillPrice: number | null;
  fillDate: string | null;
  exitPrice: number | null;
  exitDate: string | null;
  holdingDays: number;
  returnPct: number | null; // gross price return of the trade (fill→exit)
  netRMultiple: number | null; // realized R AFTER round-trip costs (the honest number)
  mfeR: number | null; // best favorable excursion in R while open
  maeR: number | null; // worst adverse excursion in R while open
}

const r4 = (x: number): number => Math.round(x * 10000) / 10000;

export function simulateBracket(opts: {
  /** Forward adjusted OHLC bars AFTER the anchor (index 0 = first session post-anchor). */
  forward: OhlcBar[];
  entryType: "zone" | "trigger";
  zoneLow: number | null;
  zoneHigh: number | null; // limit price for a zone (long) entry
  triggerPrice: number | null; // stop-buy price for a breakout entry
  stop: number;
  target: number;
  entryWindow: number; // sessions allowed to get filled
  maxHold: number; // sessions to hold AFTER fill before a time exit
  roundTripCostPct: number;
  slippagePct: number;
}): BracketResult {
  const none: BracketResult = {
    outcome: "NEVER_ENTERED",
    filled: false,
    fillPrice: null,
    fillDate: null,
    exitPrice: null,
    exitDate: null,
    holdingDays: 0,
    returnPct: null,
    netRMultiple: null,
    mfeR: null,
    maeR: null,
  };
  if (opts.forward.length === 0 || !(opts.stop > 0) || !(opts.target > opts.stop)) return none;

  // ── Phase 1: find the fill within the entry window ──────────────────────
  let fillIdx = -1;
  let fillPrice = 0;
  const window = Math.min(opts.entryWindow, opts.forward.length);
  for (let i = 0; i < window; i++) {
    const b = opts.forward[i];
    if (opts.entryType === "trigger") {
      const trig = opts.triggerPrice;
      if (trig == null) return none;
      // Stop-buy: fills when price trades up through the trigger; gap-up fills at open.
      if (b.high >= trig) {
        fillPrice = b.open >= trig ? b.open : trig;
        fillIdx = i;
        break;
      }
    } else {
      const limit = opts.zoneHigh;
      if (limit == null) return none;
      // Buy-limit at the top of the zone: fills when price trades down to it;
      // a gap-down opens the fill at the (better) open.
      if (b.low <= limit) {
        fillPrice = b.open <= limit ? b.open : limit;
        fillIdx = i;
        break;
      }
    }
  }
  if (fillIdx < 0) return none; // NEVER_ENTERED — the honest default

  const risk = fillPrice - opts.stop;
  if (!(risk > 0)) {
    // A gap-down entry can open at/below the stop — the trade is stopped on
    // entry with no favorable risk geometry. Record as an immediate stop.
    return {
      ...none,
      outcome: "STOP_FIRST",
      filled: true,
      fillPrice: r4(fillPrice),
      fillDate: opts.forward[fillIdx].date,
      exitPrice: r4(fillPrice),
      exitDate: opts.forward[fillIdx].date,
      holdingDays: 1,
      returnPct: 0,
      netRMultiple: r4(-(fillPrice * (opts.roundTripCostPct + opts.slippagePct)) / 100 / Math.max(1e-6, Math.abs(risk) || fillPrice * 0.01)),
      mfeR: 0,
      maeR: 0,
    };
  }

  // ── Phase 2: manage the OPEN position from the bar AFTER the fill ────────
  let outcome: FillOutcome = "TIMEOUT";
  let exitPrice = opts.forward[Math.min(fillIdx + opts.maxHold, opts.forward.length - 1)].close;
  let exitDate = opts.forward[Math.min(fillIdx + opts.maxHold, opts.forward.length - 1)].date;
  let holdingDays = 0;
  let mfeR = 0;
  let maeR = 0;
  const lastIdx = Math.min(fillIdx + opts.maxHold, opts.forward.length - 1);
  for (let k = fillIdx + 1; k <= lastIdx; k++) {
    const b = opts.forward[k];
    mfeR = Math.max(mfeR, (b.high - fillPrice) / risk);
    maeR = Math.min(maeR, (b.low - fillPrice) / risk);
    holdingDays = k - fillIdx;
    const gapStop = b.open <= opts.stop;
    const gapTarget = b.open >= opts.target;
    const hitStop = b.low <= opts.stop;
    const hitTarget = b.high >= opts.target;
    if (gapStop) {
      outcome = "STOP_FIRST";
      exitPrice = b.open; // gap through the stop fills at the open
      exitDate = b.date;
      break;
    }
    if (gapTarget) {
      outcome = "TARGET_FIRST";
      exitPrice = b.open;
      exitDate = b.date;
      break;
    }
    // Same-bar straddle ⇒ assume STOP first (conservative).
    if (hitStop) {
      outcome = "STOP_FIRST";
      exitPrice = opts.stop;
      exitDate = b.date;
      break;
    }
    if (hitTarget) {
      outcome = "TARGET_FIRST";
      exitPrice = opts.target;
      exitDate = b.date;
      break;
    }
  }
  if (outcome === "TIMEOUT") holdingDays = lastIdx - fillIdx;

  const costsInR = (fillPrice * (opts.roundTripCostPct + opts.slippagePct)) / 100 / risk;
  const grossR = (exitPrice - fillPrice) / risk;
  return {
    outcome,
    filled: true,
    fillPrice: r4(fillPrice),
    fillDate: opts.forward[fillIdx].date,
    exitPrice: r4(exitPrice),
    exitDate,
    holdingDays,
    returnPct: r4(((exitPrice - fillPrice) / fillPrice) * 100),
    netRMultiple: r4(grossR - costsInR),
    mfeR: r4(mfeR),
    maeR: r4(maeR),
  };
}

/** Adjusted OHLC from raw bars using the per-bar adjClose/close factor (#8). */
export function toAdjustedOhlc(bars: Array<{ date: string; open: number; high: number; low: number; close: number; adjustedClose?: number | null }>): OhlcBar[] {
  return bars.map((b) => {
    const factor = b.adjustedClose != null && b.close > 0 ? b.adjustedClose / b.close : 1;
    return { date: b.date, open: b.open * factor, high: b.high * factor, low: b.low * factor, close: b.close * factor };
  });
}
