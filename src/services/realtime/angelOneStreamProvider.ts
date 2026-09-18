/**
 * AngelOneStreamProvider — a genuine REAL-TIME NSE tick feed behind the
 * existing `RealtimeMarketProvider` interface (realtime/types.ts). This is the
 * feed that lifts the engine's data mode to STREAMING, whose authority ceiling
 * is BUY_CANDIDATE — earned, because ticks carry real intra-interval
 * observability, unlike DELAYED_CANDLES (Yahoo 5m) or SCRAPED_SNAPSHOT.
 *
 * Protocol: Angel One SmartStream v2, per their official Python SDK
 * (github.com/angel-one/smartapi-python, SmartApi/smartWebSocketV2.py):
 *   URL        wss://smartapisocket.angelone.in/smart-stream
 *   Auth       headers: Authorization (jwtToken), x-api-key, x-client-code, x-feed-token
 *   Heartbeat  send the literal text "ping" every 10s
 *   Subscribe  {correlationID, action: 1|0, params: {mode, tokenList:[{exchangeType, tokens:[]}]}}
 *   Payload    little-endian binary; common header for every mode:
 *                byte  0      subscription mode        (uint8)
 *                byte  1      exchange type            (uint8)
 *                bytes 2..27  token, null-terminated ASCII
 *                bytes 27..35 sequence number          (int64)
 *                bytes 35..43 exchange timestamp, ms   (int64)
 *                bytes 43..51 last traded price        (int64, paise)
 *              QUOTE/SNAP_QUOTE add LTQ/volume/OHLC from byte 51; SNAP_QUOTE
 *              carries best-5 depth from byte 147 and runs to byte 379.
 *
 * PRICES ARE IN PAISE and are divided by 100 here — the single most dangerous
 * field in this file, so it is isolated in one constant and asserted in tests.
 *
 * Design notes:
 *  - The binary parser is a PURE exported function: no socket needed to test it.
 *  - The WebSocket itself is injectable, so reconnect/heartbeat/subscription
 *    behaviour is unit-tested deterministically with a fake.
 *  - Ticks are emitted RAW; the existing TickValidator (realtime/tickValidator.ts)
 *    remains the firewall that decides what enters a bar. This adapter never
 *    "fixes up" a suspicious tick.
 *  - securityId is `${exchangeType}:${token}` so it is stable and reversible.
 */

import WebSocket from "ws";
import { MarketTick, ProviderHealth, RealtimeMarketProvider } from "./types";
import { AngelOneSession } from "./angelOneAuth";

export const ANGELONE_STREAM_URL = "wss://smartapisocket.angelone.in/smart-stream";
export const HEARTBEAT_MESSAGE = "ping";
export const HEARTBEAT_INTERVAL_MS = 10_000;
/** Angel One quotes every price as an integer in paise. */
export const PAISE_PER_RUPEE = 100;

export const SUBSCRIPTION_MODE = { LTP: 1, QUOTE: 2, SNAP_QUOTE: 3, DEPTH: 4 } as const;
export type SubscriptionMode = (typeof SUBSCRIPTION_MODE)[keyof typeof SUBSCRIPTION_MODE];

export const EXCHANGE_TYPE = { NSE_CM: 1, NSE_FO: 2, BSE_CM: 3, BSE_FO: 4, MCX_FO: 5, NCX_FO: 7, CDE_FO: 13 } as const;

export const ACTION = { UNSUBSCRIBE: 0, SUBSCRIBE: 1 } as const;

/** One decoded market message. Fields absent in the negotiated mode stay null. */
export interface AngelOneMessage {
  subscriptionMode: number;
  exchangeType: number;
  token: string;
  securityId: string;
  sequenceNumber: number;
  exchangeTimestamp: number;
  lastTradedPrice: number;
  lastTradedQuantity: number | null;
  volumeTradedToday: number | null;
  openPrice: number | null;
  highPrice: number | null;
  lowPrice: number | null;
  closePrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
}

const LTP_BYTES = 51;
const QUOTE_BYTES = 123;
const SNAP_QUOTE_BYTES = 379;

/** Null-terminated ASCII token from bytes 2..27. */
function readToken(buf: Buffer): string {
  const raw = buf.subarray(2, 27);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("ascii").trim();
}

/** int64 → number. Volumes/timestamps stay well inside Number.MAX_SAFE_INTEGER. */
function readI64(buf: Buffer, offset: number): number {
  return Number(buf.readBigInt64LE(offset));
}

export function securityIdFor(exchangeType: number, token: string): string {
  return `${exchangeType}:${token}`;
}

/**
 * PURE decoder for one SmartStream binary frame. Returns null when the buffer
 * is too short to be a valid message — a truncated frame is discarded, never
 * padded with zeros (a zero price would be a catastrophic fabrication).
 */
export function parseAngelOneMessage(buf: Buffer): AngelOneMessage | null {
  if (buf.length < LTP_BYTES) return null;

  const subscriptionMode = buf.readUInt8(0);
  const exchangeType = buf.readUInt8(1);
  const token = readToken(buf);
  if (!token) return null;

  const msg: AngelOneMessage = {
    subscriptionMode,
    exchangeType,
    token,
    securityId: securityIdFor(exchangeType, token),
    sequenceNumber: readI64(buf, 27),
    exchangeTimestamp: readI64(buf, 35),
    lastTradedPrice: readI64(buf, 43) / PAISE_PER_RUPEE,
    lastTradedQuantity: null,
    volumeTradedToday: null,
    openPrice: null,
    highPrice: null,
    lowPrice: null,
    closePrice: null,
    bestBid: null,
    bestAsk: null,
  };

  if (buf.length >= QUOTE_BYTES) {
    msg.lastTradedQuantity = readI64(buf, 51);
    msg.volumeTradedToday = readI64(buf, 67);
    msg.openPrice = readI64(buf, 91) / PAISE_PER_RUPEE;
    msg.highPrice = readI64(buf, 99) / PAISE_PER_RUPEE;
    msg.lowPrice = readI64(buf, 107) / PAISE_PER_RUPEE;
    msg.closePrice = readI64(buf, 115) / PAISE_PER_RUPEE;
  }

  // SNAP_QUOTE: best-5 depth occupies bytes 147..347 as twenty 20-byte packets,
  // buy side first (10) then sell side (10). We surface only the best of each.
  if (buf.length >= SNAP_QUOTE_BYTES) {
    const bestBuyPrice = readI64(buf, 147 + 4) / PAISE_PER_RUPEE;
    const bestSellPrice = readI64(buf, 147 + 10 * 20 + 4) / PAISE_PER_RUPEE;
    msg.bestBid = bestBuyPrice > 0 ? bestBuyPrice : null;
    msg.bestAsk = bestSellPrice > 0 ? bestSellPrice : null;
  }

  return msg;
}

/** Map a decoded message to the engine's normalized tick. PURE. */
export function messageToTick(msg: AngelOneMessage, receivedAt: number): MarketTick {
  return {
    securityId: msg.securityId,
    exchangeTimestamp: msg.exchangeTimestamp,
    receivedAt,
    price: msg.lastTradedPrice,
    quantity: msg.lastTradedQuantity ?? 0,
    bid: msg.bestBid ?? undefined,
    ask: msg.bestAsk ?? undefined,
    sequence: msg.sequenceNumber,
  };
}

/** Build a subscribe/unsubscribe frame. PURE — tokens grouped per exchange. */
export function buildSubscriptionRequest(
  action: (typeof ACTION)[keyof typeof ACTION],
  mode: SubscriptionMode,
  byExchange: Map<number, string[]>,
  correlationId: string
): string {
  return JSON.stringify({
    correlationID: correlationId,
    action,
    params: {
      mode,
      tokenList: [...byExchange.entries()].map(([exchangeType, tokens]) => ({ exchangeType, tokens })),
    },
  });
}

/** Split `${exchangeType}:${token}` ids back into per-exchange token lists. PURE. */
export function groupSecurityIds(securityIds: string[]): Map<number, string[]> {
  const byExchange = new Map<number, string[]>();
  for (const id of securityIds) {
    const idx = id.indexOf(":");
    if (idx <= 0) continue;
    const exchangeType = Number(id.slice(0, idx));
    const token = id.slice(idx + 1).trim();
    if (!Number.isFinite(exchangeType) || !token) continue;
    const list = byExchange.get(exchangeType) ?? [];
    if (!list.includes(token)) list.push(token);
    byExchange.set(exchangeType, list);
  }
  return byExchange;
}

/** Minimal socket surface, so tests can supply a fake. */
export interface StreamSocket {
  send(data: string): void;
  close(): void;
  on(event: "open" | "message" | "close" | "error", cb: (arg?: unknown) => void): void;
}

export type SocketFactory = (url: string, headers: Record<string, string>) => StreamSocket;

const wsFactory: SocketFactory = (url, headers) => {
  const ws = new WebSocket(url, { headers });
  return {
    send: (d) => ws.send(d),
    close: () => ws.close(),
    on: (event, cb) => ws.on(event, cb as (...a: unknown[]) => void),
  };
};

export interface AngelOneStreamOptions {
  mode: SubscriptionMode;
  socketFactory: SocketFactory;
  now: () => number;
  setInterval: (cb: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  /** Ticks older than this (ms) mark the provider STALE rather than CONNECTED. */
  staleAfterMs: number;
}

export const DEFAULT_STREAM_OPTIONS: Omit<AngelOneStreamOptions, "socketFactory"> = {
  mode: SUBSCRIPTION_MODE.SNAP_QUOTE,
  now: Date.now,
  setInterval: (cb, ms) => setInterval(cb, ms),
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
  staleAfterMs: 60_000,
};

export class AngelOneStreamProvider implements RealtimeMarketProvider {
  private readonly session: AngelOneSession;
  private readonly opts: AngelOneStreamOptions;
  private socket: StreamSocket | null = null;
  private heartbeat: unknown = null;
  private tickCb: ((tick: MarketTick) => void) | null = null;
  private errorCb: ((err: unknown) => void) | null = null;
  private subscribed = new Set<string>();
  private lastTickAt: number | null = null;
  private connected = false;
  private lastError: string | undefined;

  constructor(session: AngelOneSession, opts: Partial<AngelOneStreamOptions> & { socketFactory?: SocketFactory } = {}) {
    this.session = session;
    this.opts = { ...DEFAULT_STREAM_OPTIONS, socketFactory: opts.socketFactory ?? wsFactory, ...opts };
  }

  async connect(): Promise<void> {
    if (this.socket) return;
    const headers = {
      Authorization: this.session.jwtToken,
      "x-api-key": this.session.apiKey,
      "x-client-code": this.session.clientCode,
      "x-feed-token": this.session.feedToken,
    };
    const socket = this.opts.socketFactory(ANGELONE_STREAM_URL, headers);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      socket.on("open", () => {
        this.connected = true;
        this.lastError = undefined;
        this.heartbeat = this.opts.setInterval(() => {
          try {
            socket.send(HEARTBEAT_MESSAGE);
          } catch (err) {
            this.errorCb?.(err);
          }
        }, HEARTBEAT_INTERVAL_MS);
        // Re-subscribe after a reconnect so a dropped socket self-heals.
        if (this.subscribed.size > 0) this.sendSubscription(ACTION.SUBSCRIBE, [...this.subscribed]);
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
        if (this.heartbeat != null) {
          this.opts.clearInterval(this.heartbeat);
          this.heartbeat = null;
        }
      });
    });
  }

  async disconnect(): Promise<void> {
    if (this.heartbeat != null) {
      this.opts.clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    this.socket?.close();
    this.socket = null;
    this.connected = false;
  }

  async subscribe(securityIds: string[]): Promise<void> {
    for (const id of securityIds) this.subscribed.add(id);
    if (this.socket && this.connected) this.sendSubscription(ACTION.SUBSCRIBE, securityIds);
  }

  async unsubscribe(securityIds: string[]): Promise<void> {
    for (const id of securityIds) this.subscribed.delete(id);
    if (this.socket && this.connected) this.sendSubscription(ACTION.UNSUBSCRIBE, securityIds);
  }

  onTick(cb: (tick: MarketTick) => void): void {
    this.tickCb = cb;
  }

  onError(cb: (err: unknown) => void): void {
    this.errorCb = cb;
  }

  health(): ProviderHealth {
    const now = this.opts.now();
    let state: ProviderHealth["state"] = "DISCONNECTED";
    if (this.connected) {
      state = this.lastTickAt != null && now - this.lastTickAt > this.opts.staleAfterMs ? "STALE" : "CONNECTED";
    }
    return {
      state,
      lastTickAt: this.lastTickAt,
      subscribed: this.subscribed.size,
      reason: this.lastError,
    };
  }

  private sendSubscription(action: (typeof ACTION)[keyof typeof ACTION], securityIds: string[]): void {
    const byExchange = groupSecurityIds(securityIds);
    if (byExchange.size === 0) return;
    const frame = buildSubscriptionRequest(action, this.opts.mode, byExchange, `stocksense-${this.opts.now()}`);
    try {
      this.socket?.send(frame);
    } catch (err) {
      this.errorCb?.(err);
    }
  }

  /** Binary frames are ticks; the "pong" text reply is a liveness signal only. */
  private handleMessage(data: unknown): void {
    if (typeof data === "string") return; // pong / control text — not market data
    if (!Buffer.isBuffer(data)) return;
    const msg = parseAngelOneMessage(data);
    if (!msg) return;
    this.lastTickAt = this.opts.now();
    this.tickCb?.(messageToTick(msg, this.lastTickAt));
  }
}
