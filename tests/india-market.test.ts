/**
 * India Market Diagnosis (india-market-v1): breadth/turnover from the exchange
 * feed, component scoring, state rules, missing-data honesty, FII/DII stated
 * as uncovered, and the point-in-time leakage guard.
 */
import { BreadthDay, computeIndiaDiagnosis, IndiaInputs, INDIA_RULES } from "../src/services/global/indiaMarket";

const day = (i: number) => `2026-09-${String(i + 1).padStart(2, "0")}`;
const breadth = (n: number, advShare = 0.6, turnover = 5e11): BreadthDay[] =>
  Array.from({ length: n }, (_, i) => ({ date: day(i), advances: Math.round(2000 * advShare), declines: Math.round(2000 * (1 - advShare)), counted: 2000, turnoverInr: turnover }));
const series = (n: number, start: number, dailyPct: number) =>
  Array.from({ length: n }, (_, i) => ({ date: day(i), close: start * Math.pow(1 + dailyPct / 100, i) }));

const base = (over: Partial<IndiaInputs> = {}): IndiaInputs => ({
  breadth: breadth(28),
  nifty: series(28, 25000, 0.2),
  bankNifty: series(28, 52000, 0.3),
  indiaVix: series(28, 12, 0),
  usdInr: series(28, 88, 0),
  sectorRelStrength20: [
    { sector: "SEC_IT", name: "IT", relPct: 1.2 },
    { sector: "SEC_FIN", name: "Financials", relPct: 0.8 },
    { sector: "SEC_AUTO", name: "Auto", relPct: 0.4 },
    { sector: "SEC_METAL", name: "Metals", relPct: -0.5 },
    { sector: "SEC_PHARMA", name: "Pharma", relPct: 0.2 },
  ],
  authoritativeRegime: { regime: "TREND_UP", reasons: ["price above its averages"] },
  ...over,
});

describe("computeIndiaDiagnosis", () => {
  test("healthy tape → STRONG, with every component carrying value, unit and reasons", () => {
    const d = computeIndiaDiagnosis(base())!;
    expect(d.state).toBe("STRONG");
    expect(d.components.map((c) => c.name)).toEqual(["Trend", "Financials", "Volatility", "Breadth", "Turnover", "INR", "SectorRelStrength", "FIIDIIFlows"]);
    for (const c of d.components.filter((x) => x.covered)) expect(c.reasons.length).toBeGreaterThan(0);
    expect(d.rules).toBe(INDIA_RULES);
    expect(d.sessionDate).toBe(day(27));
  });
  test("FII/DII is always reported as uncovered, never estimated", () => {
    const d = computeIndiaDiagnosis(base())!;
    const f = d.components.find((c) => c.name === "FIIDIIFlows")!;
    expect(f.covered).toBe(false);
    expect(f.score).toBeNull();
    expect(f.reasons[0]).toMatch(/no reliable keyless source/);
    expect(d.coverage.missing).toContain("FII_DII");
  });
  test("LEAKAGE GUARD: any input point after the diagnosed session throws", () => {
    const b = breadth(28);
    expect(() => computeIndiaDiagnosis(base({ breadth: b.slice(0, 20), nifty: series(28, 25000, 0.2) }))).toThrow(/leakage/);
  });
  test("weak breadth + high India VIX + rupee shock + downtrend → STRESSED", () => {
    const d = computeIndiaDiagnosis(
      base({
        breadth: breadth(28, 0.32),
        indiaVix: series(28, 29, 0),
        usdInr: series(28, 88, 0.4), // ≈ +2% over 5 sessions
        authoritativeRegime: { regime: "TREND_DOWN", reasons: ["below averages"] },
        bankNifty: series(28, 52000, -0.25),
        sectorRelStrength20: base().sectorRelStrength20!.map((s) => ({ ...s, relPct: -1 })),
      })
    )!;
    expect(d.state).toBe("STRESSED");
    expect(d.components.filter((c) => c.score === -2).length).toBeGreaterThanOrEqual(INDIA_RULES.state.stressedHostile);
  });
  test("mildly negative tape → WEAK or NEUTRAL, never STRESSED", () => {
    const d = computeIndiaDiagnosis(base({ breadth: breadth(28, 0.44), authoritativeRegime: { regime: "CHOPPY", reasons: [] }, bankNifty: series(28, 52000, -0.1), indiaVix: series(28, 19, 0) }))!;
    expect(["WEAK", "NEUTRAL"]).toContain(d.state);
  });
  test("India VIX 5-session spike lowers the volatility score one notch", () => {
    const calm = computeIndiaDiagnosis(base({ indiaVix: series(28, 15, 0) }))!;
    const spiking = computeIndiaDiagnosis(base({ indiaVix: [...series(23, 15, 0), ...Array.from({ length: 5 }, (_, i) => ({ date: day(23 + i), close: 15 * (1 + 0.08 * (i + 1)) }))] }))!;
    const v = (d: typeof calm) => d.components.find((c) => c.name === "Volatility")!.score;
    expect(v(spiking)).toBeLessThan(v(calm) as number);
  });
  test("turnover is read WITH breadth: high turnover scores +1 on positive breadth and −1 on negative breadth", () => {
    const highTurnover = breadth(28);
    highTurnover[27] = { ...highTurnover[27], turnoverInr: 8e11 };
    const up = computeIndiaDiagnosis(base({ breadth: highTurnover }))!;
    const downDays = breadth(28, 0.35);
    downDays[27] = { ...downDays[27], turnoverInr: 8e11 };
    const down = computeIndiaDiagnosis(base({ breadth: downDays }))!;
    expect(up.components.find((c) => c.name === "Turnover")!.score).toBe(1);
    expect(down.components.find((c) => c.name === "Turnover")!.score).toBe(-1);
    expect(down.components.find((c) => c.name === "Turnover")!.reasons[0]).toMatch(/distribution/);
  });
  test("missing series are uncovered and listed, and the state still computes from what exists", () => {
    const d = computeIndiaDiagnosis(base({ bankNifty: null, indiaVix: null, usdInr: null, sectorRelStrength20: null, authoritativeRegime: null }))!;
    expect(d.coverage.missing).toEqual(expect.arrayContaining(["BANKNIFTY", "INDIAVIX", "USDINR", "SECTOR_PROXIES", "FII_DII"]));
    expect(d.components.filter((c) => c.covered).map((c) => c.name)).toEqual(["Breadth", "Turnover"]);
    expect(d.state).toBeDefined();
    expect(d.reasons.join(" ")).toMatch(/not covered/);
  });
  test("empty breadth → null (no diagnosis invented)", () => {
    expect(computeIndiaDiagnosis(base({ breadth: [] }))).toBeNull();
  });
  test("the authoritative regime maps direction: CRISIS scores −2 on Trend", () => {
    const d = computeIndiaDiagnosis(base({ authoritativeRegime: { regime: "CRISIS", reasons: [] } }))!;
    expect(d.components.find((c) => c.name === "Trend")!.score).toBe(-2);
  });
});
