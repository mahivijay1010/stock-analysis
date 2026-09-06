/**
 * Decision policy v1 tests (spec §9/§13.13) — the pure evidence gates.
 * Insufficient history / stale data / missing measurements → INSUFFICIENT_EVIDENCE;
 * a coin-flip record can NEVER produce BUY_CANDIDATE; hard risks → AVOID_NEW_ENTRY.
 */

import {
  DECISION_POLICY_VERSION,
  directionEdgeValidated,
  evaluateEntryPolicy,
  PolicyInputs,
} from "../src/services/decision/policy";

const freshIssuance = (over?: Partial<NonNullable<PolicyInputs["issuance"]>>): PolicyInputs["issuance"] => ({
  anchorSessionDate: "2026-09-04",
  anchorAgeDays: 2,
  anchorIsLatestObservedSession: true,
  targetSessionCount: 22,
  annualizedVolPct: 18,
  medianReturnPct30: 0.4,
  ...over,
});

const coinFlipMeasured = { samples: 59, directionHitRatePct: 51.0, withinBandPct: 85.0, brierScore: 0.2525 };

const base = (over?: Partial<PolicyInputs>): PolicyInputs => ({
  ticker: "RELIANCE.NS",
  issuance: freshIssuance(),
  measured: { ...coinFlipMeasured },
  afterMarketClose: true,
  ...over,
});

describe("decision policy v1", () => {
  test("policy version is pinned", () => {
    expect(DECISION_POLICY_VERSION).toBe("decision-policy-v1");
  });

  test("no issuance → INSUFFICIENT_EVIDENCE", () => {
    const d = evaluateEntryPolicy(base({ issuance: null }));
    expect(d.decisionStatus).toBe("INSUFFICIENT_EVIDENCE");
    expect(d.evidenceStatus).toBe("INSUFFICIENT");
    expect(d.reasons.join(" ")).toMatch(/no stored forecast issuance/i);
  });

  test("stale issuance (anchor not latest observed session) → INSUFFICIENT_EVIDENCE", () => {
    const d = evaluateEntryPolicy(
      base({ issuance: freshIssuance({ anchorIsLatestObservedSession: false }) })
    );
    expect(d.decisionStatus).toBe("INSUFFICIENT_EVIDENCE");
    expect(d.reasons.join(" ")).toMatch(/stale/i);
  });

  test("issuance older than 5 calendar days → INSUFFICIENT_EVIDENCE", () => {
    const d = evaluateEntryPolicy(base({ issuance: freshIssuance({ anchorAgeDays: 6 }) }));
    expect(d.decisionStatus).toBe("INSUFFICIENT_EVIDENCE");
  });

  test("no measured record / too few matured samples → INSUFFICIENT_EVIDENCE", () => {
    expect(evaluateEntryPolicy(base({ measured: null })).decisionStatus).toBe("INSUFFICIENT_EVIDENCE");
    const d = evaluateEntryPolicy(base({ measured: { ...coinFlipMeasured, samples: 12 } }));
    expect(d.decisionStatus).toBe("INSUFFICIENT_EVIDENCE");
    expect(d.reasons.join(" ")).toMatch(/12 matured/);
  });

  test("coin-flip record → WAIT with 'No validated directional edge', never BUY", () => {
    const d = evaluateEntryPolicy(base());
    expect(d.decisionStatus).toBe("WAIT");
    expect(d.evidenceStatus).toBe("PARTIAL");
    expect(d.reasons.join(" ")).toMatch(/No validated directional edge/i);
    expect(d.reasons.join(" ")).toMatch(/next session/i); // after-close phrasing
    expect(d.holdingsReviewNote).toMatch(/NOT an instruction to sell/i);
  });

  test("even 55% over 59 samples is not a validated edge (within noise)", () => {
    const d = evaluateEntryPolicy(
      base({ measured: { ...coinFlipMeasured, directionHitRatePct: 55.9 } })
    );
    expect(d.decisionStatus).toBe("WAIT");
  });

  test("band coverage understated → AVOID_NEW_ENTRY", () => {
    const d = evaluateEntryPolicy(base({ measured: { ...coinFlipMeasured, withinBandPct: 48 } }));
    expect(d.decisionStatus).toBe("AVOID_NEW_ENTRY");
    expect(d.reasons.join(" ")).toMatch(/understates/i);
  });

  test("Brier worse than chance → AVOID_NEW_ENTRY", () => {
    const d = evaluateEntryPolicy(base({ measured: { ...coinFlipMeasured, brierScore: 0.31 } }));
    expect(d.decisionStatus).toBe("AVOID_NEW_ENTRY");
  });

  test("extreme volatility → AVOID_NEW_ENTRY with high risk level", () => {
    const d = evaluateEntryPolicy(base({ issuance: freshIssuance({ annualizedVolPct: 72 }) }));
    expect(d.decisionStatus).toBe("AVOID_NEW_ENTRY");
    expect(d.riskLevel).toBe("high");
  });

  test("BUY_CANDIDATE only with a genuinely validated edge (e.g. 65% over 300)", () => {
    const d = evaluateEntryPolicy(
      base({
        measured: { samples: 300, directionHitRatePct: 65, withinBandPct: 82, brierScore: 0.22 },
        afterMarketClose: false,
      })
    );
    expect(d.decisionStatus).toBe("BUY_CANDIDATE");
    expect(d.evidenceStatus).toBe("VALIDATED");
  });

  test("directionEdgeValidated math: 51%/59 fails, 65%/300 passes, 60%/50 fails", () => {
    expect(directionEdgeValidated(51, 59)).toBe(false);
    expect(directionEdgeValidated(65, 300)).toBe(true);
    expect(directionEdgeValidated(60, 50)).toBe(false);
  });
});
