/**
 * Upstox real-time feed — OAuth/token lifecycle and the v3 Protobuf market
 * data protocol. Frames are ENCODED with the vendored proto and decoded back,
 * so a schema or field-path change fails here rather than in production.
 *
 * The daily-expiry rule (03:30 IST, no refresh tokens) is the operational
 * heart of this integration, so nextTokenExpiry gets boundary tests rather
 * than a happy-path one.
 */

import protobuf from "protobufjs";
import {
  buildAuthorizationUrl,
  describeConfig,
  exchangeCodeForToken,
  nextTokenExpiry,
  readUpstoxCredentials,
  UPSTOX_AUTHORIZE_URL,
  UpstoxTokenStore,
  UpstoxToken,
} from "../src/services/realtime/upstoxAuth";
import {
  buildSubscriptionFrame,
  decodeFeedResponse,
  FEED_METHOD,
  FEED_MODE,
  feedResponseType,
  PROTO_PATH,
  StreamSocket,
  SUBSCRIPTION_LIMITS,
  updateToTick,
  UpstoxStreamProvider,
} from "../src/services/realtime/upstoxStreamProvider";
import { TickValidator } from "../src/services/realtime/tickValidator";
import { capActionByMode, modeAuthorityCeiling } from "../src/services/realtime/marketDataProvider";

const KEY = "NSE_EQ|INE002A01018"; // Reliance
const LTT = Date.UTC(2026, 8, 18, 5, 15, 0);

/** proto enum Type { initial_feed = 0; live_feed = 1; market_info = 2; } —
 *  encoding needs the NUMERIC value; decodeFeedResponse maps back to the name. */
const TYPE = { initial_feed: 0, live_feed: 1, market_info: 2 } as const;

/** Encode a FeedResponse exactly as the vendor would. */
function encodeFeed(payload: Record<string, unknown>): Buffer {
  const type = feedResponseType(PROTO_PATH);
  const err = type.verify(payload);
  if (err) throw new Error(`fixture does not satisfy the proto: ${err}`);
  return Buffer.from(type.encode(type.create(payload)).finish());
}

function fullFeedFrame(over: { ltp?: number; ltq?: number; cp?: number; vtt?: number; bidP?: number; askP?: number; type?: number } = {}): Buffer {
  const o = { ltp: 1243.6, ltq: 150, cp: 1239, vtt: 4820331, bidP: 1243.55, askP: 1243.65, type: TYPE.live_feed, ...over };
  return encodeFeed({
    type: o.type,
    currentTs: LTT + 20,
    feeds: {
      [KEY]: {
        fullFeed: {
          marketFF: {
            ltpc: { ltp: o.ltp, ltt: LTT, ltq: o.ltq, cp: o.cp },
            marketLevel: { bidAskQuote: [{ bidQ: 10, bidP: o.bidP, askQ: 12, askP: o.askP }] },
            vtt: o.vtt,
          },
        },
      },
    },
  });
}

describe("Protobuf decoding (v3 MarketDataFeed.proto)", () => {
  test("the vendored proto loads and exposes FeedResponse", () => {
    expect(feedResponseType(PROTO_PATH)).toBeInstanceOf(protobuf.Type);
  });

  test("full feed: LTPC + depth + volume decoded, prices in RUPEES (no paise scaling)", () => {
    const d = decodeFeedResponse(fullFeedFrame());
    expect(d.type).toBe("live_feed");
    expect(d.updates).toHaveLength(1);
    const u = d.updates[0];
    expect(u.instrumentKey).toBe(KEY);
    expect(u.lastTradedPrice).toBe(1243.6); // NOT 124360 — Upstox sends doubles in rupees
    expect(u.lastTradedQuantity).toBe(150);
    expect(u.closePrice).toBe(1239);
    expect(u.volumeTradedToday).toBe(4820331);
    expect(u.bestBid).toBe(1243.55);
    expect(u.bestAsk).toBe(1243.65);
    expect(u.lastTradedTime).toBe(LTT);
  });

  test("ltpc-only feed decodes without depth fields rather than zero-filling them", () => {
    const buf = encodeFeed({ type: TYPE.live_feed, currentTs: LTT, feeds: { [KEY]: { ltpc: { ltp: 1250.25, ltt: LTT, ltq: 5, cp: 1240 } } } });
    const u = decodeFeedResponse(buf).updates[0];
    expect(u.lastTradedPrice).toBe(1250.25);
    expect(u.bestBid).toBeNull();
    expect(u.bestAsk).toBeNull();
    expect(u.volumeTradedToday).toBeNull();
  });

  test("index feed (indexFF) decodes through the same path", () => {
    const buf = encodeFeed({
      type: TYPE.live_feed,
      currentTs: LTT,
      feeds: { "NSE_INDEX|Nifty 50": { fullFeed: { indexFF: { ltpc: { ltp: 25130.4, ltt: LTT, ltq: 0, cp: 25000 } } } } },
    });
    const u = decodeFeedResponse(buf).updates[0];
    expect(u.instrumentKey).toBe("NSE_INDEX|Nifty 50");
    expect(u.lastTradedPrice).toBe(25130.4);
  });

  test("a feed with no usable price is DROPPED, never emitted as ₹0", () => {
    expect(decodeFeedResponse(fullFeedFrame({ ltp: 0 })).updates).toHaveLength(0);
    const empty = encodeFeed({ type: TYPE.live_feed, currentTs: LTT, feeds: { [KEY]: {} } });
    expect(decodeFeedResponse(empty).updates).toHaveLength(0);
  });

  test("zero depth prices report null rather than a real ₹0 bid/ask", () => {
    const u = decodeFeedResponse(fullFeedFrame({ bidP: 0, askP: 0 })).updates[0];
    expect(u.bestBid).toBeNull();
    expect(u.bestAsk).toBeNull();
  });

  test("updateToTick maps onto the engine's shape and passes the TickValidator", () => {
    const u = decodeFeedResponse(fullFeedFrame()).updates[0];
    const tick = updateToTick(u, LTT + 40, LTT + 20);
    expect(tick).toMatchObject({ securityId: KEY, price: 1243.6, quantity: 150, exchangeTimestamp: LTT });
    expect(new TickValidator().validate(tick).status).toBe("VALID");
  });

  test("without an exchange timestamp the frame's currentTs is used before our own clock", () => {
    const u = { instrumentKey: KEY, lastTradedPrice: 10, lastTradedTime: null, lastTradedQuantity: null, closePrice: null, volumeTradedToday: null, bestBid: null, bestAsk: null };
    expect(updateToTick(u, 999, 500).exchangeTimestamp).toBe(500);
    expect(updateToTick(u, 999, null).exchangeTimestamp).toBe(999);
  });
});

describe("subscription frames", () => {
  test("binary JSON in the documented shape", () => {
    const frame = buildSubscriptionFrame(FEED_METHOD.SUB, FEED_MODE.FULL, [KEY], "guid-1");
    expect(Buffer.isBuffer(frame)).toBe(true); // vendor requires BINARY, not text
    expect(JSON.parse(frame.toString())).toEqual({ guid: "guid-1", method: "sub", data: { mode: "full", instrumentKeys: [KEY] } });
    expect(JSON.parse(buildSubscriptionFrame(FEED_METHOD.UNSUB, FEED_MODE.LTPC, [KEY], "g").toString()).method).toBe("unsub");
  });
});

// ── token lifecycle ──────────────────────────────────────────────────────────

const IST = 5.5 * 60 * 60 * 1000;
const istMs = (y: number, m: number, d: number, h: number, min = 0) => Date.UTC(y, m, d, h, min) - IST;

describe("token expiry — 03:30 IST daily, no refresh tokens", () => {
  test("a token minted in the evening expires at 03:30 IST the NEXT morning", () => {
    expect(nextTokenExpiry(istMs(2026, 8, 18, 20, 0))).toBe(istMs(2026, 8, 19, 3, 30));
  });

  test("a token minted at 02:30 IST expires at 03:30 IST the SAME morning (one hour later)", () => {
    expect(nextTokenExpiry(istMs(2026, 8, 18, 2, 30))).toBe(istMs(2026, 8, 18, 3, 30));
  });

  test("exactly at 03:30 IST the boundary rolls to the next day, never to itself", () => {
    const at = istMs(2026, 8, 18, 3, 30);
    expect(nextTokenExpiry(at)).toBe(istMs(2026, 8, 19, 3, 30));
  });

  test("month and year boundaries are handled", () => {
    expect(nextTokenExpiry(istMs(2026, 8, 30, 23, 0))).toBe(istMs(2026, 9, 1, 3, 30));
    expect(nextTokenExpiry(istMs(2026, 11, 31, 23, 0))).toBe(istMs(2027, 0, 1, 3, 30));
  });
});

describe("UpstoxTokenStore", () => {
  const token = (expiresAt: number): UpstoxToken => ({ accessToken: "T", issuedAt: 0, expiresAt, userId: "U1" });

  test("absent ⇒ ABSENT with a pointer to the login route", () => {
    const s = new UpstoxTokenStore(() => 1000);
    expect(s.get()).toBeNull();
    expect(s.isValid()).toBe(false);
    expect(s.status()).toMatchObject({ state: "ABSENT" });
    expect(s.status().reason).toMatch(/authorize at \/api\/auth\/upstox\/login/);
  });

  test("an expired token is never returned — it reports EXPIRED and explains why", () => {
    let now = 1000;
    const s = new UpstoxTokenStore(() => now);
    s.set(token(5000));
    expect(s.isValid()).toBe(true);
    now = 5000;
    expect(s.get()).toBeNull(); // boundary is inclusive: at expiry it is already dead
    expect(s.status().state).toBe("EXPIRED");
    expect(s.status().reason).toMatch(/03:30 IST daily; no refresh tokens/);
  });

  test("state guards the OAuth round trip and is single-use", () => {
    const s = new UpstoxTokenStore(() => 0);
    const st = s.newState(() => "abc");
    expect(st).toBe("st-abc");
    expect(s.consumeState("wrong")).toBe(false);
    expect(s.consumeState(st)).toBe(true);
    expect(s.consumeState(st)).toBe(false); // replay refused
    expect(s.consumeState(null)).toBe(false);
  });
});

describe("OAuth wiring", () => {
  const env = { UPSTOX_API_KEY: "k", UPSTOX_API_SECRET: "s" } as NodeJS.ProcessEnv;

  test("credentials require key+secret; redirect URI defaults to the local callback", () => {
    expect(readUpstoxCredentials(env)).toMatchObject({ apiKey: "k", apiSecret: "s", redirectUri: "http://localhost:5101/api/auth/upstox/callback" });
    expect(readUpstoxCredentials({ UPSTOX_API_KEY: "k" } as NodeJS.ProcessEnv)).toBeNull();
    expect(readUpstoxCredentials({})).toBeNull();
  });

  test("describeConfig names what is missing without revealing a value", () => {
    const d = describeConfig({ UPSTOX_API_KEY: "k" } as NodeJS.ProcessEnv);
    expect(d).toEqual({ configured: false, missing: ["UPSTOX_API_SECRET"] });
    expect(JSON.stringify(d)).not.toContain("k");
  });

  test("authorization URL carries the documented query parameters", () => {
    const url = new URL(buildAuthorizationUrl(readUpstoxCredentials(env)!, "st-1"));
    expect(`${url.origin}${url.pathname}`).toBe(UPSTOX_AUTHORIZE_URL);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("k");
    expect(url.searchParams.get("state")).toBe("st-1");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:5101/api/auth/upstox/callback");
  });

  test("code exchange posts form-encoded fields and derives the 03:30 expiry", async () => {
    let seen: { url: string; body: string; headers: Record<string, string> } | null = null;
    const issued = istMs(2026, 8, 18, 20, 0);
    const tok = await exchangeCodeForToken(
      readUpstoxCredentials(env)!,
      "CODE",
      async (url, body, headers) => {
        seen = { url, body, headers };
        return { access_token: "ACC", user_id: "U1" };
      },
      () => issued
    );
    const form = new URLSearchParams(seen!.body);
    expect(seen!.url).toMatch(/authorization\/token$/);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("CODE");
    expect(form.get("client_secret")).toBe("s");
    expect(seen!.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(tok).toMatchObject({ accessToken: "ACC", userId: "U1", issuedAt: issued });
    expect(tok.expiresAt).toBe(istMs(2026, 8, 19, 3, 30));
  });

  test("a rejected exchange throws loudly rather than yielding a token-less session", async () => {
    await expect(
      exchangeCodeForToken(readUpstoxCredentials(env)!, "BAD", async () => ({ errors: [{ message: "Invalid auth code" }] }))
    ).rejects.toThrow(/Invalid auth code/);
  });
});

// ── provider behaviour (fake socket) ─────────────────────────────────────────

class FakeSocket implements StreamSocket {
  sent: Array<Buffer | string> = [];
  closed = false;
  private handlers = new Map<string, (arg?: unknown) => void>();
  constructor(readonly url: string) {}
  send(d: Buffer | string): void {
    this.sent.push(d);
  }
  close(): void {
    this.closed = true;
    this.handlers.get("close")?.();
  }
  on(event: string, cb: (arg?: unknown) => void): void {
    this.handlers.set(event, cb);
  }
  emit(event: string, arg?: unknown): void {
    this.handlers.get(event)?.(arg);
  }
}

function makeProvider(over: Record<string, unknown> = {}) {
  let socket!: FakeSocket;
  let clock = LTT;
  const store = new UpstoxTokenStore(() => clock);
  store.set({ accessToken: "ACC", issuedAt: 0, expiresAt: LTT + 3_600_000, userId: "U1" });
  const provider = new UpstoxStreamProvider({
    tokenStore: store,
    authorizeFeed: async () => "wss://authorized.example/feed?code=one-time",
    socketFactory: (url) => (socket = new FakeSocket(url)),
    now: () => clock,
    ...over,
  });
  /** connect() awaits the authorize call before opening the socket, so wait
   *  for the fake to be constructed, then drive it. */
  const openSocket = async (): Promise<FakeSocket> => {
    for (let i = 0; i < 50 && !socket; i++) await new Promise((r) => setImmediate(r));
    if (!socket) throw new Error("socket was never created");
    socket.emit("open");
    return socket;
  };
  return { provider, store, getSocket: () => socket, openSocket, setClock: (t: number) => { clock = t; } };
}

describe("UpstoxStreamProvider", () => {
  test("authorizes first, then connects to the single-use wss URL", async () => {
    const { provider, getSocket, openSocket } = makeProvider();
    const p = provider.connect();
    await openSocket();
    await p;
    expect(getSocket().url).toBe("wss://authorized.example/feed?code=one-time");
  });

  test("refuses to connect without a valid token, naming the fix", async () => {
    const { provider, store } = makeProvider();
    store.clear();
    await expect(provider.connect()).rejects.toThrow(/authorize at \/api\/auth\/upstox\/login/);
  });

  test("an expired token blocks connection with the 03:30 explanation", async () => {
    const { provider, setClock } = makeProvider();
    setClock(LTT + 7_200_000); // past expiry
    await expect(provider.connect()).rejects.toThrow(/expired/);
  });

  test("protobuf frames become ticks; market_info frames do not", async () => {
    const { provider, getSocket, openSocket } = makeProvider();
    const ticks: unknown[] = [];
    provider.onTick((t) => ticks.push(t));
    const p = provider.connect();
    await openSocket();
    await p;

    getSocket().emit("message", encodeFeed({ type: TYPE.market_info, currentTs: LTT, marketInfo: { segmentStatus: { NSE_EQ: 2 } } /* MarketStatus.NORMAL_OPEN */ }));
    expect(ticks).toHaveLength(0);
    expect(provider.lastFeedKind()).toBe("market_info");

    getSocket().emit("message", fullFeedFrame());
    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toMatchObject({ securityId: KEY, price: 1243.6 });
    expect(provider.lastFeedKind()).toBe("live_feed");
  });

  test("a malformed frame surfaces to onError without killing the stream", async () => {
    const { provider, getSocket, openSocket } = makeProvider();
    const errors: unknown[] = [];
    const ticks: unknown[] = [];
    provider.onError((e) => errors.push(e));
    provider.onTick((t) => ticks.push(t));
    const p = provider.connect();
    await openSocket();
    await p;
    getSocket().emit("message", Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]));
    expect(errors.length).toBeGreaterThan(0);
    getSocket().emit("message", fullFeedFrame());
    expect(ticks).toHaveLength(1); // still alive
  });

  test("subscriptions made before connect are replayed on open (reconnect self-heals)", async () => {
    const { provider, getSocket, openSocket } = makeProvider();
    await provider.subscribe([KEY]);
    const p = provider.connect();
    await openSocket();
    await p;
    const frame = JSON.parse((getSocket().sent[0] as Buffer).toString());
    expect(frame).toMatchObject({ method: "sub", data: { mode: "full", instrumentKeys: [KEY] } });
    expect(provider.health().subscribed).toBe(1);
  });

  test("exceeding the mode's published instrument limit throws rather than silently truncating", async () => {
    const { provider } = makeProvider({ mode: FEED_MODE.FULL });
    const tooMany = Array.from({ length: SUBSCRIPTION_LIMITS.full + 1 }, (_, i) => `NSE_EQ|X${i}`);
    await expect(provider.subscribe(tooMany)).rejects.toThrow(/allows 2000 instruments/);
  });

  test("health: DISCONNECTED → CONNECTED on ticks → STALE when they dry up", async () => {
    const { provider, getSocket, openSocket, setClock } = makeProvider({ staleAfterMs: 60_000 });
    expect(provider.health().state).toBe("DISCONNECTED");
    const p = provider.connect();
    await openSocket();
    await p;
    getSocket().emit("message", fullFeedFrame());
    expect(provider.health().state).toBe("CONNECTED");
    setClock(LTT + 61_000);
    expect(provider.health().state).toBe("STALE");
  });

  test("disconnect closes the socket and stops reporting CONNECTED", async () => {
    const { provider, getSocket, openSocket } = makeProvider();
    const p = provider.connect();
    await openSocket();
    await p;
    await provider.disconnect();
    expect(getSocket().closed).toBe(true);
    expect(provider.health().state).toBe("DISCONNECTED");
  });
});

describe("STREAMING is the mode a real-time feed earns", () => {
  test("STREAMING lifts the ceiling; the delayed and scraped modes do not", () => {
    expect(modeAuthorityCeiling("STREAMING")).toBe("BUY_CANDIDATE");
    expect(capActionByMode("BUY_CANDIDATE", "STREAMING")).toBe("BUY_CANDIDATE");
    expect(capActionByMode("BUY_CANDIDATE", "DELAYED_CANDLES")).toBe("WAIT");
    expect(capActionByMode("BUY_CANDIDATE", "SCRAPED_SNAPSHOT")).toBe("WAIT");
  });
});

/**
 * Liveness: the watchdog, reconnect, and the metrics that made the
 * 2026-09-21 outage invisible (docs/live-feed-runbook.md).
 *
 * That session's socket went silent at 09:48 IST and stayed silent for 7h37m
 * without ever emitting `close` or `error`. Every test here pins one part of
 * the guarantee that this cannot happen silently again.
 */
describe("UpstoxStreamProvider — surviving a hung socket", () => {
  // Fake timers only inside this block: the watchdog is an interval, and the
  // surrounding suite relies on real timers.
  beforeEach(() => jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] }));
  afterEach(() => jest.useRealTimers());

  test("a socket that goes silent WITHOUT close/error is detected and reconnected", async () => {
    let authorizeCalls = 0;
    const sockets: FakeSocket[] = [];
    let clock = LTT;
    const store = new UpstoxTokenStore(() => clock);
    store.set({ accessToken: "ACC", issuedAt: 0, expiresAt: LTT + 3_600_000, userId: "U1" });

    const provider = new UpstoxStreamProvider({
      tokenStore: store,
      authorizeFeed: async () => {
        authorizeCalls++;
        return `wss://authorized.example/feed?code=${authorizeCalls}`;
      },
      socketFactory: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      now: () => clock,
      deadAfterMs: 60_000,
      watchdogIntervalMs: 1_000,
      reconnectBaseMs: 1,
    });

    const p = provider.connect();
    for (let i = 0; i < 50 && sockets.length === 0; i++) await new Promise((r) => setImmediate(r));
    sockets[0].emit("open");
    await p;
    expect(authorizeCalls).toBe(1);

    // The socket emits NOTHING — no message, no close, no error — and time
    // passes well beyond the dead threshold. This is the exact 2026-09-21
    // failure: the transport reports perfect health while the feed is dead.
    clock += 120_000;
    jest.advanceTimersByTime(1_000); // one watchdog tick detects the silence
    await new Promise((r) => setImmediate(r));
    jest.advanceTimersByTime(1_000); // then the backoff timer fires

    // Reconnect must re-AUTHORIZE, because the wss URL is single-use.
    for (let i = 0; i < 50 && sockets.length < 2; i++) await new Promise((r) => setImmediate(r));
    expect(authorizeCalls).toBe(2);
    expect(sockets.length).toBe(2);
    expect(sockets[1].url).not.toBe(sockets[0].url);
  });

  test("a healthy socket is never torn down, even when no TRADES arrive", async () => {
    // A quiet market still sends frames. Only total silence is death.
    const { provider, openSocket, setClock } = makeProvider({
      deadAfterMs: 60_000,
      watchdogIntervalMs: 1_000,
    });
    const p = provider.connect();
    const socket = await openSocket();
    await p;

    setClock(LTT + 30_000);
    socket.emit("message", encodeFeed({ type: TYPE.market_info, currentTs: LTT + 30_000, feeds: {} })); // no trades
    setClock(LTT + 50_000);
    jest.advanceTimersByTime(1_000);

    expect(provider.linkStats().reconnects).toBe(0);
    expect(provider.linkStats().reconnecting).toBe(false);
  });

  test("linkStats reports how long the link has been silent — the number the outage lacked", async () => {
    const { provider, openSocket, setClock } = makeProvider({ deadAfterMs: 60_000 });
    const p = provider.connect();
    await openSocket();
    await p;

    setClock(LTT + 45_000);
    const stats = provider.linkStats();
    expect(stats.silentForMs).toBe(45_000);
    expect(stats.deadAfterMs).toBe(60_000);
  });

  test("disconnect() stops the watchdog — a deliberate stop never resurrects itself", async () => {
    let authorizeCalls = 0;
    const sockets: FakeSocket[] = [];
    let clock = LTT;
    const store = new UpstoxTokenStore(() => clock);
    store.set({ accessToken: "ACC", issuedAt: 0, expiresAt: LTT + 3_600_000, userId: "U1" });

    const provider = new UpstoxStreamProvider({
      tokenStore: store,
      authorizeFeed: async () => {
        authorizeCalls++;
        return `wss://authorized.example/feed?code=${authorizeCalls}`;
      },
      socketFactory: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      now: () => clock,
      deadAfterMs: 60_000,
      watchdogIntervalMs: 1_000,
      reconnectBaseMs: 1,
    });

    const p = provider.connect();
    for (let i = 0; i < 50 && sockets.length === 0; i++) await new Promise((r) => setImmediate(r));
    sockets[0].emit("open");
    await p;

    await provider.disconnect();
    clock += 300_000;
    jest.advanceTimersByTime(10_000);
    await new Promise((r) => setImmediate(r));

    expect(authorizeCalls).toBe(1); // no reconnect attempted
    expect(provider.health().state).toBe("DISCONNECTED");
  });
});
