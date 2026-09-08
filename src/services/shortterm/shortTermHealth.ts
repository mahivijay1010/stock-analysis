/**
 * Short-term model health / live authority (Parts 2/24/25).
 *
 * A setup that earns TIER A in BACKTEST still needs PROSPECTIVE live-shadow
 * confirmation before it may drive an ENTRY_CONFIRMED live action. This is the
 * separation the directive demands: backtest evidence establishes tier;
 * out-of-sample shadow behaviour establishes live authority.
 *
 * States: SHADOW (earning live evidence — cannot confirm entries yet),
 * HEALTHY, DEGRADED, SUSPENDED. Required LIVE evidence is measured in
 * EFFECTIVE INDEPENDENT trades (distinct entry dates), not raw count, because
 * same-day entries are correlated (Part 24).
 */

export type ShortTermHealthState = "SHADOW" | "HEALTHY" | "DEGRADED" | "SUSPENDED";

export const LIVE_AUTHORITY = {
  minEffectiveShadowTrades: 20, // distinct-date resolved shadow trades before HEALTHY is possible
  degradedExpectancyR: 0,
  suspendedExpectancyR: -0.2,
} as const;

export interface ShortTermHealthResult {
  state: ShortTermHealthState;
  reasons: string[];
  effectiveShadowTrades: number;
}

export function assessShortTermHealth(opts: {
  backtestUsableForEntry: boolean;
  resolvedShadowTrades: number;
  distinctShadowDates: number;
  liveExpectancyR: number | null;
}): ShortTermHealthResult {
  const eff = opts.distinctShadowDates;
  if (!opts.backtestUsableForEntry) {
    return { state: "SHADOW", reasons: ["setup not validated in backtest — running in shadow only"], effectiveShadowTrades: eff };
  }
  if (eff < LIVE_AUTHORITY.minEffectiveShadowTrades || opts.liveExpectancyR == null) {
    return {
      state: "SHADOW",
      reasons: [
        `backtest tier A, but only ${eff} independent live-shadow trades resolved (< ${LIVE_AUTHORITY.minEffectiveShadowTrades}) — live authority not yet earned`,
      ],
      effectiveShadowTrades: eff,
    };
  }
  if (opts.liveExpectancyR <= LIVE_AUTHORITY.suspendedExpectancyR) {
    return { state: "SUSPENDED", reasons: [`live-shadow expectancy ${opts.liveExpectancyR}R ≤ ${LIVE_AUTHORITY.suspendedExpectancyR}R — suspended`], effectiveShadowTrades: eff };
  }
  if (opts.liveExpectancyR <= LIVE_AUTHORITY.degradedExpectancyR) {
    return { state: "DEGRADED", reasons: [`live-shadow expectancy ${opts.liveExpectancyR}R not yet positive — degraded`], effectiveShadowTrades: eff };
  }
  return { state: "HEALTHY", reasons: [`live-shadow expectancy ${opts.liveExpectancyR}R positive over ${eff} independent trades`], effectiveShadowTrades: eff };
}
