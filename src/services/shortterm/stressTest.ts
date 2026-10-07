/**
 * Stress testing / historical crash replay (stress-test-v1) — PURE.
 *
 * VaR tells you a normal bad day; stress testing tells you the tail — what the
 * book loses when small-caps crash together, which is the only scenario that
 * actually kills a sub-₹100 strategy. It replays the current positions against
 * real historical shocks (2008, 2020, 2022, 2024) using each name's beta to the
 * small-cap index, and — crucially — checks whether the STOPS would actually
 * fill or GAP THROUGH. A 10% stop is worthless in a −20% gap; this makes that
 * explicit instead of letting a theoretical stop flatter the risk.
 */

export const STRESS_TEST_VERSION = "stress-test-v1";

export interface StressPosition {
  ticker: string;
  sector: string | null;
  valueInr: number;
  /** Beta to the small-cap index; defaults to 1.2 (small-caps run hot) when null. */
  beta: number | null;
  /** Stop distance from entry, % (positive). Null ⇒ no stop modelled. */
  stopPct: number | null;
}

export interface StressScenario {
  name: string;
  smallcapShockPct: number; // the index move over the window (negative)
  description: string;
}

/** Real small-cap index shocks (NIFTY Smallcap 100, approximate worst 5-day
 *  moves). Conservative, documented — not forecasts. */
export const HISTORICAL_SCENARIOS: StressScenario[] = [
  { name: "2008 GFC (5-day)", smallcapShockPct: -28, description: "Global financial crisis cascade" },
  { name: "2020 COVID crash (5-day)", smallcapShockPct: -32, description: "March 2020 liquidity shock" },
  { name: "2022 small-cap drawdown", smallcapShockPct: -18, description: "2022 rate-shock de-rating" },
  { name: "2024 election-day gap", smallcapShockPct: -12, description: "4 Jun 2024 result-day gap" },
  { name: "Generic −8% small-cap week", smallcapShockPct: -8, description: "A routine risk-off week" },
];

const DEFAULT_BETA = 1.2;

export interface PositionStress {
  ticker: string;
  shockPct: number; // beta-adjusted move
  lossInr: number; // negative
  stopPct: number | null;
  gapThroughStop: boolean; // the shock blew past the stop ⇒ stop won't save you
}

export interface ScenarioResult {
  scenario: string;
  smallcapShockPct: number;
  portfolioLossInr: number;
  portfolioLossPct: number; // of capital
  worstPosition: { ticker: string; lossInr: number; shockPct: number } | null;
  stopsThatGapThrough: string[];
  note: string;
}

export interface StressReport {
  version: string;
  capitalInr: number;
  deployedInr: number;
  scenarios: ScenarioResult[];
  headline: string;
  caveat: string;
}

const r2 = (x: number): number => Math.round(x * 100) / 100;
const r0 = (x: number): number => Math.round(x);

export function stressTestBook(positions: StressPosition[], capitalInr: number, scenarios: StressScenario[] = HISTORICAL_SCENARIOS): StressReport {
  const deployed = positions.reduce((a, p) => a + Math.max(0, p.valueInr), 0);
  const capital = capitalInr > 0 ? capitalInr : deployed || 1;

  const results: ScenarioResult[] = scenarios.map((sc) => {
    const perPos: PositionStress[] = positions.map((p) => {
      const beta = p.beta != null && Number.isFinite(p.beta) ? p.beta : DEFAULT_BETA;
      const shock = beta * sc.smallcapShockPct; // beta-adjusted move, %
      const gap = p.stopPct != null && Math.abs(shock) > p.stopPct;
      // If the stop gaps through, the realised loss is the full shock (you exit
      // at the gap, not the stop). If it would fill, the loss is capped near the
      // stop (modelled as the stop level, a small slippage beyond ignored).
      const effectiveLossPct = gap || p.stopPct == null ? shock : -Math.min(p.stopPct, Math.abs(shock));
      return { ticker: p.ticker, shockPct: r2(shock), lossInr: r0(p.valueInr * (effectiveLossPct / 100)), stopPct: p.stopPct, gapThroughStop: !!gap };
    });
    const portfolioLoss = perPos.reduce((a, p) => a + p.lossInr, 0);
    const worst = perPos.length ? perPos.reduce((w, p) => (p.lossInr < w.lossInr ? p : w)) : null;
    return {
      scenario: sc.name,
      smallcapShockPct: sc.smallcapShockPct,
      portfolioLossInr: r0(portfolioLoss),
      portfolioLossPct: r2((portfolioLoss / capital) * 100),
      worstPosition: worst ? { ticker: worst.ticker, lossInr: worst.lossInr, shockPct: worst.shockPct } : null,
      stopsThatGapThrough: perPos.filter((p) => p.gapThroughStop).map((p) => p.ticker),
      note: sc.description,
    };
  });

  const worstScenario = results.reduce((w, r) => (r.portfolioLossPct < w.portfolioLossPct ? r : w), results[0]);
  const headline =
    positions.length === 0
      ? "No open positions — nothing to stress."
      : `Worst case (${worstScenario.scenario}): a ${worstScenario.portfolioLossPct}% portfolio loss (₹${Math.abs(worstScenario.portfolioLossInr).toLocaleString("en-IN")})${worstScenario.stopsThatGapThrough.length ? `, with ${worstScenario.stopsThatGapThrough.length} stop(s) gapping through` : ""}.`;

  return {
    version: STRESS_TEST_VERSION,
    capitalInr: capital,
    deployedInr: deployed,
    scenarios: results,
    headline,
    caveat:
      "Losses are beta-adjusted replays of historical small-cap index shocks, not forecasts. 'Stop gaps through' means the move exceeds the stop distance — in a real gap you exit worse than your stop, so the stop does NOT cap the loss.",
  };
}
