/**
 * Realtime feed-agnostic core — the invariants the reviewer required BEFORE any
 * broker is connected (#19): tick validation, 1m OHLC + multi-timeframe
 * aggregation, forming≠completed, incremental==full features, StateDelta
 * determinism, materiality, ranking determinism + gate supremacy, replay/live
 * parity, and no-lookahead.
 */

import { TickValidator } from "../src/services/realtime/tickValidator";
import { OneMinuteBarBuilder, aggregateBars, minuteStart } from "../src/services/realtime/barBuilder";
import { computeFeatures, IncrementalFeatureEngine } from "../src/services/realtime/featureEngine";
import { buildLiveStockContext, assessLive, computePosture, BuildContextInput } from "../src/services/realtime/liveStockContext";
import { computeStateDelta } from "../src/services/realtime/stateDelta";
import { detectMateriality } from "../src/services/realtime/materiality";
import { rankOpportunities } from "../src/services/realtime/opportunityRanker";
import { ReplayMarketDataSource, ReplayMarketProvider } from "../src/services/realtime/replayProvider";
import { MarketTick, CompletedBar, LiveStockContext } from "../src/services/realtime/types";
import { DecisionStatus } from "../src/services/decision/policy";

const BASE = 28333350 * 60_000; // aligned to a 30-min boundary (⇒ clean 5/10/15m buckets)
const tick = (ts: number, price: number, qty: number, extra: Partial<MarketTick> = {}): MarketTick => ({ securityId: "R", exchangeTimestamp: ts, receivedAt: ts, price, quantity: qty, ...extra });
const bar = (startAt: number, o: number, h: number, l: number, c: number, v: number, tc = 1): CompletedBar => ({ complete: true, securityId: "R", startAt, endAt: startAt + 60_000, open: o, high: h, low: l, close: c, volume: v, tradeCount: tc });

describe("TickValidator", () => {
  test("valid tick passes; exact duplicate and sequence regression rejected", () => {
    const v = new TickValidator();
    expect(v.validate(tick(BASE, 100, 5, { sequence: 1 })).status).toBe("VALID");
    expect(v.validate(tick(BASE, 100, 5, { sequence: 1 })).status).toBe("DUPLICATE");
    expect(v.validate(tick(BASE + 10, 100, 5, { sequence: 1 })).status).toBe("DUPLICATE"); // seq regression
  });
  test("a sequence gap is surfaced, not silently absorbed", () => {
    const v = new TickValidator();
    v.validate(tick(BASE, 100, 5, { sequence: 1 }));
    const r = v.validate(tick(BASE + 1000, 101, 5, { sequence: 5 }));
    expect(r.status).toBe("SEQUENCE_GAP");
    if (r.status === "SEQUENCE_GAP") { expect(r.expected).toBe(2); expect(r.got).toBe(5); }
  });
  test("value sanity: NaN, non-positive price, negative qty, crossed book, future ts", () => {
    const v = new TickValidator();
    expect(v.validate(tick(BASE, NaN, 5)).status).toBe("INVALID");
    expect(v.validate(tick(BASE, 0, 5)).status).toBe("INVALID");
    expect(v.validate(tick(BASE, 100, -1)).status).toBe("INVALID");
    expect(v.validate(tick(BASE, 100, 5, { bid: 101, ask: 100 })).status).toBe("INVALID");
    expect(v.validate({ securityId: "R", exchangeTimestamp: BASE + 999999, receivedAt: BASE, price: 100, quantity: 5 }).status).toBe("INVALID");
  });
  test("a stale feed (received long after exchange time) is flagged STALE", () => {
    const v = new TickValidator();
    expect(v.validate({ securityId: "R", exchangeTimestamp: BASE, receivedAt: BASE + 120000, price: 100, quantity: 5 }).status).toBe("STALE");
  });
});

describe("BarBuilder — 1m correctness and forming≠completed", () => {
  test("1m OHLCV is correct and the forming bar is never marked complete", () => {
    const b = new OneMinuteBarBuilder("R");
    expect(b.addTick(tick(BASE + 1000, 100, 10))).toBeNull();
    b.addTick(tick(BASE + 2000, 103, 5));
    b.addTick(tick(BASE + 3000, 98, 7));
    const forming = b.current()!;
    expect(forming.complete).toBe(false);
    expect([forming.open, forming.high, forming.low, forming.close]).toEqual([100, 103, 98, 98]);
    expect(forming.volume).toBe(22);
    // A tick in the next minute closes the prior bar.
    const closed = b.addTick(tick(BASE + 61000, 99, 4));
    expect(closed).not.toBeNull();
    expect(closed!.complete).toBe(true);
    expect([closed!.open, closed!.high, closed!.low, closed!.close, closed!.volume]).toEqual([100, 103, 98, 98, 22]);
  });
  test("a clock advance closes a quiet minute", () => {
    const b = new OneMinuteBarBuilder("R");
    b.addTick(tick(BASE + 1000, 100, 10));
    expect(b.advanceClock(BASE + 30000)).toBeNull(); // same minute
    const closed = b.advanceClock(BASE + 61000);
    expect(closed?.complete).toBe(true);
    expect(minuteStart(closed!.startAt)).toBe(BASE);
  });
});

describe("aggregateBars — multi-timeframe from ONE 1m series", () => {
  const bars1m = Array.from({ length: 15 }, (_, i) => bar(BASE + i * 60_000, 100 + i, 100 + i + 2, 100 + i - 2, 100 + i + 1, 1000 + i));
  test("5m aggregation: correct OHLC, volume, and completeness", () => {
    const agg = aggregateBars(bars1m, 5);
    expect(agg).toHaveLength(3);
    const first = agg[0];
    expect(first.complete).toBe(true);
    expect(first.open).toBe(bars1m[0].open);
    expect(first.close).toBe(bars1m[4].close);
    expect(first.high).toBe(Math.max(...bars1m.slice(0, 5).map((b) => b.high)));
    expect(first.low).toBe(Math.min(...bars1m.slice(0, 5).map((b) => b.low)));
    expect(first.volume).toBe(bars1m.slice(0, 5).reduce((s, b) => s + b.volume, 0));
  });
  test("a partial tail is returned FORMING, never completed", () => {
    const agg = aggregateBars(bars1m.slice(0, 12), 5); // 5 + 5 + 2
    expect(agg[0].complete).toBe(true);
    expect(agg[1].complete).toBe(true);
    expect(agg[2].complete).toBe(false); // only 2 of 5 minutes present
  });
  test("10m and 15m derive from the same series", () => {
    expect(aggregateBars(bars1m, 15)[0].complete).toBe(true);
    expect(aggregateBars(bars1m, 10)[0].complete).toBe(true);
    expect(aggregateBars(bars1m, 10)[1].complete).toBe(false); // 5 of 10
  });
});

describe("feature engine — incremental EQUALS full recompute", () => {
  const bars: CompletedBar[] = Array.from({ length: 45 }, (_, i) => {
    const c = 100 + 10 * Math.sin(i / 3) + i * 0.1;
    const prev = i === 0 ? c : 100 + 10 * Math.sin((i - 1) / 3) + (i - 1) * 0.1;
    return bar(BASE + i * 60_000, prev, Math.max(c, prev) + 1, Math.min(c, prev) - 1, c, 1000 + (i % 7) * 50);
  });
  test("the incremental snapshot matches the full recompute bar-for-bar", () => {
    const eng = new IncrementalFeatureEngine();
    for (let n = 1; n <= bars.length; n++) {
      eng.addBar(bars[n - 1]);
      expect(eng.snapshot()).toEqual(computeFeatures(bars.slice(0, n)));
    }
  });
  test("RSI/ATR are null before enough bars, then populated", () => {
    expect(computeFeatures(bars.slice(0, 10)).rsi14).toBeNull();
    expect(computeFeatures(bars.slice(0, 13)).atr14).toBeNull();
    expect(computeFeatures(bars).rsi14).not.toBeNull();
    expect(computeFeatures(bars).atr14).not.toBeNull();
  });
});

describe("live assessment hysteresis + StateDelta determinism", () => {
  test("a posture move inside the dead-band keeps the prior assessment", () => {
    expect(assessLive({ prevPosture: 0.2, currPosture: 0.25, prevAssessment: "IMPROVING", gate: "WAIT", dataQuality: "HEALTHY", minDelta: 0.1 })).toBe("IMPROVING");
  });
  test("a large posture move changes it; UNAVAILABLE data invalidates", () => {
    expect(assessLive({ prevPosture: 0.0, currPosture: 0.5, prevAssessment: "STABLE", gate: "WAIT", dataQuality: "HEALTHY", minDelta: 0.1 })).toBe("STRONGLY_IMPROVING");
    expect(assessLive({ prevPosture: 0.5, currPosture: 0.35, prevAssessment: "IMPROVING", gate: "WAIT", dataQuality: "HEALTHY", minDelta: 0.1 })).toBe("WEAKENING"); // −0.15: change, not ≥2×
    expect(assessLive({ prevPosture: 0.5, currPosture: 0.3, prevAssessment: "IMPROVING", gate: "WAIT", dataQuality: "HEALTHY", minDelta: 0.1 })).toBe("STRONGLY_WEAKENING"); // −0.2 ≥ 2×minDelta
    expect(assessLive({ prevPosture: 0.5, currPosture: 0.5, prevAssessment: "STABLE", gate: "WAIT", dataQuality: "UNAVAILABLE" })).toBe("INVALIDATED");
  });
  test("computeStateDelta is deterministic and detects vwap cross + setup change", () => {
    const mk = (over: Partial<BuildContextInput>): LiveStockContext => buildLiveStockContext({
      securityId: "R", ticker: "R.NS", asOf: BASE, price: { last: 100, open: 100, high: 101, low: 99 }, session: { volume: 1000 },
      features: computeFeatures([bar(BASE, 100, 101, 99, 100, 1000)]),
      setupState: "RANGE", expectedR: 0.2, expectedRLowerBound: 0.05, entryQuality: "MEDIUM", riskState: "NORMAL",
      relativeStrength: { vsMarketPct: 1, marketPercentile: 60 }, dataQuality: "HEALTHY", gate: "WAIT", ...over,
    });
    const prev = { ...mk({}), features: { ...mk({}).features, vwapDistancePct: -0.5 }, posture: -0.2, setupState: "RANGE" };
    const curr = { ...mk({}), features: { ...mk({}).features, vwapDistancePct: 0.5 }, posture: 0.3, setupState: "BREAKOUT_CONFIRMED" };
    const d1 = computeStateDelta(prev, curr);
    const d2 = computeStateDelta(prev, curr);
    expect(d1).toEqual(d2); // deterministic
    expect(d1.vwapCrossed).toBe(true);
    expect(d1.setupChanged).toBe(true);
    expect(d1.newBreakout).toBe(true);
  });
});

describe("MaterialityDetector", () => {
  const zero = computeStateDelta(null, { securityId: "R" } as LiveStockContext);
  test("a tiny drift is NOT material", () => {
    expect(detectMateriality({ ...zero, postureDelta: 0.01, priceMovePct: 0.003 }).material).toBe(false);
  });
  test("a breakout / gate change / posture shift IS material with reasons", () => {
    expect(detectMateriality({ ...zero, newBreakout: true }).reasons).toContain("BREAKOUT_CONFIRMED");
    expect(detectMateriality({ ...zero, gateChanged: true }).reasons).toContain("GATE_CHANGED");
    expect(detectMateriality({ ...zero, postureDelta: 0.3 }).reasons).toContain("POSTURE_SHIFT");
  });
});

describe("OpportunityRanker — determinism + gate supremacy", () => {
  const ctx = (id: string, gate: DecisionStatus, lcb: number, er: number, dataQuality: LiveStockContext["dataQuality"] = "HEALTHY"): LiveStockContext => ({
    securityId: id, ticker: `${id}.NS`, asOf: BASE, price: { last: 100, open: 100, high: 101, low: 99, changePct: 0 },
    volume: { session: 1000, relativeVolume: 1.2 }, features: computeFeatures([bar(BASE, 100, 101, 99, 100, 1000)]), posture: 0.2,
    liveAssessment: "STABLE", setupState: "RANGE", expectedR: er, expectedRLowerBound: lcb, entryQuality: "MEDIUM", riskState: "NORMAL",
    relativeStrength: { vsMarketPct: 1, marketPercentile: 50 }, dataQuality, gate,
  });
  test("ranks by expected-R lower bound; deterministic and stable", () => {
    const contexts = [ctx("A", "BUY_CANDIDATE", 0.05, 0.3), ctx("B", "BUY_CANDIDATE", 0.13, 0.2), ctx("C", "WAIT", 0.2, 0.5)];
    const r1 = rankOpportunities(contexts);
    const r2 = rankOpportunities(contexts.slice().reverse());
    expect(r1.opportunity.map((x) => x.securityId)).toEqual(r2.opportunity.map((x) => x.securityId));
    expect(r1.opportunity[0].securityId).toBe("C"); // highest LCB
  });
  test("a high score NEVER promotes a gated-out stock into actionable", () => {
    const contexts = [ctx("HOT", "AVOID_NEW_ENTRY", 0.9, 0.9), ctx("OK", "BUY_CANDIDATE", 0.05, 0.1)];
    const r = rankOpportunities(contexts);
    expect(r.actionable.map((x) => x.securityId)).toEqual(["OK"]); // AVOID excluded despite best numbers
    expect(r.excluded.find((e) => e.securityId === "HOT")?.reason).toMatch(/avoid/);
  });
  test("data-unavailable is excluded from both lists", () => {
    const r = rankOpportunities([ctx("X", "BUY_CANDIDATE", 0.1, 0.2, "UNAVAILABLE")]);
    expect(r.opportunity).toHaveLength(0);
    expect(r.actionable).toHaveLength(0);
  });
});

describe("replay: ordering, no-lookahead, and live parity", () => {
  const raw = [tick(BASE + 61000, 101, 4), tick(BASE + 1000, 100, 10), tick(BASE + 2000, 103, 5), tick(BASE + 125000, 99, 3)];
  test("ReplayMarketDataSource returns events strictly in time order", async () => {
    const src = new ReplayMarketDataSource(raw.map((t) => ({ kind: "TICK" as const, tick: t })));
    const times: number[] = [];
    for (let e = await src.next(); e; e = await src.next()) if (e.kind === "TICK") times.push(e.tick.exchangeTimestamp);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
  test("future events cannot alter an earlier completed bar (no lookahead)", async () => {
    // Completed bars from the full stream must match those from a truncated prefix.
    const build = async (ticks: MarketTick[]) => {
      const src = ReplayMarketDataSource.fromTicks(ticks);
      const b = new OneMinuteBarBuilder("R");
      const done: CompletedBar[] = [];
      for (let e = await src.next(); e; e = await src.next()) if (e.kind === "TICK") { const c = b.addTick(e.tick); if (c) done.push(c); }
      return done;
    };
    const full = await build(raw);
    const prefix = await build(raw.filter((t) => t.exchangeTimestamp <= BASE + 61000));
    expect(full.slice(0, prefix.length)).toEqual(prefix); // earlier bars identical regardless of later data
  });
  test("LIVE-style provider pump produces the SAME completed bars as the direct path", async () => {
    // Direct path over sorted ticks.
    const sorted = raw.slice().sort((a, b) => a.exchangeTimestamp - b.exchangeTimestamp);
    const direct = new OneMinuteBarBuilder("R");
    const directBars: CompletedBar[] = [];
    for (const t of sorted) { const c = direct.addTick(t); if (c) directBars.push(c); }
    // Provider path.
    const provider = new ReplayMarketProvider(new ReplayMarketDataSource(raw.map((t) => ({ kind: "TICK" as const, tick: t }))));
    const viaProvider = new OneMinuteBarBuilder("R");
    const providerBars: CompletedBar[] = [];
    provider.onTick((t) => { const c = viaProvider.addTick(t); if (c) providerBars.push(c); });
    await provider.connect();
    await provider.subscribe(["R"]);
    await provider.pump();
    expect(providerBars).toEqual(directBars); // byte-for-byte parity
  });
});
