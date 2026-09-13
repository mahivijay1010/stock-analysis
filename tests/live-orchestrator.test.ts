/**
 * 10-minute orchestrator + scraped price source — the coordination invariants:
 * append-only revisions, transition events, mode authority cap, no silent
 * partial universe, market-closed skip, and config-driven scrape parsing.
 */

import { LiveEvaluationOrchestrator, OrchestratorDeps, RevisionInput, EventInput } from "../src/services/realtime/liveOrchestrator";
import { MarketDataProvider, MarketSnapshot, Security } from "../src/services/realtime/marketDataProvider";
import { LiveStockContext } from "../src/services/realtime/types";
import { DecisionStatus } from "../src/services/decision/policy";
import { ScrapedPriceSource, parseScrapedNumber } from "../src/services/realtime/scrapedPriceSource";

const NOW = 1_700_000_000_000;
const snap = (ticker: string, over: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
  securityId: ticker, ticker, mode: "SCRAPED_SNAPSHOT", price: 100, previousClose: 99, open: 99, dayHigh: 101, dayLow: 98,
  volume: 1000, changePct: 1, bid: null, ask: null, fetchedAt: NOW, sourceTimestamp: NOW - 60000, ageSeconds: 60,
  freshness: "FRESH", quality: "OK", sources: ["A"], notes: [], ...over,
});
const lctx = (ticker: string, over: Partial<LiveStockContext> = {}): LiveStockContext => ({
  securityId: ticker, ticker, asOf: NOW, price: { last: 100, open: 99, high: 101, low: 98, changePct: 1 },
  volume: { session: 1000, relativeVolume: 1.2 },
  features: { ema9: null, ema21: null, ema50: null, rsi14: null, atr14: null, vwap: null, vwapDistancePct: 0.5, relativeVolume: 1.2, rangePct: 3, lastClose: 100, completedBars: 5 },
  posture: 0.2, liveAssessment: "STABLE", setupState: "RANGE", expectedR: 0.2, expectedRLowerBound: 0.05,
  entryQuality: "MEDIUM", riskState: "NORMAL", relativeStrength: { vsMarketPct: 1, marketPercentile: 60 },
  dataQuality: "HEALTHY", gate: "WAIT", ...over,
});

class FakeProvider implements MarketDataProvider {
  readonly mode = "SCRAPED_SNAPSHOT" as const;
  constructor(private snaps: MarketSnapshot[]) {}
  async fetchStock(s: Security) { return this.snaps.find((x) => x.ticker === s.ticker)!; }
  async fetchUniverse(secs: Security[]) { return secs.map((s) => this.snaps.find((x) => x.ticker === s.ticker)!).filter(Boolean) as MarketSnapshot[]; }
  health() { return { state: "CONNECTED" as const, lastTickAt: NOW, subscribed: this.snaps.length }; }
}

interface Store { revisions: RevisionInput[]; events: EventInput[]; lastId: Map<string, string> }
function makeDeps(universe: Security[], provider: MarketDataProvider, buildContext: OrchestratorDeps["buildContext"], over: Partial<OrchestratorDeps> = {}): { deps: OrchestratorDeps; store: Store } {
  const store: Store = { revisions: [], events: [], lastId: new Map() };
  let seq = 0;
  const deps: OrchestratorDeps = {
    provider, universe, now: () => NOW, isMarketOpen: () => true, buildContext,
    saveRevision: async (rev) => { const id = `rev-${++seq}`; store.revisions.push(rev); store.lastId.set(rev.ticker, id); return { id }; },
    saveEvent: async (ev) => { store.events.push(ev); },
    getPreviousRevisionId: async (ticker) => store.lastId.get(ticker) ?? null,
    ...over,
  };
  return { deps, store };
}

describe("LiveEvaluationOrchestrator", () => {
  const uni: Security[] = [{ securityId: "A", ticker: "A" }, { securityId: "B", ticker: "B" }];

  test("a closed market skips the cycle (no revisions written)", async () => {
    const { deps, store } = makeDeps(uni, new FakeProvider([snap("A"), snap("B")]), (s) => lctx(s.ticker), { isMarketOpen: () => false });
    const r = await new LiveEvaluationOrchestrator(deps).runCycle();
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe("market closed");
    expect(store.revisions).toHaveLength(0);
  });

  test("a full cycle writes one append-only revision per stock, ranked, coverage=1", async () => {
    const { deps, store } = makeDeps(uni, new FakeProvider([snap("A"), snap("B")]),
      (s) => lctx(s.ticker, { gate: "WAIT", expectedRLowerBound: s.ticker === "A" ? 0.2 : 0.05 }));
    const r = await new LiveEvaluationOrchestrator(deps).runCycle();
    expect(r.universeCoverage).toBe(1);
    expect(r.lowConfidence).toBe(false);
    expect(store.revisions).toHaveLength(2);
    expect(r.ranking!.opportunity[0].securityId).toBe("A"); // higher LCB ranks first
    expect(store.revisions.find((x) => x.ticker === "A")!.opportunityRank).toBe(1);
  });

  test("a partial universe is NEVER ranked as whole — coverage < 1 and lowConfidence", async () => {
    const { deps, store } = makeDeps(uni, new FakeProvider([snap("A"), snap("B", { quality: "SOURCE_DISAGREEMENT" })]),
      (s) => lctx(s.ticker));
    const r = await new LiveEvaluationOrchestrator(deps).runCycle();
    expect(r.covered).toBe(1);
    expect(r.universeCoverage).toBe(0.5);
    expect(r.lowConfidence).toBe(true);
    expect(r.failures.map((f) => f.ticker)).toContain("B");
    expect(store.revisions).toHaveLength(1); // only the covered stock
  });

  test("the data-mode ceiling caps the persisted gate (SCRAPED_SNAPSHOT BUY ⇒ WAIT)", async () => {
    const { deps, store } = makeDeps([{ securityId: "A", ticker: "A" }], new FakeProvider([snap("A")]),
      (s) => lctx(s.ticker, { gate: "BUY_CANDIDATE" as DecisionStatus }));
    await new LiveEvaluationOrchestrator(deps).runCycle();
    expect(store.revisions[0].gate).toBe("WAIT"); // capped by SCRAPED_SNAPSHOT
  });

  test("a transition writes an event and fires onMaterialChange; revisions chain", async () => {
    let cycle = 0;
    const fired: string[] = [];
    const provider = new FakeProvider([snap("A")]);
    // Cycle 1: STABLE. Cycle 2: IMPROVING with a big posture jump (material).
    const buildContext: OrchestratorDeps["buildContext"] = (s) =>
      lctx(s.ticker, {
        liveAssessment: cycle === 0 ? "STABLE" : "IMPROVING",
        posture: cycle === 0 ? 0.0 : 0.5,
        setupState: cycle === 0 ? "RANGE" : "BREAKOUT_CONFIRMED",
      });
    const { deps, store } = makeDeps([{ securityId: "A", ticker: "A" }], provider, buildContext, {
      onMaterialChange: async () => { fired.push("A"); },
    });
    const orch = new LiveEvaluationOrchestrator(deps);
    await orch.runCycle();      // cycle 1: no prior → no event
    cycle = 1;
    const r2 = await orch.runCycle(); // cycle 2: STABLE → IMPROVING
    expect(store.events).toHaveLength(1);
    expect(store.events[0].fromState).toBe("STABLE");
    expect(store.events[0].toState).toBe("IMPROVING");
    expect(fired).toContain("A");            // material change fired the AI hook
    expect(r2.revisionsWritten).toBe(1);
    expect(store.revisions[1].previousRevisionId).toBe("rev-1"); // chained
  });
});

describe("ScrapedPriceSource + parseScrapedNumber", () => {
  test("parseScrapedNumber strips ₹/comma/% and rejects non-numbers (no Number('')===0 trap)", () => {
    expect(parseScrapedNumber("₹1,435.20")).toBe(1435.2);
    expect(parseScrapedNumber("1.06%")).toBe(1.06);
    expect(parseScrapedNumber("1,829,300")).toBe(1829300);
    expect(parseScrapedNumber("N/A")).toBeNull();
    expect(parseScrapedNumber("")).toBeNull();
    expect(parseScrapedNumber(null)).toBeNull();
  });

  test("fetch parses fixture HTML into a normalized quote; a missing selector ⇒ null (⇒ PARSER_ERROR downstream)", async () => {
    const html = `<div class="ltp">₹1,435.20</div><div class="chg">1.06%</div><div class="o">1,421.00</div><div class="h">1,440.00</div><div class="l">1,418.00</div>`;
    const src = new ScrapedPriceSource(
      { name: "fixture", buildUrl: (s) => `https://x/${s.ticker}`, selectors: { price: ".ltp", changePct: ".chg", open: ".o", dayHigh: ".h", dayLow: ".l", volume: ".vol-missing" } },
      async () => html,
      () => NOW,
    );
    const q = await src.fetch({ securityId: "s1", ticker: "RELIANCE.NS" });
    expect(q.price).toBe(1435.2);
    expect(q.changePct).toBe(1.06);
    expect(q.dayHigh).toBe(1440);
    expect(q.volume).toBeNull(); // selector not found ⇒ null, not 0
    expect(q.sourceUrl).toBe("https://x/RELIANCE.NS");
    expect(q.sourceTimestamp).toBeNull(); // no timestamp selector ⇒ UNKNOWN_FRESHNESS downstream
  });
});
