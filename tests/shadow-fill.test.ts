/**
 * P0 #2/#3/#8 — the fill-aware shadow ledger. Proves entry occurred, handles
 * gaps and never-entered, and reports realized NET R (not a percentage).
 */

import { simulateBracket, toAdjustedOhlc, OhlcBar } from "../src/services/shortterm/shadowFill";
import { parseParams } from "../src/controllers/ShortTermController";
import { HttpError } from "../src/types";

const bar = (date: string, o: number, h: number, l: number, c: number): OhlcBar => ({ date, open: o, high: h, low: l, close: c });

describe("simulateBracket — fill discipline (P0 #2)", () => {
  const common = { entryType: "zone" as const, zoneLow: 98, zoneHigh: 100, triggerPrice: null, stop: 95, target: 110, entryWindow: 3, maxHold: 10, roundTripCostPct: 0.3, slippagePct: 0.2 };

  test("NEVER_ENTERED when price never trades down into the zone", () => {
    // Price runs straight up from 102 — the buy-limit at 100 is never touched.
    const forward = [bar("d1", 102, 105, 101, 104), bar("d2", 104, 108, 103, 107), bar("d3", 107, 112, 106, 111)];
    const r = simulateBracket({ ...common, forward });
    expect(r.outcome).toBe("NEVER_ENTERED");
    expect(r.filled).toBe(false);
    expect(r.netRMultiple).toBeNull();
  });

  test("fills at the limit, then TARGET_FIRST — netR is positive and < gross R (costs deducted)", () => {
    const forward = [
      bar("d1", 101, 101.5, 99, 100.5), // dips to 99 ⇒ fills at 100 (limit)
      bar("d2", 100.5, 104, 100, 103),
      bar("d3", 103, 111, 102, 110), // hits target 110
    ];
    const r = simulateBracket({ ...common, forward });
    expect(r.filled).toBe(true);
    expect(r.fillPrice).toBe(100);
    expect(r.outcome).toBe("TARGET_FIRST");
    // gross R = (110−100)/(100−95) = 2.0; net after costs slightly less.
    expect(r.netRMultiple!).toBeGreaterThan(1.8);
    expect(r.netRMultiple!).toBeLessThan(2.0);
  });

  test("gap-down through the limit fills at the OPEN, not the limit (#2)", () => {
    const forward = [bar("d1", 97, 99, 96, 98), bar("d2", 98, 112, 97, 111)];
    const r = simulateBracket({ ...common, forward });
    expect(r.filled).toBe(true);
    expect(r.fillPrice).toBe(97); // opened below the 100 limit ⇒ filled at 97
  });

  test("a later bar that gaps below the stop exits at the open (#2)", () => {
    const forward = [
      bar("d1", 100, 100, 98, 99.5), // fill at 100
      bar("d2", 90, 92, 89, 91), // gaps below stop 95 ⇒ exit at open 90
    ];
    const r = simulateBracket({ ...common, forward });
    expect(r.outcome).toBe("STOP_FIRST");
    expect(r.exitPrice).toBe(90);
    expect(r.netRMultiple!).toBeLessThan(-1); // worse than a clean −1R because of the gap + costs
  });

  test("same-bar straddle is flagged AMBIGUOUS_INTRABAR: adverse ASSUMED for the gate, never RECORDED as realized", () => {
    // EOD OHLC can't order an intrabar stop+target touch. We DON'T pretend it
    // was a stop (that fabricates a −1R we never witnessed): realizedNetR stays
    // null while the SAFETY gate still gets the adverse (stop) leg.
    const forward = [
      bar("d1", 100, 100, 99, 99.8), // fill at 100
      bar("d2", 100, 111, 94, 100), // touches BOTH target 110 and stop 95
    ];
    const r = simulateBracket({ ...common, forward });
    expect(r.outcome).toBe("AMBIGUOUS_INTRABAR");
    expect(r.ambiguous).toBe(true);
    expect(r.realizedNetR).toBeNull(); // NOT an observed outcome
    expect(r.netRMultiple).toBeNull(); // back-compat alias tracks realized
    expect(r.conservativeNetR!).toBeLessThan(0); // adverse leg for the gate
    expect(r.exitPrice).toBe(95); // adverse leg, display only
  });

  test("breakout trigger: intrabar cross fills at the trigger; gap-up opens above ⇒ fills at open", () => {
    // open 103 < trigger 105, high 108 ≥ 105 ⇒ filled at the trigger 105.
    const cross = simulateBracket({ ...common, entryType: "trigger", zoneLow: null, zoneHigh: null, triggerPrice: 105, forward: [bar("d1", 103, 108, 102, 107)] });
    expect(cross.fillPrice).toBe(105);
    // open 106 ≥ trigger 105 ⇒ gap-up fills at the open 106 (worse than the trigger).
    const gap = simulateBracket({ ...common, entryType: "trigger", zoneLow: null, zoneHigh: null, triggerPrice: 105, forward: [bar("d1", 106, 109, 105, 108)] });
    expect(gap.fillPrice).toBe(106);
  });
});

describe("toAdjustedOhlc (#8)", () => {
  test("applies the adjClose/close factor so OHLC shares the level basis", () => {
    const adj = toAdjustedOhlc([{ date: "d1", open: 200, high: 210, low: 195, close: 200, adjustedClose: 100 }]);
    expect(adj[0].close).toBe(100); // factor 0.5
    expect(adj[0].high).toBe(105);
    expect(adj[0].low).toBe(97.5);
  });
  test("factor 1 when adjustedClose absent", () => {
    const adj = toAdjustedOhlc([{ date: "d1", open: 200, high: 210, low: 195, close: 200 }]);
    expect(adj[0].high).toBe(210);
  });
});

describe("scan param validation (P0 #47)", () => {
  test("rejects negative budget, extreme risk %, and min>max", () => {
    expect(() => parseParams({ budgetInr: -5 })).toThrow(HttpError);
    expect(() => parseParams({ riskPerTradePct: 50 })).toThrow(/between 0.01 and 3/);
    expect(() => parseParams({ priceMin: 500, priceMax: 100 })).toThrow(/cannot exceed/);
    expect(() => parseParams({ horizon: "99d" })).toThrow(/horizon must be/);
  });
  test("accepts valid params", () => {
    const p = parseParams({ budgetInr: 50000, riskPerTradePct: 0.5, priceMin: 100, priceMax: 500, horizon: "5-10d" });
    expect(p.budgetInr).toBe(50000);
    expect(p.riskPerTradePct).toBe(0.5);
  });
});
