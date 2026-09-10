/**
 * BarBuilder (reviewer #3, #4) — canonical 1-minute bars from validated ticks,
 * and a PURE aggregator that derives 5m/10m/15m/… from the ONE 1-minute series.
 *
 * Deriving every timeframe from a single canonical series (never fetching
 * separate vendor candles) guarantees: same underlying data ⇒ same 5m ⇒ same
 * 10m ⇒ same 15m, and byte-identical replay.
 *
 * A forming bar is only ever returned as `complete: false`; it becomes a
 * CompletedBar exactly once, when the clock crosses its boundary.
 */

import { MarketTick, LiveBar, FormingBar, CompletedBar } from "./types";

const MINUTE_MS = 60_000;

/** Minute-boundary bucket start for a ms epoch. */
export function minuteStart(ts: number): number {
  return Math.floor(ts / MINUTE_MS) * MINUTE_MS;
}

/**
 * Accumulates ticks into 1-minute bars for ONE security. Feed ticks in
 * non-decreasing exchange-time order (the TickValidator guarantees this). A tick
 * or clock advance into a new minute closes the previous bar.
 */
export class OneMinuteBarBuilder {
  private forming: FormingBar | null = null;
  private readonly securityId: string;

  constructor(securityId: string) {
    this.securityId = securityId;
  }

  /** Apply a tick; returns a CompletedBar if this tick closed the prior minute. */
  addTick(tick: MarketTick): CompletedBar | null {
    const bucket = minuteStart(tick.exchangeTimestamp);
    let closed: CompletedBar | null = null;
    if (this.forming && bucket > this.forming.startAt) {
      closed = this.close();
    }
    if (!this.forming) {
      this.forming = {
        complete: false,
        securityId: this.securityId,
        startAt: bucket,
        endAt: bucket + MINUTE_MS,
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
        volume: tick.quantity,
        tradeCount: 1,
      };
    } else {
      const b = this.forming;
      b.high = Math.max(b.high, tick.price);
      b.low = Math.min(b.low, tick.price);
      b.close = tick.price;
      b.volume += tick.quantity;
      b.tradeCount += 1;
    }
    return closed;
  }

  /** Advance the clock without a trade; closes the forming bar if the clock
   *  has crossed its boundary (a quiet minute still ends). */
  advanceClock(at: number): CompletedBar | null {
    if (this.forming && minuteStart(at) > this.forming.startAt) return this.close();
    return null;
  }

  /** The current in-progress bar, never confusable with a completed one. */
  current(): FormingBar | null {
    return this.forming ? { ...this.forming } : null;
  }

  /** Force-close the forming bar (e.g. at session end). */
  close(): CompletedBar | null {
    if (!this.forming) return null;
    const done: CompletedBar = { ...this.forming, complete: true };
    this.forming = null;
    return done;
  }
}

/**
 * Aggregate completed 1-minute bars into `minutes`-minute bars. PURE. Bars are
 * grouped by aligned bucket (startAt floored to the coarse boundary). A coarse
 * bar is `complete` only when the FULL set of constituent minutes is present —
 * a partial tail returns as a FormingBar so downstream can't treat a half-built
 * 15m bar as closed.
 */
export function aggregateBars(bars1m: CompletedBar[], minutes: number): LiveBar[] {
  if (minutes <= 1) return bars1m.slice();
  const span = minutes * MINUTE_MS;
  const buckets = new Map<number, CompletedBar[]>();
  for (const b of bars1m) {
    const key = Math.floor(b.startAt / span) * span;
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(b);
  }
  const out: LiveBar[] = [];
  for (const key of Array.from(buckets.keys()).sort((a, b) => a - b)) {
    const group = buckets.get(key)!.sort((a, b) => a.startAt - b.startAt);
    const complete = group.length === minutes;
    const bar = {
      securityId: group[0].securityId,
      startAt: key,
      endAt: key + span,
      open: group[0].open,
      high: Math.max(...group.map((g) => g.high)),
      low: Math.min(...group.map((g) => g.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((s, g) => s + g.volume, 0),
      tradeCount: group.reduce((s, g) => s + g.tradeCount, 0),
    };
    out.push(complete ? { ...bar, complete: true } : { ...bar, complete: false });
  }
  return out;
}
