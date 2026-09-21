/**
 * StreamingMarketProvider — the bridge between a PUSH tick feed
 * (RealtimeMarketProvider, e.g. UpstoxStreamProvider) and the PULL snapshot
 * interface the engine consumes (MarketDataProvider, used by
 * LiveEvaluationOrchestrator).
 *
 * Why this exists: those are two different shapes. The orchestrator asks
 * "give me the universe as of now"; a WebSocket instead hands you ticks as
 * they happen. This class subscribes once, accumulates per-security session
 * state from validated ticks, and answers fetchStock/fetchUniverse from that
 * accumulated state. Ticks also flow into 1-minute bars so the same data can
 * later drive the incremental feature engine.
 *
 * Honesty rules (identical in spirit to every other provider here):
 *  - mode is STREAMING — the ONLY mode that earns a BUY_CANDIDATE ceiling —
 *    but a security is only reported OK when it has actually ticked recently.
 *    A subscribed-but-silent security is FAILED/UNKNOWN, never a stale price
 *    dressed as current. Silence on a WebSocket is indistinguishable from a
 *    dead feed, so it is treated as one.
 *  - Every tick passes the existing TickValidator BEFORE it touches state or
 *    bars. Rejected ticks are counted and surfaced, never silently absorbed.
 *  - open/high/low are accumulated from the ticks WE saw this session. They
 *    are honest about their own provenance: if we connected mid-session, the
 *    "open" is our first observed price, and the snapshot says so via a note
 *    rather than implying it is the true session open.
 *  - previousClose comes from the feed's close-price field when present; it is
 *    never derived from our own first tick (that would fabricate a change %).
 */

import { MarketDataMode, MarketDataProvider, MarketSnapshot, Security } from "./marketDataProvider";
import { MarketTick, ProviderHealth, RealtimeMarketProvider, CompletedBar } from "./types";
import { OneMinuteBarBuilder } from "./barBuilder";
import { TickValidator } from "./tickValidator";

/** Accumulated live state for one security, built only from validated ticks. */
export interface StreamingSecurityState {
  securityId: string;
  ticker: string;
  lastPrice: number;
  firstObservedPrice: number;
  high: number;
  low: number;
  /** Cumulative traded quantity WE observed (not the exchange's session volume). */
  observedQuantity: number;
  /** Exchange-reported previous close, when the feed supplies one. */
  previousClose: number | null;
  bid: number | null;
  ask: number | null;
  lastExchangeTimestamp: number;
  lastReceivedAt: number;
  tickCount: number;
  /** True when the first tick arrived after the session had already begun. */
  joinedMidSession: boolean;
  completedBars: CompletedBar[];
}

export interface StreamingProviderOptions {
  /** A security with no tick newer than this is not reported as OK. */
  maxTickAgeMs: number;
  /** Retain at most this many 1-minute bars per security (memory bound). */
  maxBarsPerSecurity: number;
  now: () => number;
  /** IST session open, used only to label joinedMidSession honestly. */
  sessionOpenMsOf: (now: number) => number;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** 09:15 IST of the IST day containing `now`, as a ms epoch. PURE. */
export function istSessionOpenMs(now: number): number {
  const ist = new Date(now + IST_OFFSET_MS);
  return Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 9, 15) - IST_OFFSET_MS;
}

export const DEFAULT_STREAMING_OPTIONS: StreamingProviderOptions = {
  maxTickAgeMs: 90_000,
  maxBarsPerSecurity: 420, // a full 6h15m session of 1-minute bars
  now: Date.now,
  sessionOpenMsOf: istSessionOpenMs,
};

export class StreamingMarketProvider implements MarketDataProvider {
  readonly mode: MarketDataMode = "STREAMING";
  private readonly opts: StreamingProviderOptions;
  private readonly state = new Map<string, StreamingSecurityState>();
  private readonly builders = new Map<string, OneMinuteBarBuilder>();
  private readonly validator: TickValidator;
  /** instrumentKey → ticker, so a tick can be attributed to a universe name. */
  private readonly tickerByInstrumentKey = new Map<string, string>();
  private rejectedTicks = 0;
  private acceptedTicks = 0;
  /**
   * Rejections BY REASON.
   *
   * A bare rejected-tick counter cannot distinguish a harmless duplicate from
   * a real protocol fault. The 2026-09-21 session (docs/live-feed-runbook.md)
   * showed a steady ~19% rejection rate that turned out to be Upstox re-sending
   * unchanged LTP snapshots — correct behaviour — but diagnosing that required
   * reading the source and replaying the validator offline, because the reason
   * was thrown away here. DUPLICATE proportional to frame rate is expected;
   * STALE outside the pre-open snapshot, SEQUENCE_GAP or INVALID growing with
   * volume are not. That distinction has to be visible from the outside.
   */
  private readonly rejectedByReason = new Map<string, number>();
  private started = false;

  constructor(
    private readonly stream: RealtimeMarketProvider,
    opts: Partial<StreamingProviderOptions> = {},
    validator: TickValidator = new TickValidator()
  ) {
    this.opts = { ...DEFAULT_STREAMING_OPTIONS, ...opts };
    this.validator = validator;
  }

  /**
   * Connect, register the instrument-key→ticker mapping, and subscribe.
   * Idempotent: calling twice does not double-subscribe.
   */
  async start(mapping: Map<string, string>): Promise<void> {
    for (const [ticker, instrumentKey] of mapping) this.tickerByInstrumentKey.set(instrumentKey, ticker);
    if (this.started) return;
    this.stream.onTick((tick) => this.ingest(tick));
    await this.stream.connect();
    await this.stream.subscribe([...mapping.values()]);
    this.started = true;
  }

  async stop(): Promise<void> {
    await this.stream.disconnect();
    this.started = false;
  }

  /** Feed one tick through validation into state + bars. Returns acceptance. */
  ingest(tick: MarketTick): boolean {
    const verdict = this.validator.validate(tick);
    if (verdict.status !== "VALID") {
      this.rejectedTicks++;
      this.rejectedByReason.set(verdict.status, (this.rejectedByReason.get(verdict.status) ?? 0) + 1);
      return false;
    }
    this.acceptedTicks++;
    const ticker = this.tickerByInstrumentKey.get(tick.securityId) ?? tick.securityId;

    let s = this.state.get(tick.securityId);
    if (!s) {
      const sessionOpen = this.opts.sessionOpenMsOf(this.opts.now());
      s = {
        securityId: tick.securityId,
        ticker,
        lastPrice: tick.price,
        firstObservedPrice: tick.price,
        high: tick.price,
        low: tick.price,
        observedQuantity: 0,
        previousClose: null,
        bid: null,
        ask: null,
        lastExchangeTimestamp: tick.exchangeTimestamp,
        lastReceivedAt: tick.receivedAt,
        tickCount: 0,
        // If our first tick lands well after the open, our "open" is not the
        // session's real open — record that rather than implying otherwise.
        joinedMidSession: tick.exchangeTimestamp > sessionOpen + 60_000,
        completedBars: [],
      };
      this.state.set(tick.securityId, s);
    }

    s.lastPrice = tick.price;
    if (tick.price > s.high) s.high = tick.price;
    if (tick.price < s.low) s.low = tick.price;
    s.observedQuantity += tick.quantity;
    if (tick.bid != null) s.bid = tick.bid;
    if (tick.ask != null) s.ask = tick.ask;
    s.lastExchangeTimestamp = tick.exchangeTimestamp;
    s.lastReceivedAt = tick.receivedAt;
    s.tickCount++;

    let builder = this.builders.get(tick.securityId);
    if (!builder) {
      builder = new OneMinuteBarBuilder(tick.securityId);
      this.builders.set(tick.securityId, builder);
    }
    const closed = builder.addTick(tick);
    if (closed) {
      s.completedBars.push(closed);
      if (s.completedBars.length > this.opts.maxBarsPerSecurity) s.completedBars.shift();
    }
    return true;
  }

  /** Exchange-reported previous close, when a caller has it from elsewhere. */
  setPreviousClose(instrumentKey: string, previousClose: number | null): void {
    const s = this.state.get(instrumentKey);
    if (s) s.previousClose = previousClose;
  }

  /** Completed 1-minute bars for a security — the feature engine's input. */
  barsFor(instrumentKey: string): CompletedBar[] {
    return this.state.get(instrumentKey)?.completedBars ?? [];
  }

  stateFor(instrumentKey: string): StreamingSecurityState | null {
    return this.state.get(instrumentKey) ?? null;
  }

  async fetchStock(security: Security): Promise<MarketSnapshot> {
    return this.snapshotOf(security);
  }

  async fetchUniverse(securities: Security[]): Promise<MarketSnapshot[]> {
    return securities.map((s) => this.snapshotOf(s));
  }

  /**
   * Build a snapshot from accumulated state. A security we have never heard
   * from, or one that has gone quiet, is reported FAILED/STALE — never a last
   * known price presented as current.
   */
  private snapshotOf(security: Security): MarketSnapshot {
    const now = this.opts.now();
    const s = this.state.get(security.securityId);
    const base: MarketSnapshot = {
      securityId: security.securityId,
      ticker: security.ticker,
      mode: this.mode,
      price: null, previousClose: null, open: null, dayHigh: null, dayLow: null,
      volume: null, changePct: null, bid: null, ask: null,
      fetchedAt: now, sourceTimestamp: null, ageSeconds: null,
      freshness: "FAILED", quality: "FAILED",
      sources: [this.stream.constructor.name],
      notes: [],
    };

    if (!s) {
      base.notes.push("subscribed but no tick has ever been received for this security");
      return base;
    }

    const ageMs = now - s.lastReceivedAt;
    base.price = s.lastPrice;
    base.open = s.firstObservedPrice;
    base.dayHigh = s.high;
    base.dayLow = s.low;
    base.volume = s.observedQuantity > 0 ? s.observedQuantity : null;
    base.previousClose = s.previousClose;
    base.bid = s.bid;
    base.ask = s.ask;
    base.sourceTimestamp = s.lastExchangeTimestamp;
    base.ageSeconds = Math.round(ageMs / 1000);
    base.changePct =
      s.previousClose != null && s.previousClose > 0 ? ((s.lastPrice - s.previousClose) / s.previousClose) * 100 : null;

    if (ageMs > this.opts.maxTickAgeMs) {
      base.freshness = "STALE";
      base.quality = "OK"; // the data is real, just old — the ceiling logic handles it
      base.notes.push(`no tick for ${Math.round(ageMs / 1000)}s (limit ${Math.round(this.opts.maxTickAgeMs / 1000)}s)`);
    } else {
      base.freshness = "FRESH";
      base.quality = "OK";
    }

    if (s.joinedMidSession) {
      base.notes.push("open/high/low accumulated from our first observed tick — we joined mid-session, so these are NOT the exchange session values");
    }
    if (s.previousClose == null) {
      base.notes.push("no exchange previous close available — change % withheld rather than derived from our own first tick");
    }
    base.notes.push(`${s.tickCount} validated ticks, ${s.completedBars.length} completed 1m bars`);
    return base;
  }

  health(): ProviderHealth {
    const upstream = this.stream.health();
    return {
      ...upstream,
      // Name the reasons, not just the count: "19% rejected" reads as a fault,
      // "19% rejected, all DUPLICATE" reads as the vendor re-sending unchanged
      // snapshots. Only the second is actionable.
      reason:
        this.rejectedTicks > 0
          ? `${upstream.reason ? upstream.reason + "; " : ""}${this.rejectedTicks} ticks rejected by the validator ` +
            `(${this.acceptedTicks} accepted) — ${this.reasonBreakdown()}`
          : upstream.reason,
    };
  }

  /** "DUPLICATE 2171, STALE 151" — most frequent first. */
  private reasonBreakdown(): string {
    return [...this.rejectedByReason.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => `${reason} ${n}`)
      .join(", ");
  }

  stats(): {
    accepted: number;
    rejected: number;
    rejectedByReason: Record<string, number>;
    securities: number;
    started: boolean;
  } {
    return {
      accepted: this.acceptedTicks,
      rejected: this.rejectedTicks,
      rejectedByReason: Object.fromEntries(this.rejectedByReason),
      securities: this.state.size,
      started: this.started,
    };
  }
}
