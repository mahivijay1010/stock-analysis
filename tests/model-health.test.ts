/**
 * Phase 13 tests — the SUSPENDED hard cap in decision-policy-v5, and the
 * conservative direction of the health states: null / INSUFFICIENT_HISTORY
 * never loosen anything; SUSPENDED always blocks BUY.
 */

import { evaluateEntryPolicy, PolicyInputs } from "../src/services/decision/policy";
import { HEALTH_THRESHOLDS } from "../src/services/monitoring/ModelHealthService";

/** Inputs that pass every OTHER gate (mirrors the policy suite's edge-case fixture). */
function buyableInputs(over?: Partial<PolicyInputs>): PolicyInputs {
  return {
    ticker: "TEST.NS",
    issuance: {
      anchorSessionDate: "2026-09-05",
      anchorAgeDays: 1,
      anchorIsLatestObservedSession: true,
      targetSessionCount: 21,
      annualizedVolPct: 25,
      medianReturnPct30: 2.1,
    },
    measured: {
      samples: 600, // effective ≈ 20 ≥ 10
      directionHitRatePct: 75, // validates at 95% one-sided on 20 obs
      withinBandPct: 78,
      brierScore: 0.2,
    },
    afterMarketClose: true,
    riskScore: 40,
    dataQualityScore: 85,
    forecastConfidenceScore: 70,
    entryQualityScore: 60,
    evAfterCostsPct: 1.2,
    regime: { marketRegime: "bull_low_vol", entryRegime: "healthy_uptrend" },
    ...over,
  };
}

describe("decision-policy-v5 — model health cap (Phase 13)", () => {
  test("baseline fixture reaches BUY_CANDIDATE (control)", () => {
    const d = evaluateEntryPolicy(buyableInputs());
    expect(d.decisionStatus).toBe("BUY_CANDIDATE");
  });

  test("SUSPENDED hard-caps to WATCH with its own unmet gate", () => {
    const d = evaluateEntryPolicy(buyableInputs({ modelHealthState: "SUSPENDED" }));
    expect(d.decisionStatus).toBe("WAIT");
    const gate = d.unmetGates.find((g) => g.gate === "model health");
    expect(gate).toBeDefined();
    expect(gate!.current).toBe("SUSPENDED");
  });

  test("null, HEALTHY, DEGRADED and INSUFFICIENT_HISTORY do not add the cap", () => {
    for (const state of [null, "HEALTHY", "DEGRADED", "INSUFFICIENT_HISTORY"]) {
      const d = evaluateEntryPolicy(buyableInputs({ modelHealthState: state }));
      expect(d.unmetGates.find((g) => g.gate === "model health")).toBeUndefined();
      expect(d.decisionStatus).toBe("BUY_CANDIDATE");
    }
  });

  test("SUSPENDED still caps when other gates already failed (stacking, no override)", () => {
    const d = evaluateEntryPolicy(
      buyableInputs({ modelHealthState: "SUSPENDED", entryQualityScore: 10 })
    );
    expect(d.decisionStatus).toBe("WAIT");
    expect(d.unmetGates.map((g) => g.gate)).toEqual(expect.arrayContaining(["model health", "entry quality"]));
  });

  test("suspension thresholds are the documented constants (conservative-only changes need a study)", () => {
    expect(HEALTH_THRESHOLDS.suspendedBrier).toBe(0.35);
    expect(HEALTH_THRESHOLDS.suspendedCoveragePct).toBe(55);
    expect(HEALTH_THRESHOLDS.minEffectiveResolved).toBe(10);
  });
});
