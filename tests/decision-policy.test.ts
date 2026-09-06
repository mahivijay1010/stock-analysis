/**
 * Decision policy v1 tests (spec §9/§13.13) — the pure evidence gates.
 * Insufficient history / stale data / missing measurements → INSUFFICIENT_EVIDENCE;
 * a coin-flip record can NEVER produce BUY_CANDIDATE; hard risks → AVOID_NEW_ENTRY.
 */

import {
  DECISION_POLICY_VERSION,
  directionEdgeValidated,
  effectiveSamples,
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
    expect(DECISION_POLICY_VERSION).toBe("decision-policy-v2");
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
    expect(d.reasons.join(" ")).toMatch(/independent observation/i); // overlap adjustment stated
    expect(d.reasons.join(" ")).toMatch(/next session/i); // after-close phrasing
    expect(d.holdingsReviewNote).toMatch(/NOT an instruction to sell/i);
  });

  test("v2 regression: a HIGH hit rate over overlapping windows is NOT an edge (the BHEL mirage)", () => {
    // 74% over 39 daily-logged 30d predictions = ~1 independent window — v1
    // wrongly validated this; v2 must not.
    const d = evaluateEntryPolicy(
      base({ measured: { ...coinFlipMeasured, directionHitRatePct: 74, samples: 39 } })
    );
    expect(d.decisionStatus).toBe("WAIT");
    expect(d.reasons.join(" ")).toMatch(/~1 independent observation/);
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

  test("BUY_CANDIDATE only with a genuinely validated edge (65% over 3000 raw = 100 windows)", () => {
    const d = evaluateEntryPolicy(
      base({
        measured: { samples: 3000, directionHitRatePct: 65, withinBandPct: 82, brierScore: 0.22 },
        afterMarketClose: false,
      })
    );
    expect(d.decisionStatus).toBe("BUY_CANDIDATE");
    expect(d.evidenceStatus).toBe("VALIDATED");
    expect(d.reasons.join(" ")).toMatch(/overlap adjustment/i);
  });

  test("directionEdgeValidated math (overlap-adjusted)", () => {
    expect(effectiveSamples(39)).toBe(1);
    expect(effectiveSamples(3000)).toBe(100);
    expect(directionEdgeValidated(51, 59)).toBe(false); // ~1 window
    expect(directionEdgeValidated(74, 39)).toBe(false); // the BHEL mirage
    expect(directionEdgeValidated(65, 300)).toBe(false); // 10 windows: 0.65−1.645·0.158 < 0.5
    expect(directionEdgeValidated(65, 3000)).toBe(true); // 100 windows: 0.65−1.645·0.05 > 0.5
  });
});
