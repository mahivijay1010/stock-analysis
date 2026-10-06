/** Wide-scan decision mapping and reference levels, pinned: the label never upgrades the pipeline's action. */
import { decisionFor, referenceLevels } from "../src/services/shortterm/wideScan";

const bars = Array.from({ length: 260 }, (_, i) => ({ date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`, open: 100, high: 102 + (i === 200 ? 20 : 0), low: 98 - (i === 10 ? 30 : 0), close: 100, volume: 1000 }));
const view = (action: string, extra: Record<string, unknown> = {}) => ({ action, setupType: "PULLBACK_IN_UPTREND", tier: "C", plan: { initialStop: 95 }, ...extra }) as never;

describe("wide scan", () => {
  it("computes support/resistance, 52w range and a 2×ATR volatility stop", () => {
    const r = referenceLevels(bars)!;
    expect(r.support20).toBe(98);
    expect(r.resistance20).toBe(102);
    expect(r.high52w).toBe(122);
    expect(r.atr14).toBeCloseTo(4);
    expect(r.volatilityStop).toBeCloseTo(92);
  });

  it("maps only ENTRY_CONFIRMED to BUY", () => {
    expect(decisionFor(view("ENTRY_CONFIRMED"), null).newBuyer).toBe("BUY");
    expect(decisionFor(view("ZONE_REACHED"), null).newBuyer).toBe("WAIT");
    expect(decisionFor(view("WAIT_FOR_CONFIRMATION"), null).newBuyer).toBe("WAIT");
    expect(decisionFor(view("RESEARCH_WATCH"), null).newBuyer).toBe("WATCH");
    for (const a of ["NO_SETUP", "NO_TRADE", "INVALIDATED", "EXIT", "TRAIL"]) expect(decisionFor(view(a), null).newBuyer).toBe("NO TRADE");
  });

  it("gives holders an exit line: the plan stop, else the volatility stop", () => {
    expect(decisionFor(view("RESEARCH_WATCH"), null).why).toMatch(/exit below ₹95/);
    const r = referenceLevels(bars)!;
    expect(decisionFor(view("NO_SETUP", { plan: { initialStop: null } }), r).why).toMatch(new RegExp(`exit below ₹${r.volatilityStop}`));
    expect(decisionFor(view("INVALIDATED"), r).holder).toBe("EXIT");
  });
});
