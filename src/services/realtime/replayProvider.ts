/**
 * ReplayMarketProvider + ReplayMarketDataSource (reviewer #18) — feed recorded
 * history through the EXACT interface a live feed uses, with NO lookahead. The
 * engine cannot tell it isn't live, so "what would it have said at 10:20?" is
 * answered by the same code path that runs in production.
 *
 * Determinism is the point: LIVE engine on a recorded feed and REPLAY engine on
 * the same recorded feed must produce byte-identical deterministic outputs.
 */

import { MarketDataSource, MarketEvent, MarketTick, RealtimeMarketProvider, ProviderHealth } from "./types";

/**
 * A pull source over a pre-recorded, time-ordered event list. Events are
 * returned strictly in order; a consumer can NEVER read past the current
 * position, so no future bar can influence a past evaluation.
 */
export class ReplayMarketDataSource implements MarketDataSource {
  private readonly events: MarketEvent[];
  private i = 0;

  constructor(events: MarketEvent[]) {
    // Freeze in time order; ticks sort by exchangeTimestamp, clocks by `at`.
    this.events = events.slice().sort((a, b) => eventTime(a) - eventTime(b));
  }

  async next(): Promise<MarketEvent | null> {
    if (this.i >= this.events.length) return null;
    return this.events[this.i++];
  }

  /** Convenience: build a source from ticks, injecting CLOCK events at a fixed
   *  cadence so bars close and checkpoints fire even across quiet gaps. */
  static fromTicks(ticks: MarketTick[], clockCadenceMs?: number): ReplayMarketDataSource {
    const events: MarketEvent[] = ticks.map((t) => ({ kind: "TICK" as const, tick: t }));
    if (clockCadenceMs && ticks.length > 0) {
      const start = Math.min(...ticks.map((t) => t.exchangeTimestamp));
      const end = Math.max(...ticks.map((t) => t.exchangeTimestamp));
      for (let at = start; at <= end + clockCadenceMs; at += clockCadenceMs) events.push({ kind: "CLOCK", at });
    }
    return new ReplayMarketDataSource(events);
  }
}

function eventTime(e: MarketEvent): number {
  return e.kind === "TICK" ? e.tick.exchangeTimestamp : e.at;
}

/**
 * A push-style provider that drives onTick from a ReplayMarketDataSource — lets
 * replay masquerade as a live RealtimeMarketProvider for wiring tests. `pump()`
 * drains the source synchronously (deterministic; no timers).
 */
export class ReplayMarketProvider implements RealtimeMarketProvider {
  private readonly source: ReplayMarketDataSource;
  private tickCbs: Array<(t: MarketTick) => void> = [];
  private errCbs: Array<(e: unknown) => void> = [];
  private connected = false;
  private subscribed = 0;
  private lastTickAt: number | null = null;

  constructor(source: ReplayMarketDataSource) {
    this.source = source;
  }

  async connect(): Promise<void> { this.connected = true; }
  async disconnect(): Promise<void> { this.connected = false; }
  async subscribe(securityIds: string[]): Promise<void> { this.subscribed = securityIds.length; }
  onTick(cb: (t: MarketTick) => void): void { this.tickCbs.push(cb); }
  onError(cb: (e: unknown) => void): void { this.errCbs.push(cb); }
  health(): ProviderHealth {
    return { state: this.connected ? "CONNECTED" : "DISCONNECTED", lastTickAt: this.lastTickAt, subscribed: this.subscribed };
  }

  /** Drain the recorded source, emitting each tick to subscribers in order. */
  async pump(): Promise<void> {
    for (let e = await this.source.next(); e !== null; e = await this.source.next()) {
      if (e.kind !== "TICK") continue;
      this.lastTickAt = e.tick.exchangeTimestamp;
      for (const cb of this.tickCbs) {
        try { cb(e.tick); } catch (err) { for (const ec of this.errCbs) ec(err); }
      }
    }
  }
}
