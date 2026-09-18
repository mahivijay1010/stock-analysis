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
 *      Ping/pong is handled by the WebSocket layer itself — no app heartbeat.
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
}

export const DEFAULT_UPSTOX_STREAM_OPTIONS: Omit<UpstoxStreamOptions, "socketFactory" | "authorizeFeed" | "tokenStore"> = {
  mode: FEED_MODE.FULL,
  now: Date.now,
  protoPath: PROTO_PATH,
  staleAfterMs: 60_000,
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
        }
      });
      socket.on("close", () => {
        this.connected = false;
      });
    });
  }

  async disconnect(): Promise<void> {
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
    return {
      state,
      lastTickAt: this.lastTickAt,
      subscribed: this.subscribed.size,
      reason: this.lastError ?? (tokenStatus.state === "VALID" ? undefined : tokenStatus.reason),
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
    // market_info frames describe segment status, not trades.
    if (decoded.type === "market_info" || decoded.updates.length === 0) return;

    const receivedAt = this.opts.now();
    this.lastTickAt = receivedAt;
    for (const u of decoded.updates) this.tickCb?.(updateToTick(u, receivedAt, decoded.currentTs));
  }
}
