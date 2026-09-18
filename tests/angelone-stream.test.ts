/**
 * Angel One SmartAPI real-time feed — auth wiring + the SmartStream v2 binary
 * protocol. Frames are constructed byte-by-byte against the documented layout
 * (angel-one/smartapi-python, SmartApi/smartWebSocketV2.py), so a silent change
 * to an offset or the paise divisor fails here rather than in production.
 *
 * The most dangerous field in the whole adapter is the price: Angel One sends
 * integers in PAISE. A missing ÷100 would put every price 100× too high and
 * every stop 100× too far away, so it is asserted explicitly.
 */

import {
  ACTION,
  AngelOneStreamProvider,
  ANGELONE_STREAM_URL,
  buildSubscriptionRequest,
  EXCHANGE_TYPE,
  groupSecurityIds,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MESSAGE,
  messageToTick,
  PAISE_PER_RUPEE,
  parseAngelOneMessage,
  securityIdFor,
  SUBSCRIPTION_MODE,
  StreamSocket,
} from "../src/services/realtime/angelOneStreamProvider";
import { describeConfig, readAngelOneCredentials, loginAngelOne, base32Decode, generateTotp } from "../src/services/realtime/angelOneAuth";
import { AngelOneSession } from "../src/services/realtime/angelOneAuth";
import { TickValidator } from "../src/services/realtime/tickValidator";
import { modeAuthorityCeiling, capActionByMode } from "../src/services/realtime/marketDataProvider";

// ── frame builders ───────────────────────────────────────────────────────────

const EXCH_TS = Date.UTC(2026, 8, 18, 4, 30, 0);

function ltpFrame(over: Partial<{ mode: number; exchange: number; token: string; seq: number; ts: number; ltpPaise: number }> = {}): Buffer {
  const o = { mode: SUBSCRIPTION_MODE.LTP, exchange: EXCHANGE_TYPE.NSE_CM, token: "2885", seq: 12345, ts: EXCH_TS, ltpPaise: 124_360, ...over };
  const buf = Buffer.alloc(51);
  buf.writeUInt8(o.mode, 0);
  buf.writeUInt8(o.exchange, 1);
  buf.write(o.token, 2, "ascii"); // remainder stays null ⇒ null-terminated
  buf.writeBigInt64LE(BigInt(o.seq), 27);
  buf.writeBigInt64LE(BigInt(o.ts), 35);
  buf.writeBigInt64LE(BigInt(o.ltpPaise), 43);
  return buf;
}

function quoteFrame(): Buffer {
  const buf = Buffer.alloc(123);
  ltpFrame({ mode: SUBSCRIPTION_MODE.QUOTE }).copy(buf, 0);
  buf.writeBigInt64LE(BigInt(150), 51); // last traded quantity
  buf.writeBigInt64LE(BigInt(4_820_331), 67); // volume traded today
  buf.writeBigInt64LE(BigInt(124_000), 91); // open  = 1240.00
  buf.writeBigInt64LE(BigInt(125_500), 99); // high  = 1255.00
  buf.writeBigInt64LE(BigInt(123_100), 107); // low  = 1231.00
  buf.writeBigInt64LE(BigInt(123_900), 115); // close = 1239.00
  return buf;
}

function snapQuoteFrame(bestBidPaise = 124_355, bestAskPaise = 124_365): Buffer {
  const buf = Buffer.alloc(379);
  quoteFrame().copy(buf, 0);
  buf.writeUInt8(SUBSCRIPTION_MODE.SNAP_QUOTE, 0);
  // best-5: twenty 20-byte packets from 147; buy[0] at 147, sell[0] at 147+200.
  buf.writeBigInt64LE(BigInt(bestBidPaise), 147 + 4);
  buf.writeBigInt64LE(BigInt(bestAskPaise), 147 + 200 + 4);
  return buf;
}

// ── binary protocol ──────────────────────────────────────────────────────────

describe("SmartStream v2 binary decoding", () => {
  test("LTP frame: header fields at the documented offsets, price converted from paise", () => {
    const m = parseAngelOneMessage(ltpFrame())!;
    expect(m.subscriptionMode).toBe(SUBSCRIPTION_MODE.LTP);
    expect(m.exchangeType).toBe(EXCHANGE_TYPE.NSE_CM);
    expect(m.token).toBe("2885");
    expect(m.securityId).toBe("1:2885");
    expect(m.sequenceNumber).toBe(12345);
    expect(m.exchangeTimestamp).toBe(EXCH_TS);
    expect(m.lastTradedPrice).toBe(1243.6); // 124360 paise — NOT 124360
    expect(PAISE_PER_RUPEE).toBe(100);
    // Quote-only fields stay null in LTP mode rather than defaulting to 0.
    expect(m.openPrice).toBeNull();
    expect(m.volumeTradedToday).toBeNull();
    expect(m.bestBid).toBeNull();
  });

  test("QUOTE frame adds LTQ/volume/OHLC, all prices in rupees", () => {
    const m = parseAngelOneMessage(quoteFrame())!;
    expect(m.lastTradedQuantity).toBe(150);
    expect(m.volumeTradedToday).toBe(4_820_331);
    expect(m.openPrice).toBe(1240);
    expect(m.highPrice).toBe(1255);
    expect(m.lowPrice).toBe(1231);
    expect(m.closePrice).toBe(1239);
    expect(m.bestBid).toBeNull(); // depth only arrives in SNAP_QUOTE
  });

  test("SNAP_QUOTE frame yields best bid/ask from the best-5 block", () => {
    const m = parseAngelOneMessage(snapQuoteFrame())!;
    expect(m.bestBid).toBe(1243.55);
    expect(m.bestAsk).toBe(1243.65);
    expect(m.bestAsk!).toBeGreaterThan(m.bestBid!);
  });

  test("zero depth prices are reported as null, never as a real ₹0 quote", () => {
    const m = parseAngelOneMessage(snapQuoteFrame(0, 0))!;
    expect(m.bestBid).toBeNull();
    expect(m.bestAsk).toBeNull();
  });

  test("a truncated frame is discarded rather than zero-padded", () => {
    expect(parseAngelOneMessage(Buffer.alloc(20))).toBeNull();
    expect(parseAngelOneMessage(Buffer.alloc(0))).toBeNull();
  });

  test("an empty token is rejected (a tick with no instrument is meaningless)", () => {
    const buf = ltpFrame();
    buf.fill(0, 2, 27);
    expect(parseAngelOneMessage(buf)).toBeNull();
  });

  test("messageToTick maps onto the engine's normalized shape and passes the TickValidator", () => {
    const m = parseAngelOneMessage(snapQuoteFrame())!;
    const tick = messageToTick(m, EXCH_TS + 40);
    expect(tick).toMatchObject({ securityId: "1:2885", price: 1243.6, quantity: 150, sequence: 12345, exchangeTimestamp: EXCH_TS });
    expect(tick.receivedAt).toBe(EXCH_TS + 40);
    expect(new TickValidator().validate(tick).status).toBe("VALID");
  });

  test("securityIdFor is stable and reversible by groupSecurityIds", () => {
    const id = securityIdFor(EXCHANGE_TYPE.NSE_CM, "2885");
    const grouped = groupSecurityIds([id, securityIdFor(EXCHANGE_TYPE.NSE_CM, "1594"), securityIdFor(EXCHANGE_TYPE.BSE_CM, "500325")]);
    expect(grouped.get(EXCHANGE_TYPE.NSE_CM)).toEqual(["2885", "1594"]);
    expect(grouped.get(EXCHANGE_TYPE.BSE_CM)).toEqual(["500325"]);
  });

  test("groupSecurityIds ignores malformed ids and de-duplicates", () => {
    const g = groupSecurityIds(["1:2885", "1:2885", "nonsense", ":", "1:", "x:9"]);
    expect(g.get(1)).toEqual(["2885"]);
    expect(g.size).toBe(1);
  });
});

describe("subscription frames", () => {
  test("match the documented request shape", () => {
    const frame = JSON.parse(buildSubscriptionRequest(ACTION.SUBSCRIBE, SUBSCRIPTION_MODE.SNAP_QUOTE, groupSecurityIds(["1:2885", "1:1594"]), "corr-1"));
    expect(frame).toEqual({
      correlationID: "corr-1",
      action: 1,
      params: { mode: 3, tokenList: [{ exchangeType: 1, tokens: ["2885", "1594"] }] },
    });
    expect(JSON.parse(buildSubscriptionRequest(ACTION.UNSUBSCRIBE, SUBSCRIPTION_MODE.LTP, groupSecurityIds(["1:2885"]), "c")).action).toBe(0);
  });
});

// ── provider behaviour (fake socket) ─────────────────────────────────────────

class FakeSocket implements StreamSocket {
  sent: string[] = [];
  closed = false;
  private handlers = new Map<string, (arg?: unknown) => void>();
  constructor(readonly url: string, readonly headers: Record<string, string>) {}
  send(d: string): void {
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

function makeProvider(overrides: Record<string, unknown> = {}) {
  const session: AngelOneSession = {
    jwtToken: "JWT", refreshToken: "RT", feedToken: "FEED", apiKey: "KEY", clientCode: "A123456", issuedAt: 0,
  };
  let socket!: FakeSocket;
  const timers: Array<{ cb: () => void; ms: number }> = [];
  let clock = EXCH_TS;
  const provider = new AngelOneStreamProvider(session, {
    socketFactory: (url, headers) => (socket = new FakeSocket(url, headers)),
    now: () => clock,
    setInterval: (cb, ms) => { timers.push({ cb, ms }); return timers.length - 1; },
    clearInterval: () => undefined,
    ...overrides,
  });
  return { provider, getSocket: () => socket, timers, setClock: (t: number) => { clock = t; } };
}

describe("AngelOneStreamProvider", () => {
  test("connects to the documented URL with the four auth headers", async () => {
    const { provider, getSocket } = makeProvider();
    const p = provider.connect();
    getSocket().emit("open");
    await p;
    expect(getSocket().url).toBe(ANGELONE_STREAM_URL);
    expect(getSocket().headers).toEqual({ Authorization: "JWT", "x-api-key": "KEY", "x-client-code": "A123456", "x-feed-token": "FEED" });
  });

  test("sends the literal 'ping' heartbeat every 10s", async () => {
    const { provider, getSocket, timers } = makeProvider();
    const p = provider.connect();
    getSocket().emit("open");
    await p;
    expect(timers[0].ms).toBe(HEARTBEAT_INTERVAL_MS);
    timers[0].cb();
    expect(getSocket().sent).toContain(HEARTBEAT_MESSAGE);
  });

  test("binary frames become ticks; the text pong is ignored", async () => {
    const { provider, getSocket } = makeProvider();
    const ticks: unknown[] = [];
    provider.onTick((t) => ticks.push(t));
    const p = provider.connect();
    getSocket().emit("open");
    await p;
    getSocket().emit("message", "pong");
    expect(ticks).toHaveLength(0);
    getSocket().emit("message", snapQuoteFrame());
    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toMatchObject({ securityId: "1:2885", price: 1243.6 });
  });

  test("subscribing before connect is deferred, then replayed on open (reconnect self-heals)", async () => {
    const { provider, getSocket } = makeProvider();
    await provider.subscribe(["1:2885"]);
    const p = provider.connect();
    getSocket().emit("open");
    await p;
    const frame = JSON.parse(getSocket().sent[0]);
    expect(frame.action).toBe(ACTION.SUBSCRIBE);
    expect(frame.params.tokenList).toEqual([{ exchangeType: 1, tokens: ["2885"] }]);
    expect(provider.health().subscribed).toBe(1);
  });

  test("health: DISCONNECTED → CONNECTED on ticks → STALE when ticks dry up", async () => {
    const { provider, getSocket, setClock } = makeProvider({ staleAfterMs: 60_000 });
    expect(provider.health().state).toBe("DISCONNECTED");
    const p = provider.connect();
    getSocket().emit("open");
    await p;
    getSocket().emit("message", ltpFrame());
    expect(provider.health().state).toBe("CONNECTED");
    setClock(EXCH_TS + 61_000);
    expect(provider.health().state).toBe("STALE");
  });

  test("a socket error surfaces to onError and into health().reason", async () => {
    const { provider, getSocket } = makeProvider();
    const errors: unknown[] = [];
    provider.onError((e) => errors.push(e));
    const p = provider.connect();
    getSocket().emit("open");
    await p;
    getSocket().emit("error", new Error("connection reset"));
    expect(errors).toHaveLength(1);
    expect(provider.health().reason).toMatch(/connection reset/);
  });

  test("disconnect closes the socket and stops reporting CONNECTED", async () => {
    const { provider, getSocket } = makeProvider();
    const p = provider.connect();
    getSocket().emit("open");
    await p;
    await provider.disconnect();
    expect(getSocket().closed).toBe(true);
    expect(provider.health().state).toBe("DISCONNECTED");
  });
});

// ── auth + honesty ───────────────────────────────────────────────────────────

describe("TOTP (RFC 6238) — hand-rolled, so verified against the published vectors", () => {
  // RFC 6238 Appendix B uses the ASCII seed "12345678901234567890". In BASE32
  // that is GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ. HMAC-SHA1, 30s step, 8 digits.
  const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  test("base32Decode recovers the RFC's ASCII seed", () => {
    expect(base32Decode(RFC_SECRET).toString("ascii")).toBe("12345678901234567890");
  });

  test("matches RFC 6238 SHA-1 test vectors", () => {
    // t=59s → 94287082; t=1111111109 → 07081804; t=1111111111 → 14050471
    expect(generateTotp(RFC_SECRET, 59 * 1000, 30, 8)).toBe("94287082");
    expect(generateTotp(RFC_SECRET, 1111111109 * 1000, 30, 8)).toBe("07081804");
    expect(generateTotp(RFC_SECRET, 1111111111 * 1000, 30, 8)).toBe("14050471");
    expect(generateTotp(RFC_SECRET, 1234567890 * 1000, 30, 8)).toBe("89005924");
  });

  test("6-digit codes are the truncation of the same value, and are stable within a 30s step", () => {
    expect(generateTotp(RFC_SECRET, 59 * 1000)).toBe("287082");
    expect(generateTotp(RFC_SECRET, 30_000)).toBe(generateTotp(RFC_SECRET, 59_999));
    expect(generateTotp(RFC_SECRET, 30_000)).not.toBe(generateTotp(RFC_SECRET, 60_000));
  });

  test("lower case and padding are tolerated; a non-BASE32 character throws rather than silently mis-decoding", () => {
    expect(base32Decode("gezdgnbv===")).toEqual(base32Decode("GEZDGNBV"));
    expect(() => base32Decode("NOT-BASE32!")).toThrow(/BASE32/);
    expect(() => base32Decode("")).toThrow(/empty/);
  });
});

describe("Angel One credentials", () => {
  const full = { ANGELONE_API_KEY: "k", ANGELONE_CLIENT_CODE: "A1", ANGELONE_PIN: "1234", ANGELONE_TOTP_SECRET: "BASE32SEED" } as NodeJS.ProcessEnv;

  test("fully configured ⇒ credentials; partially configured ⇒ null, never a half-session", () => {
    expect(readAngelOneCredentials(full)).toEqual({ apiKey: "k", clientCode: "A1", pin: "1234", totpSecret: "BASE32SEED" });
    expect(readAngelOneCredentials({ ...full, ANGELONE_PIN: "" })).toBeNull();
    expect(readAngelOneCredentials({})).toBeNull();
  });

  test("describeConfig names what is missing without revealing any value", () => {
    expect(describeConfig(full)).toEqual({ configured: true, missing: [] });
    const partial = describeConfig({ ANGELONE_API_KEY: "k" } as NodeJS.ProcessEnv);
    expect(partial.configured).toBe(false);
    expect(partial.missing).toEqual(["ANGELONE_CLIENT_CODE", "ANGELONE_PIN", "ANGELONE_TOTP_SECRET"]);
    expect(JSON.stringify(partial)).not.toContain("k");
  });

  test("login sends clientcode/password/totp with X-PrivateKey, and returns the feed token", async () => {
    let seen: { url: string; body: Record<string, string>; headers: Record<string, string> } | null = null;
    const session = await loginAngelOne(
      readAngelOneCredentials(full)!,
      async (url, body, headers) => {
        seen = { url, body: body as Record<string, string>, headers };
        return { status: true, data: { jwtToken: "J", refreshToken: "R", feedToken: "F" } };
      },
      () => 1000
    );
    expect(seen!.url).toMatch(/loginByPassword$/);
    expect(seen!.body.clientcode).toBe("A1");
    expect(seen!.body.password).toBe("1234");
    expect(seen!.body.totp).toMatch(/^\d{6}$/); // derived from the seed, not the seed itself
    expect(seen!.body.totp).not.toBe("BASE32SEED");
    expect(seen!.headers["X-PrivateKey"]).toBe("k");
    expect(session).toMatchObject({ jwtToken: "J", feedToken: "F", apiKey: "k", clientCode: "A1", issuedAt: 1000 });
  });

  test("a broker rejection throws loudly rather than degrading to a fake session", async () => {
    await expect(
      loginAngelOne(readAngelOneCredentials(full)!, async () => ({ status: false, message: "Invalid totp" }))
    ).rejects.toThrow(/Invalid totp/);
    await expect(
      loginAngelOne(readAngelOneCredentials(full)!, async () => ({ status: true, data: { jwtToken: "J" } }))
    ).rejects.toThrow(/no jwtToken\/feedToken/);
  });
});

describe("STREAMING is the mode a real-time feed earns", () => {
  test("STREAMING lifts the ceiling to BUY_CANDIDATE, unlike the delayed/scraped modes", () => {
    expect(modeAuthorityCeiling("STREAMING")).toBe("BUY_CANDIDATE");
    expect(capActionByMode("BUY_CANDIDATE", "STREAMING")).toBe("BUY_CANDIDATE");
    expect(capActionByMode("BUY_CANDIDATE", "DELAYED_CANDLES")).toBe("WAIT");
    expect(capActionByMode("BUY_CANDIDATE", "SCRAPED_SNAPSHOT")).toBe("WAIT");
  });
});
