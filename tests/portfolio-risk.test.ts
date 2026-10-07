/**
 * Portfolio risk engine, regime gates, fractional Kelly. These pin the things
 * that keep a book of correlated small-caps from blowing up: correlated picks
 * are detected as ONE bet, single-stock/sector caps fire, CVaR is measured on
 * observed co-movement, regime risk-off halves size (CRISIS ⇒ off), and Kelly
 * never inflates size without a calibrated probability.
 */

import { computePortfolioRisk, canAddPosition, PortfolioPosition } from "../src/services/shortterm/portfolioRisk";
import { regimeGateFor, setupAllowedInRegime, REGIME_GATES } from "../src/services/shortterm/regimeGates";
import { fractionalKellyRiskPct } from "../src/services/shortterm/fractionalKelly";

// Deterministic pseudo returns: a base market factor + idiosyncratic noise.
function corrReturns(n: number, loadOnFactor: number, seed: number): number[] {
  const out: number[] = [];
  let s = seed;
  const rnd = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s / 0x7fffffff) * 2 - 1; // −1..1
  };
  const factor: number[] = [];
  let fs = 999;
  for (let i = 0; i < n; i++) {
    fs = (fs * 1103515245 + 12345) & 0x7fffffff;
    factor.push(((fs / 0x7fffffff) * 2 - 1) * 0.02);
  }
  for (let i = 0; i < n; i++) out.push(loadOnFactor * factor[i] + (1 - loadOnFactor) * rnd() * 0.02);
  return out;
}

describe("computePortfolioRisk", () => {
  const pos = (ticker: string, sector: string, value: number, load: number, seed: number): PortfolioPosition => ({
    ticker,
    sector,
    valueInr: value,
    beta: 1.1,
    returns: corrReturns(80, load, seed),
  });

  test("single-stock and sector caps fire as breaches", () => {
    const r = computePortfolioRisk({
      positions: [pos("A", "Financials", 60000, 0.5, 1), pos("B", "Financials", 30000, 0.5, 2)],
      capitalInr: 100000,
      limits: { maxSingleStockPct: 10, maxSectorPct: 30 },
    });
    expect(r.breaches.join(" ")).toMatch(/A is .*\(cap 10%\)/);
    expect(r.breaches.join(" ")).toMatch(/sector Financials/);
    expect(r.sectorExposure[0].sector).toBe("Financials");
  });

  test("highly correlated picks are detected as ONE cluster", () => {
    const r = computePortfolioRisk({
      positions: [pos("X", "Power", 20000, 0.95, 11), pos("Y", "Power", 20000, 0.95, 12), pos("Z", "Power", 20000, 0.95, 13)],
      capitalInr: 100000,
      limits: { correlationThreshold: 0.6 },
    });
    expect(r.correlationClusters.length).toBeGreaterThanOrEqual(1);
    expect(r.correlationClusters[0].tickers.length).toBeGreaterThanOrEqual(2);
    expect(r.largestClusterWeightPct).toBeGreaterThan(0);
  });

  test("Herfindahl and effective names reflect concentration", () => {
    const concentrated = computePortfolioRisk({ positions: [pos("A", "S", 90000, 0.3, 1), pos("B", "S", 10000, 0.3, 2)], capitalInr: 100000 });
    const diversified = computePortfolioRisk({ positions: [pos("A", "S", 25000, 0.3, 1), pos("B", "T", 25000, 0.3, 2), pos("C", "U", 25000, 0.3, 3), pos("D", "V", 25000, 0.3, 4)], capitalInr: 100000 });
    expect(concentrated.herfindahl!).toBeGreaterThan(diversified.herfindahl!);
    expect(diversified.effectiveNames!).toBeGreaterThan(concentrated.effectiveNames!);
  });

  test("VaR/CVaR are non-negative loss %s scaled to deployed capital", () => {
    const r = computePortfolioRisk({ positions: [pos("A", "S", 50000, 0.5, 1), pos("B", "T", 50000, 0.3, 7)], capitalInr: 100000 });
    expect(r.var95Pct).not.toBeNull();
    expect(r.cvar95Pct!).toBeGreaterThanOrEqual(r.var95Pct!); // CVaR ≥ VaR
    expect(r.var95Pct!).toBeGreaterThanOrEqual(0);
    expect(r.cashPct).toBe(0);
  });

  test("too few observations ⇒ VaR withheld, not fabricated", () => {
    const short: PortfolioPosition = { ticker: "A", sector: "S", valueInr: 50000, beta: 1, returns: [0.01, -0.01, 0.02] };
    const r = computePortfolioRisk({ positions: [short], capitalInr: 100000 });
    expect(r.var95Pct).toBeNull();
    expect(r.notes.join(" ")).toMatch(/withheld/);
  });

  test("canAddPosition refuses a pick that breaches the single-stock cap", () => {
    const current = [{ ticker: "A", sector: "S", valueInr: 20000, beta: 1, returns: corrReturns(80, 0.3, 1) }];
    const candidate = { ticker: "B", sector: "S", valueInr: 30000, beta: 1, returns: corrReturns(80, 0.3, 2) };
    const res = canAddPosition({ current, candidate, capitalInr: 100000, limits: { maxSingleStockPct: 10 } });
    expect(res.ok).toBe(false);
    expect(res.reasons.join(" ")).toMatch(/30% of capital|cap 10%/);
  });
});

describe("regimeGates", () => {
  test("risk-off regimes cut size; CRISIS turns new entries off", () => {
    expect(regimeGateFor("TREND_UP").sizeMultiplier).toBe(1);
    expect(regimeGateFor("TREND_DOWN").sizeMultiplier).toBe(0.5);
    expect(regimeGateFor("CRISIS").sizeMultiplier).toBe(0);
    expect(regimeGateFor("HIGH_VOL").stopAtrMultiplier).toBeGreaterThan(1); // wider stops
  });

  test("CHOPPY allows only mean-reversion; TREND_DOWN only trend setups", () => {
    expect(setupAllowedInRegime("BREAKOUT", REGIME_GATES.CHOPPY.allowedSetups)).toBe(false);
    expect(setupAllowedInRegime("PULLBACK", REGIME_GATES.CHOPPY.allowedSetups)).toBe(true);
    expect(setupAllowedInRegime("MOMENTUM", REGIME_GATES.TREND_DOWN.allowedSetups)).toBe(true);
    expect(setupAllowedInRegime("MEAN_REVERSION", REGIME_GATES.TREND_DOWN.allowedSetups)).toBe(false);
  });

  test("an unknown regime falls back to the cautious CHOPPY profile", () => {
    expect(regimeGateFor("WAT").regime).toBe("CHOPPY");
  });
});

describe("fractionalKellyRiskPct", () => {
  test("no calibrated p ⇒ fixed-risk fallback, Kelly withheld", () => {
    const r = fractionalKellyRiskPct({ rewardToRisk: 2, pWin: null, maxRiskPct: 1, fixedRiskPct: 0.5 });
    expect(r.riskPct).toBe(0.5);
    expect(r.usedCalibratedP).toBe(false);
    expect(r.kellyF).toBeNull();
  });

  test("a calibrated edge sizes a fraction of Kelly, capped at the ceiling", () => {
    const r = fractionalKellyRiskPct({ rewardToRisk: 2, pWin: 0.55, maxRiskPct: 2, kellyFraction: 0.25 });
    // f* = (0.55*3 − 1)/2 = 0.325 ; quarter-Kelly ⇒ 8.1% uncapped ⇒ capped at 2%.
    expect(r.usedCalibratedP).toBe(true);
    expect(r.kellyF).toBeCloseTo(0.325, 3);
    expect(r.riskPct).toBe(2); // hit the ceiling
  });

  test("a non-positive edge ⇒ 0% risk (no trade)", () => {
    const r = fractionalKellyRiskPct({ rewardToRisk: 1, pWin: 0.4, maxRiskPct: 2 });
    expect(r.riskPct).toBe(0);
    expect(r.basis).toMatch(/no trade/i);
  });
});
