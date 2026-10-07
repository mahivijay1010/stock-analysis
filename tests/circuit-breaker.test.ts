/**
 * Drawdown circuit breaker + crash stress test. These pin the safety rules:
 * a negative rolling edge or a deep drawdown HALTS new entries; a healthy book
 * in a risk-off regime holds in COOLDOWN (not ACTIVE); too few trades ⇒ the
 * breaker abstains rather than guessing; and the stress test makes a stop that
 * gaps through in a −30% crash explicit instead of flattering the loss.
 */

import { assessCircuitBreaker, ClosedTrade } from "../src/services/shortterm/circuitBreaker";
import { stressTestBook, StressPosition, HISTORICAL_SCENARIOS } from "../src/services/shortterm/stressTest";

function trades(rs: number[], start = "2026-01-01"): ClosedTrade[] {
  let d = new Date(start + "T00:00:00Z").getTime();
  return rs.map((r) => {
    const date = new Date(d).toISOString().slice(0, 10);
    d += 86400000;
    return { date, realizedR: r };
  });
}

describe("assessCircuitBreaker", () => {
  test("fewer than the minimum resolved trades ⇒ abstains (INSUFFICIENT), still can enter", () => {
    const r = assessCircuitBreaker(trades([1, -1, 1]), "TREND_UP");
    expect(r.state).toBe("INSUFFICIENT");
    expect(r.canEnter).toBe(true);
    expect(r.reasons[0]).toMatch(/abstains/);
  });

  test("a negative rolling expectancy TRIPS the breaker and halts entries", () => {
    // 20 trades, mostly losses ⇒ negative rolling expectancy.
    const r = assessCircuitBreaker(trades(Array.from({ length: 20 }, (_, i) => (i % 5 === 0 ? 1.5 : -1))), "TREND_UP");
    expect(r.state).toBe("TRIPPED");
    expect(r.canEnter).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/expectancy/);
    expect(r.resumeConditions.length).toBeGreaterThan(0);
  });

  test("a deep drawdown TRIPS the breaker even if the last few trades are green", () => {
    // Big early losses create a deep drawdown; a couple of recent wins don't clear it.
    const r = assessCircuitBreaker(trades([...Array(18).fill(-1), 1, 1]), "TREND_UP", { maxDrawdownR: 6 });
    expect(r.currentDrawdownR).toBeGreaterThan(6);
    expect(r.state).toBe("TRIPPED");
    expect(r.canEnter).toBe(false);
  });

  test("a healthy book in a risk-off regime holds in COOLDOWN, not ACTIVE", () => {
    const r = assessCircuitBreaker(trades(Array.from({ length: 25 }, (_, i) => (i % 2 ? 1.2 : -0.8))), "TREND_DOWN");
    expect(["COOLDOWN", "TRIPPED"]).toContain(r.state);
    expect(r.canEnter).toBe(false);
    expect(r.regimeRiskOff).toBe(true);
  });

  test("a healthy book in a benign regime is ACTIVE and may enter", () => {
    const r = assessCircuitBreaker(trades(Array.from({ length: 25 }, (_, i) => (i % 2 ? 1.5 : -0.5))), "TREND_UP");
    expect(r.state).toBe("ACTIVE");
    expect(r.canEnter).toBe(true);
    expect(r.rollingExpectancyR!).toBeGreaterThan(0);
  });
});

describe("stressTestBook", () => {
  const book: StressPosition[] = [
    { ticker: "A.NS", sector: "Power", valueInr: 40000, beta: 1.3, stopPct: 8 },
    { ticker: "B.NS", sector: "Financials", valueInr: 30000, beta: 1.0, stopPct: 10 },
  ];

  test("losses scale with beta and the worst scenario is reported", () => {
    const r = stressTestBook(book, 100000);
    expect(r.scenarios.length).toBe(HISTORICAL_SCENARIOS.length);
    const covid = r.scenarios.find((s) => s.scenario.includes("COVID"))!;
    // A.NS: beta 1.3 × −32% = −41.6% on ₹40k ≈ −₹16.6k.
    expect(covid.portfolioLossInr).toBeLessThan(0);
    expect(covid.worstPosition!.ticker).toBe("A.NS");
    expect(r.headline).toMatch(/[Ww]orst case/);
  });

  test("a stop that gaps through in a crash is flagged (it does NOT cap the loss)", () => {
    const r = stressTestBook(book, 100000);
    const covid = r.scenarios.find((s) => s.scenario.includes("COVID"))!;
    // Both stops (8%, 10%) are blown through by a ~−32% move.
    expect(covid.stopsThatGapThrough).toContain("A.NS");
    expect(covid.stopsThatGapThrough).toContain("B.NS");
  });

  test("a mild scenario within the stop distance does NOT gap through", () => {
    const tight: StressPosition[] = [{ ticker: "C.NS", sector: "IT", valueInr: 20000, beta: 0.4, stopPct: 10 }];
    const r = stressTestBook(tight, 100000);
    const mild = r.scenarios.find((s) => s.scenario.includes("−8%"))!;
    // beta 0.4 × −8% = −3.2%, inside the 10% stop ⇒ no gap-through.
    expect(mild.stopsThatGapThrough).not.toContain("C.NS");
  });

  test("no positions ⇒ an honest empty report", () => {
    const r = stressTestBook([], 100000);
    expect(r.headline).toMatch(/No open positions/);
  });
});
