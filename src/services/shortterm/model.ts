/**
 * ShortTermOpportunityModel (S4) — HONEST v1.
 *
 * Distribution: seeded bootstrap of the stock's own adjusted daily returns at
 * the horizon midpoint (same engine as the product's forecasts) → p10/p50/p90
 * and a bracket-applied EV after costs (outcomes clipped at stop/target2 on a
 * quantile grid — a distribution-implied number, labeled as such).
 *
 * Excess: p50 minus NIFTY's own bootstrap median over the same horizon.
 *
 * probabilityTargetBeforeStop is NULL until the meta-label model passes
 * calibration on independent samples (scripts/shortTermStudy.ts writes the
 * promotion verdict into short_term_model_performance; nothing here invents
 * a probability). modelConfidence is LOW unless the setup type has validated
 * out-of-sample evidence — currently none do, and that is stated.
 */

import { adjustedDailyReturns } from "../market/canonical";
import { simulateDailyQuantiles } from "../quant/montecarlo";
import { Bar } from "../market/types";
import { HORIZON_TD, ShortTermForecast, ShortTermHorizon, SHORT_TERM_VERSION } from "./types";
import { SetupClassification } from "./setups";
import { TradePlan } from "./types";

const GRID: Array<{ p: number; w: number }> = [
  { p: 5, w: 0.1 },
  { p: 10, w: 0.1 },
  { p: 25, w: 0.2 },
  { p: 50, w: 0.2 },
  { p: 75, w: 0.2 },
  { p: 90, w: 0.1 },
  { p: 95, w: 0.1 },
];

export function buildShortTermForecast(opts: {
  bars: Bar[];
  niftyBars: Bar[];
  horizon: ShortTermHorizon;
  setup: SetupClassification;
  plan: TradePlan;
  price: number;
  /** Promoted, calibrated meta-label probability if one EVER passes the court; else null. */
  calibratedTargetProb: number | null;
}): ShortTermForecast {
  const h = HORIZON_TD[opts.horizon];
  const statementUnavailable =
    "Target-vs-stop probability unavailable — insufficient calibrated evidence.";
  const base: ShortTermForecast = {
    expectedExcessReturnPct: null,
    p10Pct: null,
    p50Pct: null,
    p90Pct: null,
    probabilityTargetBeforeStop: opts.calibratedTargetProb,
    probabilityStatement: opts.calibratedTargetProb != null ? "calibrated meta-label probability" : statementUnavailable,
    expectedHoldingDays: h.mid,
    modelConfidence: "LOW",
    modelConfidenceReasons: [],
    setupSampleSize: null,
    modelVersion: SHORT_TERM_VERSION,
  };

  try {
    const rets = adjustedDailyReturns(opts.bars.slice(-260));
    if (rets.length < 60) {
      base.modelConfidenceReasons.push("fewer than 60 usable daily returns — no distribution issued");
      return base;
    }
    const sim = simulateDailyQuantiles(rets, h.mid, { paths: 4000 });
    const step = sim.perStep[h.mid - 1];
    base.p10Pct = Math.round(step.q.p10 * 10000) / 100;
    base.p50Pct = Math.round(step.q.p50 * 10000) / 100;
    base.p90Pct = Math.round(step.q.p90 * 10000) / 100;

    const niftyRets = adjustedDailyReturns(opts.niftyBars.slice(-260));
    if (niftyRets.length >= 60) {
      const niftySim = simulateDailyQuantiles(niftyRets, h.mid, { paths: 4000 });
      base.expectedExcessReturnPct =
        Math.round((step.q.p50 - niftySim.perStep[h.mid - 1].q.p50) * 10000) / 100;
    }

    base.modelConfidenceReasons.push(
      `distribution = seeded bootstrap of this stock's own last ${Math.min(250, rets.length)} sessions (historical scenario frequencies, uncalibrated)`,
      "no setup type has validated out-of-sample edge yet — confidence stays LOW by policy"
    );
  } catch {
    base.modelConfidenceReasons.push("distribution unavailable (insufficient data)");
  }
  return base;
}

/**
 * Bracket-applied EV after costs (%): quantile-grid outcomes clipped at the
 * stop (below) and target2 (above), minus round-trip costs + slippage.
 * Distribution-implied — NOT a calibrated trade-win probability.
 */
export function bracketExpectedValuePct(
  forecast: ShortTermForecast,
  plan: TradePlan,
  price: number
): { evAfterCostsPct: number | null; expectedShortfallPct: number | null } {
  if (
    forecast.p10Pct == null ||
    forecast.p50Pct == null ||
    forecast.p90Pct == null ||
    plan.initialStop == null ||
    plan.target2 == null ||
    !(price > 0)
  ) {
    return { evAfterCostsPct: null, expectedShortfallPct: null };
  }
  // Interpolate the 7-point grid from the three known quantiles (monotone linear).
  const q = (p: number): number => {
    const p10 = forecast.p10Pct as number;
    const p50 = forecast.p50Pct as number;
    const p90 = forecast.p90Pct as number;
    if (p <= 10) return p10 - ((10 - p) / 10) * (p50 - p10) * 0.6;
    if (p <= 50) return p10 + ((p - 10) / 40) * (p50 - p10);
    if (p <= 90) return p50 + ((p - 50) / 40) * (p90 - p50);
    return p90 + ((p - 90) / 10) * (p90 - p50) * 0.6;
  };
  const stopPct = ((plan.initialStop - price) / price) * 100;
  const t2Pct = ((plan.target2 - price) / price) * 100;
  let ev = 0;
  let shortfallSum = 0;
  let shortfallW = 0;
  for (const g of GRID) {
    const raw = q(g.p);
    const clipped = Math.min(Math.max(raw, stopPct), t2Pct);
    ev += g.w * clipped;
    if (raw < (forecast.p10Pct as number) + 1e-9 || g.p <= 10) {
      shortfallSum += g.w * Math.max(raw, stopPct);
      shortfallW += g.w;
    }
  }
  const costs = plan.transactionCostPct + plan.estimatedSlippagePct;
  return {
    evAfterCostsPct: Math.round((ev - costs) * 100) / 100,
    expectedShortfallPct: shortfallW > 0 ? Math.round((shortfallSum / shortfallW) * 100) / 100 : null,
  };
}
