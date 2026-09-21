/**
 * LiveFeedService — owns the live market session: resolve the universe to
 * Upstox instrument keys, open the stream, accumulate ticks, and expose a
 * read-only view for the intraday surface.
 *
 * What this deliberately does NOT do: publish decisions. Ticks feed
 * monitoring (price, session bars, VWAP context, freshness) only. Promoting
 * intraday signals into the decision gate requires them to earn authority
 * through the same shadow → tier pipeline as every other setup — a real-time
 * feed changes the DATA mode, not the EVIDENCE bar. docs/system-trust-review.md
 * §4 and docs/intraday-study-notes.md §4 item 7 both spell this out.
 *
 * Lifecycle is explicit (start/stop) rather than automatic on boot, because
 * the Upstox token is a once-a-day human step: starting a feed that cannot
 * authenticate would produce a misleading DISCONNECTED banner every morning.
 */

import { NSE_UNIVERSE } from "../../data/nseUniverse";
import { upstoxInstrumentService, UpstoxInstrumentService } from "./upstoxInstruments";
import { UpstoxStreamProvider } from "./upstoxStreamProvider";
import { StreamingMarketProvider } from "./streamingMarketProvider";
import { upstoxTokenStore } from "./upstoxAuth";
import { ProviderHealth } from "./types";
import { snapshotToDataQuality } from "./marketDataProvider";

export interface LiveRow {
  ticker: string;
  instrumentKey: string;
  name: string;
  sector: string;
  price: number | null;
  changePct: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  open: number | null;
  observedVolume: number | null;
  freshness: string;
  dataQuality: string;
  ageSeconds: number | null;
  tickCount: number;
  completedBars: number;
  notes: string[];
}

export interface LiveFeedStatus {
  running: boolean;
  mode: string;
  /** Live actions are capped at this by the data mode, before any evidence gate. */
  authorityCeiling: string;
  health: ProviderHealth | null;
  universeSize: number;
  subscribed: number;
  unresolved: string[];
  ticksAccepted: number;
  ticksRejected: number;
  ticksRejectedByReason: Record<string, number>;
  securitiesWithData: number;
  tokenState: string;
  startedAt: string | null;
  note: string;
}

const MONITORING_NOTE =
  "Live ticks drive MONITORING only. A real-time feed raises the DATA mode, not the EVIDENCE bar: " +
  "intraday signals must still earn tier authority through the shadow pipeline before they can back an entry.";

export class LiveFeedService {
  private streaming: StreamingMarketProvider | null = null;
  private mapping = new Map<string, string>();
  private unresolved: string[] = [];
  private startedAt: number | null = null;

  constructor(
    private readonly instruments: UpstoxInstrumentService = upstoxInstrumentService,
    private readonly makeStream: () => UpstoxStreamProvider = () => new UpstoxStreamProvider(),
    private readonly now: () => number = Date.now
  ) {}

  isRunning(): boolean {
    return this.streaming != null;
  }

  /**
   * Resolve the universe and open the feed. Throws a pointed error when the
   * daily token is missing so the operator is told to re-authorize rather
   * than shown a generic socket failure.
   */
  async start(tickers?: string[]): Promise<LiveFeedStatus> {
    if (this.streaming) return this.status();

    const token = upstoxTokenStore.status();
    if (token.state !== "VALID") throw new Error(`Cannot start the live feed: ${token.reason}`);

    const wanted = tickers && tickers.length > 0 ? tickers : NSE_UNIVERSE.map((u) => u.ticker);
    const resolution = await this.instruments.resolve(wanted);
    this.mapping = resolution.byTicker;
    this.unresolved = resolution.unresolved;
    if (this.mapping.size === 0) throw new Error("No universe ticker resolved to an Upstox instrument key — refusing to start an empty feed");

    const streaming = new StreamingMarketProvider(this.makeStream(), { now: this.now });
    await streaming.start(this.mapping);
    this.streaming = streaming;
    this.startedAt = this.now();
    return this.status();
  }

  async stop(): Promise<LiveFeedStatus> {
    if (this.streaming) await this.streaming.stop();
    this.streaming = null;
    this.startedAt = null;
    return this.status();
  }

  status(): LiveFeedStatus {
    const stats = this.streaming?.stats() ?? { accepted: 0, rejected: 0, rejectedByReason: {}, securities: 0, started: false };
    return {
      running: this.streaming != null,
      mode: "STREAMING",
      authorityCeiling: "BUY_CANDIDATE",
      health: this.streaming?.health() ?? null,
      universeSize: NSE_UNIVERSE.length,
      subscribed: this.mapping.size,
      unresolved: this.unresolved,
      ticksAccepted: stats.accepted,
      ticksRejected: stats.rejected,
      // Per-reason, because a bare count cannot separate a benign duplicate
      // from a protocol fault (docs/live-feed-runbook.md, 2026-09-21).
      ticksRejectedByReason: stats.rejectedByReason,
      securitiesWithData: stats.securities,
      tokenState: upstoxTokenStore.status().state,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      note: MONITORING_NOTE,
    };
  }

  /** Read-only snapshot rows for the intraday surface. Never fabricates. */
  async rows(): Promise<LiveRow[]> {
    if (!this.streaming) return [];
    const meta = new Map(NSE_UNIVERSE.map((u) => [u.ticker, u]));
    const securities = [...this.mapping.entries()].map(([ticker, instrumentKey]) => ({ securityId: instrumentKey, ticker }));
    const snaps = await this.streaming.fetchUniverse(securities);
    return snaps.map((s) => {
      const state = this.streaming!.stateFor(s.securityId);
      const u = meta.get(s.ticker);
      return {
        ticker: s.ticker,
        instrumentKey: s.securityId,
        name: u?.name ?? s.ticker,
        sector: u?.sector ?? "UNKNOWN",
        price: s.price,
        changePct: s.changePct,
        dayHigh: s.dayHigh,
        dayLow: s.dayLow,
        open: s.open,
        observedVolume: s.volume,
        freshness: s.freshness,
        dataQuality: snapshotToDataQuality(s),
        ageSeconds: s.ageSeconds,
        tickCount: state?.tickCount ?? 0,
        completedBars: state?.completedBars.length ?? 0,
        notes: s.notes,
      };
    });
  }
}

export const liveFeedService = new LiveFeedService();
