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
  evaluateHolderPolicy,
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
    expect(DECISION_POLICY_VERSION).toBe("decision-policy-v5");
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


/* ------------------------------------------------------------------ */
/* v3 TradeGate additions (risk-spec Rules 2, 8, 14, 16)               */
/* ------------------------------------------------------------------ */

const strongMeasured = { samples: 3000, directionHitRatePct: 65, withinBandPct: 82, brierScore: 0.22 };

const buyReady = (over?: Partial<PolicyInputs>): PolicyInputs =>
  base({
    measured: { ...strongMeasured },
    afterMarketClose: false,
    riskScore: 40,
    dataQualityScore: 85,
    forecastConfidenceScore: 70,
    entryQualityScore: 65,
    evAfterCostsPct: 1.4,
    ...over,
  });

describe("decision policy v3 gates", () => {
  test("all v3 gates passing + validated edge → BUY_CANDIDATE (the gate is reachable in principle)", () => {
    const d = evaluateEntryPolicy(buyReady());
    expect(d.decisionStatus).toBe("BUY_CANDIDATE");
    expect(d.unmetGates).toHaveLength(0);
  });

  test("Brier skill ≤ 0 caps at WATCH even with a >50% hit rate and huge N", () => {
    const d = evaluateEntryPolicy(buyReady({ measured: { ...strongMeasured, brierScore: 0.2533 } }));
    expect(d.decisionStatus).toBe("WAIT");
    expect(d.reasons.join(" ")).toMatch(/Brier skill .* ≤ 0/);
    expect(d.unmetGates.some((g) => g.gate === "Brier skill")).toBe(true);
  });

  test("data quality < 70 caps at WATCH", () => {
    const d = evaluateEntryPolicy(buyReady({ dataQualityScore: 55 }));
    expect(d.decisionStatus).toBe("WAIT");
    expect(d.unmetGates.some((g) => g.gate === "data quality")).toBe(true);
  });

  test("forecast confidence < 60 caps at WATCH", () => {
    const d = evaluateEntryPolicy(buyReady({ forecastConfidenceScore: 35 }));
    expect(d.decisionStatus).toBe("WAIT");
    expect(d.unmetGates.some((g) => g.gate === "forecast confidence")).toBe(true);
  });

  test("unattractive entry (<40) caps at WATCH — strong setup does not buy an extended price", () => {
    const d = evaluateEntryPolicy(buyReady({ entryQualityScore: 30 }));
    expect(d.decisionStatus).toBe("WAIT");
    expect(d.reasons.join(" ")).toMatch(/unattractive entry/i);
  });

  test("EV ≤ 0 after costs caps at WATCH — P(up)>50% alone never justifies BUY (Rule 8)", () => {
    const d = evaluateEntryPolicy(buyReady({ evAfterCostsPct: -0.3 }));
    expect(d.decisionStatus).toBe("WAIT");
    expect(d.unmetGates.some((g) => g.gate === "expected value")).toBe(true);
  });

  test("unified riskScore ≥ 80 → AVOID_NEW_ENTRY (closes the 45–60% vol gap)", () => {
    const d = evaluateEntryPolicy(buyReady({ riskScore: 85 }));
    expect(d.decisionStatus).toBe("AVOID_NEW_ENTRY");
    expect(d.riskLevel).toBe("high");
  });

  test("null v3 inputs (not assessed) never LOOSEN the gate — v2 fixtures behave identically", () => {
    const v2Only = evaluateEntryPolicy(base());
    expect(v2Only.decisionStatus).toBe("WAIT"); // same as the v2 suite above
  });
});

describe("Rule 16 — generalized extended-entry regression (the BHEL shape, not hardcoded)", () => {
  // The historical failure state: setup ~79, ~36% vol, near 52w high after a
  // rally, expensive valuation, incomplete fundamentals, hit rate 79.5% over
  // 39 OVERLAPPING windows (≈1 independent), system Brier skill < 0.
  const bhelShape = (): PolicyInputs =>
    base({
      measured: { samples: 39, directionHitRatePct: 79.5, withinBandPct: 100, brierScore: 0.2533 },
      afterMarketClose: false,
      riskScore: 45, // 36% vol + ~20% drawdown through the unified formula
      dataQualityScore: 72, // moderate: fundamentals partly missing
      forecastConfidenceScore: 12, // skill<0 + effN=1 ⇒ LOW by construction
      entryQualityScore: 38, // extension + valuation penalties
      evAfterCostsPct: -0.4, // ~zero-drift bootstrap minus costs
    });

  test("new entry is WATCH — never a strong BUY from momentum/setup alone", () => {
    const d = evaluateEntryPolicy(bhelShape());
    expect(d.decisionStatus).toBe("WAIT");
    expect(d.decisionStatus).not.toBe("BUY_CANDIDATE");
    const joined = d.reasons.join(" ");
    expect(joined).toMatch(/independent observation/);
    expect(joined).toMatch(/Brier skill .* ≤ 0|No validated directional edge/);
    // Rule 17: the "what would change the decision" list names the failed gates.
    const gates = d.unmetGates.map((g) => g.gate);
    expect(gates).toEqual(
      expect.arrayContaining(["Brier skill", "directional edge", "forecast confidence", "entry quality", "expected value"])
    );
  });

  test("existing holder gets a SEPARATE decision — HOLD/REVIEW, never an implied sell", () => {
    const inputs = bhelShape();
    const entry = evaluateEntryPolicy(inputs);
    const holder = evaluateHolderPolicy(entry, inputs);
    expect(["HOLD", "REVIEW"]).toContain(holder.action);
    expect(holder.reasons.join(" ")).not.toMatch(/\bsell\b/i);
  });
});

describe("evaluateHolderPolicy (Rule 14)", () => {
  test("default is HOLD with the not-about-your-position explanation", () => {
    const inputs = base();
    const h = evaluateHolderPolicy(evaluateEntryPolicy(inputs), inputs);
    expect(h.action).toBe("HOLD");
    expect(h.reasons.join(" ")).toMatch(/NEW money/i);
  });

  test("extreme risk score → REVIEW (position-size check, not a sell order)", () => {
    const inputs = base({ riskScore: 85 });
    const h = evaluateHolderPolicy(evaluateEntryPolicy(inputs), inputs);
    expect(h.action).toBe("REVIEW");
    expect(h.reasons.join(" ")).toMatch(/position size/i);
  });

  test("collapsed data quality → REVIEW", () => {
    const inputs = base({ dataQualityScore: 40 });
    const h = evaluateHolderPolicy(evaluateEntryPolicy(inputs), inputs);
    expect(h.action).toBe("REVIEW");
  });

  test("measured coverage breakdown → REVIEW", () => {
    const inputs = base({ measured: { ...coinFlipMeasured, withinBandPct: 45 } });
    const h = evaluateHolderPolicy(evaluateEntryPolicy(inputs), inputs);
    expect(h.action).toBe("REVIEW");
    expect(h.reasons.join(" ")).toMatch(/understated/i);
  });

  test("user's LOW risk tolerance + risky stock → REVIEW; tolerance is never inferred", () => {
    const inputs = base({ riskScore: 65 });
    const withTolerance = evaluateHolderPolicy(evaluateEntryPolicy(inputs), inputs, { riskTolerance: "low" });
    expect(withTolerance.action).toBe("REVIEW");
    const without = evaluateHolderPolicy(evaluateEntryPolicy(inputs), inputs);
    expect(without.action).toBe("HOLD"); // no tolerance supplied ⇒ no tolerance-based nag
  });

  test("nothing at all to evaluate → INSUFFICIENT_DATA", () => {
    const inputs = base({ issuance: null, measured: null });
    const h = evaluateHolderPolicy(evaluateEntryPolicy(inputs), inputs);
    expect(h.action).toBe("INSUFFICIENT_DATA");
  });
});
