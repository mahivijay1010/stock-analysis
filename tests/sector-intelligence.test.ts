/** Sector Intelligence (sector-intel-v1): regime states, component scoring, env mapping/combination, leakage guard. */
import { combineEnv, computeSectorRegime, SectorInputs, sectorStateToEnv, SECTOR_RULES } from "../src/services/global/sectorIntelligence";

const day = (i: number) => `2026-09-${String(i + 1).padStart(2, "0")}`;
const proxy = (n: number, dailyPct: number) => Array.from({ length: n }, (_, i) => ({ date: day(i), value: 100 * Math.pow(1 + dailyPct / 100, i) }));
const nifty = (n: number, dailyPct: number) => Array.from({ length: n }, (_, i) => ({ date: day(i), close: 25000 * Math.pow(1 + dailyPct / 100, i) }));
const breadth = (n: number, advShare = 0.6, turnover = 5e9) => Array.from({ length: n }, (_, i) => ({ date: day(i), advances: Math.round(100 * advShare), declines: Math.round(100 * (1 - advShare)), counted: 100, turnoverInr: turnover }));

const base = (over: Partial<SectorInputs> = {}): SectorInputs => ({
  sector: "SEC_IT",
  name: "Information technology (proxy)",
  proxy: proxy(28, 0.25),
  nifty: nifty(28, 0.1),
  breadth: breadth(28),
  globalImpact: { label: "NEUTRAL", reason: "no active shock" },
  ...over,
});

describe("computeSectorRegime", () => {
  test("rising sector beating NIFTY with broad breadth → STRONG, every covered component explained", () => {
    const r = computeSectorRegime(base())!;
    expect(r.state).toBe("STRONG");
    expect(r.components.map((c) => c.name)).toEqual(["Trend", "RelStrength", "Momentum", "Breadth", "Turnover", "Volatility", "GlobalTransmission"]);
    expect(r.components.find((c) => c.name === "RelStrength")!.score).toBe(2);
    for (const c of r.components.filter((x) => x.covered)) expect(c.reasons[0].length).toBeGreaterThan(0);
  });
  test("falling sector, lagging NIFTY, weak breadth → WEAK or STRESSED; add a global STRESS impact → STRESSED", () => {
    const weakInputs = base({ proxy: proxy(28, -0.3), breadth: breadth(28, 0.35) });
    const weak = computeSectorRegime(weakInputs)!;
    expect(["WEAK", "STRESSED"]).toContain(weak.state);
    const stressed = computeSectorRegime({ ...weakInputs, globalImpact: { label: "STRESS", reason: "oil shock, measured beta" } })!;
    expect(stressed.score).toBeLessThan(weak.score);
  });
  test("leakage guard: NIFTY or breadth points after the proxy's last session throw", () => {
    expect(() => computeSectorRegime(base({ proxy: proxy(25, 0.25) }))).toThrow(/leakage/);
  });
  test("short proxy history → null; missing breadth/global → uncovered, state still computes", () => {
    expect(computeSectorRegime(base({ proxy: proxy(10, 0.2), nifty: nifty(10, 0.1), breadth: breadth(10) }))).toBeNull();
    const r = computeSectorRegime(base({ breadth: [], globalImpact: null }))!;
    expect(r.components.find((c) => c.name === "Breadth")!.covered).toBe(false);
    expect(r.components.find((c) => c.name === "GlobalTransmission")!.covered).toBe(false);
    expect(r.state).toBeDefined();
  });
  test("turnover with breadth: high turnover on weak breadth scores −1", () => {
    const b = breadth(28, 0.35);
    b[27] = { ...b[27], turnoverInr: 1e10 };
    const r = computeSectorRegime(base({ breadth: b }))!;
    expect(r.components.find((c) => c.name === "Turnover")!.score).toBe(-1);
  });
  test("extreme realized volatility scores −2 and can force STRESSED via the hostile count", () => {
    // Alternate ±8% days: huge vol, flat return.
    const wild = Array.from({ length: 28 }, (_, i) => ({ date: day(i), value: 100 * (i % 2 ? 1.08 : 1) }));
    const r = computeSectorRegime(base({ proxy: wild, breadth: breadth(28, 0.3) }))!;
    expect(r.components.find((c) => c.name === "Volatility")!.score).toBe(-2);
  });
  test("state → env mapping and cautious combination", () => {
    expect(sectorStateToEnv("STRONG")).toBe("TAILWIND");
    expect(sectorStateToEnv("STRESSED")).toBe("STRESS");
    expect(combineEnv("TAILWIND", "HEADWIND")).toBe("HEADWIND");
    expect(combineEnv("NEUTRAL", "TAILWIND")).toBe("NEUTRAL");
    expect(combineEnv("HEADWIND", "STRESS")).toBe("STRESS");
  });
  test("rules object is exposed for audit", () => {
    expect(SECTOR_RULES.state.strongScore).toBe(4);
  });
});
