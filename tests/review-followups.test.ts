/**
 * Follow-ups to the external review:
 *  - gate MONOTONICITY (worsening any input never raises the allowed action)
 *  - intrabar AMBIGUOUS resolution (adverse-assumed, flagged)
 *  - shadow-ledger accounting identity
 *  - probability_status is machine-readable
 */

import { evaluateEntryPolicy, PolicyInputs } from "../src/services/decision/policy";
import { composeCeiling, actionRank, EvidenceTier, ShortTermActionV2, FreshnessV2 } from "../src/services/shortterm/actionStates";
import { simulateBracket, OhlcBar } from "../src/services/shortterm/shadowFill";
import { reconcileLedger } from "../src/services/research/ResearchJobsService";

const bar = (d: string, o: number, h: number, l: number, c: number): OhlcBar => ({ date: d, open: o, high: h, low: l, close: c });

const buyable = (over?: Partial<PolicyInputs>): PolicyInputs => ({
  ticker: "T.NS",
  issuance: { anchorSessionDate: "2026-09-05", anchorAgeDays: 1, anchorIsLatestObservedSession: true, targetSessionCount: 21, annualizedVolPct: 25, medianReturnPct30: 2 },
  measured: { samples: 600, directionHitRatePct: 75, withinBandPct: 78, brierScore: 0.2 },
  afterMarketClose: true, riskScore: 40, dataQualityScore: 85, forecastConfidenceScore: 70,
  entryQualityScore: 60, evAfterCostsPct: 1.2, regime: { marketRegime: "bull_low_vol", entryRegime: "healthy_uptrend" },
  modelHealthState: "HEALTHY", ...over,
});

describe("gate monotonicity (reviewer: gates must be monotonic)", () => {
  const rank: Record<string, number> = { INSUFFICIENT_EVIDENCE: 0, AVOID_NEW_ENTRY: 1, WAIT: 2, BUY_CANDIDATE: 3 };
  const base = evaluateEntryPolicy(buyable());
  test("control reaches BUY_CANDIDATE", () => expect(base.decisionStatus).toBe("BUY_CANDIDATE"));

  test("worsening ANY single gate input never RAISES the action", () => {
    const worsens: Array<Partial<PolicyInputs>> = [
      { dataQualityScore: 50 }, { dataQualityScore: null },
      { forecastConfidenceScore: 40 }, { forecastConfidenceScore: null },
      { entryQualityScore: 10 }, { entryQualityScore: null },
      { evAfterCostsPct: -0.5 }, { evAfterCostsPct: null },
      { regime: null }, { regime: { marketRegime: "bear_high_vol", entryRegime: "neutral" } },
      { modelHealthState: "SUSPENDED" }, { modelHealthState: "INSUFFICIENT_HISTORY" }, { modelHealthState: null },
      { measured: { samples: 600, directionHitRatePct: 50, withinBandPct: 78, brierScore: 0.25 } },
      { riskScore: 95 },
    ];
    for (const w of worsens) {
      const d = evaluateEntryPolicy(buyable(w));
      expect(rank[d.decisionStatus]).toBeLessThanOrEqual(rank[base.decisionStatus]);
    }
  });

  test("ceiling is monotone: every unhealthy input lowers or holds the ceiling", () => {
    const clean = composeCeiling({ tier: "A", modelHealthState: "HEALTHY", modelConfidence: "HIGH", freshness: "EOD_FINAL", confirmationSatisfied: true, evLowerBoundPositive: true, affordable: true, contradictionCeilings: [] });
    const degradations: Array<Record<string, unknown>> = [
      { tier: "C" as EvidenceTier }, { modelConfidence: "LOW" }, { freshness: "STALE" as FreshnessV2 },
      { confirmationSatisfied: false }, { evLowerBoundPositive: false }, { affordable: false },
      { contradictionCeilings: ["NO_TRADE" as ShortTermActionV2] },
    ];
    for (const d of degradations) {
      const r = composeCeiling({ tier: "A", modelHealthState: "HEALTHY", modelConfidence: "HIGH", freshness: "EOD_FINAL", confirmationSatisfied: true, evLowerBoundPositive: true, affordable: true, contradictionCeilings: [], ...d } as never);
      expect(actionRank(r.ceiling)).toBeLessThanOrEqual(actionRank(clean.ceiling));
    }
  });
});

describe("intrabar ambiguity (reviewer: EOD OHLC can't order same-bar stop+target)", () => {
  const common = { entryType: "zone" as const, zoneLow: 98, zoneHigh: 100, triggerPrice: null, stop: 95, target: 108, entryWindow: 3, maxHold: 10, roundTripCostPct: 0.3, slippagePct: 0.2 };
  test("a bar whose low hits the stop AND high hits the target ⇒ AMBIGUOUS_INTRABAR, resolved adversely", () => {
    const forward = [bar("d1", 100, 100, 99, 99.8), bar("d2", 100, 110, 94, 100)]; // d2 straddles 95 and 108
    const r = simulateBracket({ ...common, forward });
    expect(r.outcome).toBe("AMBIGUOUS_INTRABAR");
    expect(r.ambiguous).toBe(true);
    expect(r.exitPrice).toBe(95); // adverse (stop) assumed — never the favorable target
    expect(r.netRMultiple!).toBeLessThan(0);
  });
  test("a malformed candle ⇒ DATA_INVALID (unscored)", () => {
    const forward = [bar("d1", 100, 100, 99, 99.8), { date: "d2", open: 100, high: 90, low: 101, close: 95 }];
    const r = simulateBracket({ ...common, forward });
    expect(r.outcome).toBe("DATA_INVALID");
    expect(r.netRMultiple).toBeNull();
  });
  test("clean single-touch bars are unaffected", () => {
    const win = simulateBracket({ ...common, forward: [bar("d1", 100, 100, 99, 99.8), bar("d2", 100, 109, 99, 108)] });
    expect(win.outcome).toBe("TARGET_FIRST");
    expect(win.ambiguous).toBe(false);
  });
});

describe("shadow-ledger accounting identity", () => {
  test("balanced when resolved + pending = total", () => {
    const r = reconcileLedger({ total: 100, resolved: 60, pending: 40, ambiguous: 5, dataInvalid: 1 });
    expect(r.balanced).toBe(true);
    expect(r.discrepancy).toBe(0);
  });
  test("flags a dropped/duplicated resolution", () => {
    const dropped = reconcileLedger({ total: 100, resolved: 59, pending: 40, ambiguous: 0, dataInvalid: 0 });
    expect(dropped.balanced).toBe(false);
    expect(dropped.discrepancy).toBe(1);
    const dup = reconcileLedger({ total: 100, resolved: 61, pending: 40, ambiguous: 0, dataInvalid: 0 });
    expect(dup.balanced).toBe(false);
    expect(dup.discrepancy).toBe(-1);
  });
});
