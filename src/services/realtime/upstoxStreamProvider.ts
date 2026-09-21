/**
 * UpstoxStreamProvider — a genuine REAL-TIME NSE tick feed behind the existing
 * `RealtimeMarketProvider` interface (realtime/types.ts). This is the feed that
 * earns the STREAMING data mode, whose authority ceiling is BUY_CANDIDATE —
 * unlike DELAYED_CANDLES (Yahoo 5m) or SCRAPED_SNAPSHOT, both capped at WAIT.
 *
 * Protocol (upstox.com/developer/api-documentation/v3/get-market-data-feed):
 *   1. GET /v3/feed/market-data-feed/authorize with `Authorization: Bearer …`
 *      → { data: { authorized_redirect_uri } }: a SINGLE-USE wss:// URL.
 *   2. Open that URL. Subscription frames are JSON but must be sent as BINARY:
 *      { guid, method: "sub" | "unsub" | "change_mode", data: { mode, instrumentKeys } }
 *   3. Responses are PROTOBUF (MarketDataFeed.proto, vendored under ./proto),
 *      decoded to FeedResponse { type, feeds: map<string, Feed>, currentTs }.
 *
 * LIVENESS. This provider originally assumed the WebSocket layer's own
 * ping/pong would surface a dead connection. The 2026-09-21 session falsified
 * that: the socket went silent at 09:48 IST and stayed silent for 7h37m
 * WITHOUT ever emitting `close` or `error`, so nothing downstream learned the
 * feed had died (docs/live-feed-runbook.md). A hung socket is therefore
 * treated as the expected failure mode, not an exotic one:
 *   - A watchdog measures time since the last decoded message and declares the
 *     feed dead after `deadAfterMs`, independent of any transport event.
 *   - Death triggers reconnect with exponential backoff. Because Upstox's wss
 *     URL is SINGLE-USE, reconnecting re-runs the authorize step rather than
 *     reopening the old URL, and re-subscribes the full instrument set.
 *   - `close`/`error` still trigger the same path when they do fire; the
 *     watchdog is the backstop for when they do not.
 *
 * Instrument keys are `SEGMENT|ID` strings (e.g. "NSE_EQ|INE002A01018"), which
 * are used directly as the engine's securityId: stable, reversible, no mapping
 * table to drift out of date.
 *
 * Honesty rules kept identical to every other provider here:
 *  - Prices arrive as doubles in RUPEES (unlike some brokers' paise integers),
 *    so there is no scaling step — asserted in tests so a future vendor change
 *    can't silently introduce one.
 *  - Feeds without a usable last price are DROPPED, never zero-filled.
 *  - Ticks are emitted RAW; the existing TickValidator stays the firewall.
 *  - The first two messages are `initial_feed`/`market_info` snapshots, not
 *    live prints; they are decoded and surfaced but flagged, not mistaken for
 *    trades.
 *  - Socket and token lookup are injectable, so the whole protocol is testable
 *    without a network or a live broker session.
 */

import path from "path";
import protobuf from "protobufjs";
import WebSocket from "ws";
import axios from "axios";
import { MarketTick, ProviderHealth, RealtimeMarketProvider } from "./types";
import { UpstoxTokenStore, upstoxTokenStore } from "./upstoxAuth";

export const UPSTOX_AUTHORIZE_FEED_URL = "https://api.upstox.com/v3/feed/market-data-feed/authorize";
export const PROTO_PATH = path.join(__dirname, "proto", "MarketDataFeed.proto");
export const FEED_RESPONSE_TYPE = "com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse";

/** Upstox v3 subscription modes. `full` carries LTPC + 5-level depth + OHLC. */
export const FEED_MODE = { LTPC: "ltpc", FULL: "full", OPTION_GREEKS: "option_greeks", FULL_D30: "full_d30" } as const;
export type FeedMode = (typeof FEED_MODE)[keyof typeof FEED_MODE];

export const FEED_METHOD = { SUB: "sub", UNSUB: "unsub", CHANGE_MODE: "change_mode" } as const;

/** Published subscription ceilings for standard accounts (per-mode, individual). */
export const SUBSCRIPTION_LIMITS: Record<FeedMode, number> = {
  ltpc: 5000,
  full: 2000,
  option_greeks: 3000,
  full_d30: 50,
};

/** One decoded instrument update. Fields absent in the negotiated mode stay null. */
export interface UpstoxFeedUpdate {
  instrumentKey: string;
  lastTradedPrice: number;
  lastTradedTime: number | null;
  lastTradedQuantity: number | null;
  closePrice: number | null;
  volumeTradedToday: number | null;
  bestBid: number | null;
  bestAsk: number | null;
}

export interface DecodedFeedResponse {
  /** initial_feed | live_feed | market_info — only live_feed carries real prints. */
  type: string;
  currentTs: number | null;
  updates: UpstoxFeedUpdate[];
}

let cachedType: protobuf.Type | null = null;

/** Load (once) the vendored proto and return the FeedResponse message type. */
export function feedResponseType(protoPath: string = PROTO_PATH): protobuf.Type {
  if (!cachedType) cachedType = protobuf.loadSync(protoPath).lookupType(FEED_RESPONSE_TYPE);
  return cachedType;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  // protobufjs returns int64 as Long when the value exceeds 2^53.
  if (v && typeof v === "object" && "toNumber" in v) {
    const n = (v as { toNumber(): number }).toNumber();
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * PURE decoder for one protobuf frame. Every feed lacking a usable last price
 * is dropped rather than zero-filled — a fabricated ₹0 would be catastrophic
 * downstream (it would look like a −100% move).
 */
export function decodeFeedResponse(buf: Buffer, protoPath: string = PROTO_PATH): DecodedFeedResponse {
  const decoded = feedResponseType(protoPath).decode(buf);
  const obj = feedResponseType(protoPath).toObject(decoded, { longs: Number, enums: String, defaults: false }) as {
    type?: string;
    currentTs?: unknown;
    feeds?: Record<string, unknown>;
  };

  const updates: UpstoxFeedUpdate[] = [];
  for (const [instrumentKey, feedRaw] of Object.entries(obj.feeds ?? {})) {
    const feed = feedRaw as Record<string, unknown>;
    // A Feed is a oneof: ltpc | fullFeed | firstLevelWithGreeks.
    const full = feed.fullFeed as { marketFF?: Record<string, unknown>; indexFF?: Record<string, unknown> } | undefined;
    const marketFF = full?.marketFF;
    const indexFF = full?.indexFF;
    const ltpc = (feed.ltpc ?? marketFF?.ltpc ?? indexFF?.ltpc ?? (feed.firstLevelWithGreeks as Record<string, unknown>)?.ltpc) as
      | Record<string, unknown>
      | undefined;

    const ltp = num(ltpc?.ltp);
    if (ltp == null || ltp <= 0) continue; // no usable price ⇒ drop, never fabricate

    let bestBid: number | null = null;
    let bestAsk: number | null = null;
    const quotes = (marketFF?.marketLevel as { bidAskQuote?: Array<Record<string, unknown>> } | undefined)?.bidAskQuote;
    if (quotes && quotes.length > 0) {
      const bid = num(quotes[0].bidP);
      const ask = num(quotes[0].askP);
      bestBid = bid != null && bid > 0 ? bid : null;
      bestAsk = ask != null && ask > 0 ? ask : null;
    }

    updates.push({
      instrumentKey,
      lastTradedPrice: ltp,
      lastTradedTime: num(ltpc?.ltt),
      lastTradedQuantity: num(ltpc?.ltq),
      closePrice: num(ltpc?.cp),
      volumeTradedToday: marketFF ? num(marketFF.vtt) : null,
      bestBid,
      bestAsk,
    });
  }

  return { type: typeof obj.type === "string" ? obj.type : "live_feed", currentTs: num(obj.currentTs), updates };
}

/**
 * Map one decoded update to the engine's normalized tick. PURE.
 * `lastTradedTime` is the exchange's own timestamp when present; otherwise the
 * frame's currentTs. Falling back to our clock would misrepresent latency, so
 * that only happens when the vendor gives us nothing at all.
 */
export function updateToTick(u: UpstoxFeedUpdate, receivedAt: number, frameTs: number | null): MarketTick {
  return {
    securityId: u.instrumentKey,
    exchangeTimestamp: u.lastTradedTime ?? frameTs ?? receivedAt,
    receivedAt,
    price: u.lastTradedPrice,
    quantity: u.lastTradedQuantity ?? 0,
    bid: u.bestBid ?? undefined,
    ask: u.bestAsk ?? undefined,
  };
}

/** Build a subscription frame. PURE. Sent as BINARY per the vendor's spec. */
export function buildSubscriptionFrame(
  method: (typeof FEED_METHOD)[keyof typeof FEED_METHOD],
  mode: FeedMode,
  instrumentKeys: string[],
  guid: string
): Buffer {
  return Buffer.from(JSON.stringify({ guid, method, data: { mode, instrumentKeys } }));
}

export interface StreamSocket {
  send(data: Buffer | string): void;
  close(): void;
  on(event: "open" | "message" | "close" | "error", cb: (arg?: unknown) => void): void;
}

export type SocketFactory = (url: string) => StreamSocket;

const wsFactory: SocketFactory = (url) => {
  const ws = new WebSocket(url, { followRedirects: true });
  return {
    send: (d) => ws.send(d),
    close: () => ws.close(),
    on: (event, cb) => ws.on(event, cb as (...a: unknown[]) => void),
  };
};

export type AuthorizeFeed = (accessToken: string) => Promise<string>;

const axiosAuthorize: AuthorizeFeed = async (accessToken) => {
  const res = await axios.get(UPSTOX_AUTHORIZE_FEED_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    timeout: 15_000,
  });
  const uri = (res.data as { data?: { authorized_redirect_uri?: string } })?.data?.authorized_redirect_uri;
  if (!uri) throw new Error("Upstox feed authorize returned no authorized_redirect_uri");
  return uri;
};

export interface UpstoxStreamOptions {
  mode: FeedMode;
  socketFactory: SocketFactory;
  authorizeFeed: AuthorizeFeed;
  tokenStore: UpstoxTokenStore;
  now: () => number;
  protoPath: string;
  /** Ticks older than this (ms) mark the provider STALE rather than CONNECTED. */
  staleAfterMs: number;
  /**
   * Silence longer than this (ms) means the socket is DEAD, whatever the
   * transport believes, and triggers a reconnect. Must exceed the longest
   * legitimate quiet period: Upstox pushes snapshots continuously during
   * market hours, so a minute of total silence across 151 instruments is
   * already pathological.
   */
  deadAfterMs: number;
  /** How often the watchdog checks for silence. */
  watchdogIntervalMs: number;
  /** First reconnect delay; doubles each consecutive failure up to the max. */
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  /** Give up after this many consecutive failures (0 = never give up). */
  maxReconnectAttempts: number;
}

export const DEFAULT_UPSTOX_STREAM_OPTIONS: Omit<UpstoxStreamOptions, "socketFactory" | "authorizeFeed" | "tokenStore"> = {
  mode: FEED_MODE.FULL,
  now: Date.now,
  protoPath: PROTO_PATH,
  staleAfterMs: 60_000,
  deadAfterMs: 120_000,
  watchdogIntervalMs: 15_000,
  reconnectBaseMs: 2_000,
  reconnectMaxMs: 60_000,
  maxReconnectAttempts: 0,
};

export class UpstoxStreamProvider implements RealtimeMarketProvider {
  private readonly opts: UpstoxStreamOptions;
  private socket: StreamSocket | null = null;
  private tickCb: ((tick: MarketTick) => void) | null = null;
  private errorCb: ((err: unknown) => void) | null = null;
  private subscribed = new Set<string>();
  private lastTickAt: number | null = null;
  private connected = false;
  private lastError: string | undefined;
  private lastFeedType: string | null = null;
  /** Last time ANY message was decoded — the watchdog's liveness signal. */
  private lastMessageAt: number | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  /** Set by stop()/disconnect() so an in-flight reconnect does not resurrect. */
  private shuttingDown = false;
  private reconnecting = false;
  private reconnectCount = 0;
  private lastReconnectAt: number | null = null;

  constructor(opts: Partial<UpstoxStreamOptions> = {}) {
    this.opts = {
      ...DEFAULT_UPSTOX_STREAM_OPTIONS,
      socketFactory: opts.socketFactory ?? wsFactory,
      authorizeFeed: opts.authorizeFeed ?? axiosAuthorize,
      tokenStore: opts.tokenStore ?? upstoxTokenStore,
      ...opts,
    };
  }

  /**
   * Authorize, then open the single-use wss URL. Throws a pointed error when
   * the daily token is absent or expired — the operator needs to know to
   * re-authorize, not to see a generic socket failure.
   */
  async connect(): Promise<void> {
    if (this.socket) return;
    this.shuttingDown = false;
    await this.openSocket();
    this.startWatchdog();
  }

  /**
   * Authorize and open one socket. Separated from connect() because a
   * reconnect must repeat the ENTIRE sequence — the wss URL is single-use, so
   * it cannot be cached and reopened.
   */
  private async openSocket(): Promise<void> {
    const token = this.opts.tokenStore.get();
    if (!token) {
      const status = this.opts.tokenStore.status();
      this.lastError = status.reason;
      throw new Error(`Cannot open Upstox feed: ${status.reason}`);
    }

    const wssUrl = await this.opts.authorizeFeed(token.accessToken);
    const socket = this.opts.socketFactory(wssUrl);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      socket.on("open", () => {
        this.connected = true;
        this.lastError = undefined;
        // Treat the open as liveness, so the watchdog measures from here and
        // does not immediately declare a just-opened socket dead.
        this.lastMessageAt = this.opts.now();
        if (this.subscribed.size > 0) this.sendFrame(FEED_METHOD.SUB, [...this.subscribed]);
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      socket.on("message", (data) => this.handleMessage(data));
      socket.on("error", (err) => {
        this.lastError = err instanceof Error ? err.message : String(err);
        this.errorCb?.(err);
        if (!settled) {
          settled = true;
          reject(err instanceof Error ? err : new Error(this.lastError));
        } else {
          // Error after the socket was already up: treat as a death.
          this.scheduleReconnect(`socket error: ${this.lastError}`);
        }
      });
      socket.on("close", () => {
        this.connected = false;
        if (settled) this.scheduleReconnect("socket closed by peer");
      });
    });
  }

  /**
   * The backstop for a socket that hangs without ever reporting it.
   *
   * Deliberately independent of every transport event, because on 2026-09-21
   * the transport reported nothing at all for over seven hours while the feed
   * was dead. Silence is the only signal that can be trusted here.
   */
  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdog = setInterval(() => {
      if (this.shuttingDown || this.reconnecting || !this.socket) return;
      const since = this.lastMessageAt == null ? null : this.opts.now() - this.lastMessageAt;
      if (since != null && since > this.opts.deadAfterMs) {
        this.scheduleReconnect(`no message for ${Math.round(since / 1000)}s (dead after ${Math.round(this.opts.deadAfterMs / 1000)}s)`);
      }
    }, this.opts.watchdogIntervalMs);
    // Never hold the process open just to run a health check.
    this.watchdog.unref?.();
  }

  private stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  /**
   * Tear down the dead socket and reopen after a backoff.
   *
   * Reconnect is best-effort and never throws into the caller: a failed
   * attempt schedules the next one and leaves health() reporting DISCONNECTED
   * with the reason, so the outage stays visible rather than being retried
   * invisibly forever.
   */
  private scheduleReconnect(reason: string): void {
    if (this.shuttingDown || this.reconnecting) return;
    this.reconnecting = true;
    this.lastError = reason;
    this.connected = false;

    try {
      this.socket?.close();
    } catch {
      /* the socket is already gone; closing is best-effort */
    }
    this.socket = null;

    const attempt = this.reconnectAttempts;
    if (this.opts.maxReconnectAttempts > 0 && attempt >= this.opts.maxReconnectAttempts) {
      this.lastError = `${reason}; giving up after ${attempt} reconnect attempts`;
      this.reconnecting = false;
      this.stopWatchdog();
      return;
    }

    const delay = Math.min(this.opts.reconnectBaseMs * 2 ** attempt, this.opts.reconnectMaxMs);
    this.reconnectAttempts = attempt + 1;

    this.reconnectTimer = setTimeout(() => {
      void this.attemptReconnect(reason);
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async attemptReconnect(reason: string): Promise<void> {
    if (this.shuttingDown) {
      this.reconnecting = false;
      return;
    }
    try {
      await this.openSocket();
      // Success: reset the backoff and record it for the operator.
      this.reconnectAttempts = 0;
      this.reconnectCount += 1;
      this.lastReconnectAt = this.opts.now();
      this.reconnecting = false;
      this.startWatchdog();
    } catch (err) {
      this.reconnecting = false;
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = `${reason}; reconnect failed: ${msg}`;
      this.scheduleReconnect(this.lastError);
    }
  }

  async disconnect(): Promise<void> {
    this.shuttingDown = true;
    this.stopWatchdog();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnecting = false;
    this.socket?.close();
    this.socket = null;
    this.connected = false;
  }

  async subscribe(instrumentKeys: string[]): Promise<void> {
    const limit = SUBSCRIPTION_LIMITS[this.opts.mode];
    for (const k of instrumentKeys) this.subscribed.add(k);
    if (this.subscribed.size > limit) {
      const msg = `Upstox ${this.opts.mode} mode allows ${limit} instruments; ${this.subscribed.size} requested`;
      this.lastError = msg;
      throw new Error(msg);
    }
    if (this.socket && this.connected) this.sendFrame(FEED_METHOD.SUB, instrumentKeys);
  }

  async unsubscribe(instrumentKeys: string[]): Promise<void> {
    for (const k of instrumentKeys) this.subscribed.delete(k);
    if (this.socket && this.connected) this.sendFrame(FEED_METHOD.UNSUB, instrumentKeys);
  }

  onTick(cb: (tick: MarketTick) => void): void {
    this.tickCb = cb;
  }

  onError(cb: (err: unknown) => void): void {
    this.errorCb = cb;
  }

  health(): ProviderHealth {
    const now = this.opts.now();
    const tokenStatus = this.opts.tokenStore.status();
    let state: ProviderHealth["state"] = "DISCONNECTED";
    if (this.connected) {
      state = this.lastTickAt != null && now - this.lastTickAt > this.opts.staleAfterMs ? "STALE" : "CONNECTED";
    }
    // A reconnect in flight is DISCONNECTED, not STALE: the distinction the
    // 2026-09-21 outage blurred was exactly "old data" vs "no connection", and
    // an operator needs to see which one they have.
    if (this.reconnecting) state = "DISCONNECTED";

    const parts: string[] = [];
    if (this.lastError) parts.push(this.lastError);
    if (tokenStatus.state !== "VALID") parts.push(tokenStatus.reason);
    if (this.reconnectCount > 0) {
      parts.push(`${this.reconnectCount} reconnect${this.reconnectCount === 1 ? "" : "s"} this session`);
    }

    return {
      state,
      lastTickAt: this.lastTickAt,
      subscribed: this.subscribed.size,
      reason: parts.length > 0 ? parts.join("; ") : undefined,
    };
  }

  /**
   * Liveness and reconnect diagnostics, for the monitoring surface.
   *
   * `silentForMs` is the number the 2026-09-21 session needed and did not
   * have: it measures the gap since ANY frame arrived, which is what actually
   * distinguishes a dead socket from a quiet market.
   */
  linkStats(): {
    silentForMs: number | null;
    deadAfterMs: number;
    reconnects: number;
    lastReconnectAt: number | null;
    reconnecting: boolean;
  } {
    return {
      silentForMs: this.lastMessageAt == null ? null : this.opts.now() - this.lastMessageAt,
      deadAfterMs: this.opts.deadAfterMs,
      reconnects: this.reconnectCount,
      lastReconnectAt: this.lastReconnectAt,
      reconnecting: this.reconnecting,
    };
  }

  /** Last feed type seen (initial_feed / live_feed / market_info) — for diagnostics. */
  lastFeedKind(): string | null {
    return this.lastFeedType;
  }

  private sendFrame(method: (typeof FEED_METHOD)[keyof typeof FEED_METHOD], instrumentKeys: string[]): void {
    if (instrumentKeys.length === 0) return;
    const frame = buildSubscriptionFrame(method, this.opts.mode, instrumentKeys, `stocksense-${this.opts.now()}`);
    try {
      this.socket?.send(frame);
    } catch (err) {
      this.errorCb?.(err);
    }
  }

  private handleMessage(data: unknown): void {
    if (!Buffer.isBuffer(data)) return; // control/text frames carry no market data
    let decoded: DecodedFeedResponse;
    try {
      decoded = decodeFeedResponse(data, this.opts.protoPath);
    } catch (err) {
      this.errorCb?.(err);
      return;
    }
    this.lastFeedType = decoded.type;
    // Liveness is recorded for ANY successfully decoded frame, including
    // market_info and empty-update frames. Those carry no trades, but they do
    // prove the socket is alive — counting only ticks would let a quiet-but-
    // healthy feed be torn down and reconnected pointlessly.
    this.lastMessageAt = this.opts.now();
    // market_info frames describe segment status, not trades.
    if (decoded.type === "market_info" || decoded.updates.length === 0) return;

    const receivedAt = this.opts.now();
    this.lastTickAt = receivedAt;
    for (const u of decoded.updates) this.tickCb?.(updateToTick(u, receivedAt, decoded.currentTs));
  }
}
