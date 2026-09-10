/**
 * RealtimeStateStore (reviewer #5) — one hot, in-memory current state per
 * security. Postgres is NOT the per-tick state machine; only completed bars,
 * revisions, and snapshots are durable. This holds what "is happening now".
 */

import { MarketTick, CompletedBar, ProviderState } from "./types";

export interface RealtimeStockState {
  securityId: string;
  lastTick: MarketTick | null;
  session: { open: number; high: number; low: number; last: number; volume: number };
  bars1m: CompletedBar[];
  providerHealth: ProviderState;
  dataHealth: "HEALTHY" | "DEGRADED" | "UNAVAILABLE";
  updatedAt: number;
}

export class RealtimeStateStore {
  private readonly states = new Map<string, RealtimeStockState>();
  /** Cap retained 1m bars per security (a trading day ≈ 375 minutes). */
  private readonly maxBars: number;

  constructor(maxBars = 500) {
    this.maxBars = maxBars;
  }

  private ensure(securityId: string): RealtimeStockState {
    let s = this.states.get(securityId);
    if (!s) {
      s = { securityId, lastTick: null, session: { open: NaN, high: NaN, low: NaN, last: NaN, volume: 0 }, bars1m: [], providerHealth: "DISCONNECTED", dataHealth: "UNAVAILABLE", updatedAt: 0 };
      this.states.set(securityId, s);
    }
    return s;
  }

  applyTick(tick: MarketTick): void {
    const s = this.ensure(tick.securityId);
    if (Number.isNaN(s.session.open)) {
      s.session.open = tick.price;
      s.session.high = tick.price;
      s.session.low = tick.price;
    } else {
      s.session.high = Math.max(s.session.high, tick.price);
      s.session.low = Math.min(s.session.low, tick.price);
    }
    s.session.last = tick.price;
    s.session.volume += tick.quantity;
    s.lastTick = tick;
    s.updatedAt = tick.exchangeTimestamp;
  }

  addCompletedBar(bar: CompletedBar): void {
    const s = this.ensure(bar.securityId);
    s.bars1m.push(bar);
    if (s.bars1m.length > this.maxBars) s.bars1m.splice(0, s.bars1m.length - this.maxBars);
  }

  setHealth(securityId: string, providerHealth: ProviderState, dataHealth: RealtimeStockState["dataHealth"]): void {
    const s = this.ensure(securityId);
    s.providerHealth = providerHealth;
    s.dataHealth = dataHealth;
  }

  get(securityId: string): RealtimeStockState | null {
    return this.states.get(securityId) ?? null;
  }

  all(): RealtimeStockState[] {
    return Array.from(this.states.values());
  }

  /** New session: clear intraday session accumulators and forming state, keep
   *  the store object. Completed bars are trimmed by the caller's retention. */
  resetSession(securityId: string): void {
    const s = this.states.get(securityId);
    if (s) s.session = { open: NaN, high: NaN, low: NaN, last: NaN, volume: 0 };
  }
}
