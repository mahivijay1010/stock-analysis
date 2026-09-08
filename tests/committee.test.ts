/**
 * AI committee tests (risk-spec Rule 13, 19) — strict output-schema
 * validation and the CAP-ONLY clamp: the committee can never raise an action
 * past the TradeGate, claim HIGH confidence with Brier skill ≤ 0, or exceed
 * LOW confidence on inadequate effective samples. These guarantees live in
 * CODE, not in the prompt.
 */

import {
  clampReviewToGate,
  CommitteeContext,
  CommitteeReview,
  validateCommitteeReview,
} from "../src/services/reasoning/types";

const validReview = (over?: Partial<CommitteeReview>): CommitteeReview => ({
  action: "WATCH",
  newEntryAction: "WATCH",
  existingHolderAction: "HOLD",
  confidence: 35,
  confidenceBand: "LOW",
  setupScore: 60,
  entryScore: 40,
  topPositiveFactors: ["order momentum"],
  topNegativeFactors: ["extended price"],
  missingCriticalEvidence: ["earnings growth"],
  invalidationConditions: ["trend break"],
  betterEntryConditions: ["pullback with improved reward/risk"],
  riskSummary: "high volatility",
  reasoningSummary: "evidence insufficient for entry",
  modelDisagreement: "setup strong vs forecast confidence LOW",
  dataTimestamp: "2026-09-08T00:00:00.000Z",
  ...over,
});

const ctx = (over?: Partial<CommitteeContext>): CommitteeContext => ({
  ticker: "BHEL.NS",
  timestamp: "2026-09-08T00:00:00.000Z",
  price: null,
  userContext: null,
  fundamentals: null,
  valuation: null,
  technicals: null,
  regime: null,
  events: null,
  forecast: null,
  calibration: { brier: 0.2533, brierSkill: -0.0033, bandCoveragePct: 85, calibrated: false },
  walkForwardPerformance: { directionHitRatePct: 79.5, rawSamples: 39 },
  effectiveSampleSize: 1,
  risk: null,
  expectedValue: null,
  dataQuality: null,
  gate: {
    newEntryAction: "WAIT",
    existingHolderAction: "HOLD",
    unmetGates: [],
    decisionPolicyVersion: "decision-policy-v3",
  },
  ...over,
});

describe("validateCommitteeReview — strict JSON schema", () => {
  test("accepts a fully valid review unchanged", () => {
    const r = validateCommitteeReview(validReview());
    expect(r.action).toBe("WATCH");
    expect(r.confidence).toBe(35);
  });

  test("rejects invalid action enums, out-of-range scores, wrong types", () => {
    expect(() => validateCommitteeReview(validReview({ action: "MOON" as never }))).toThrow(/action/);
    expect(() => validateCommitteeReview(validReview({ confidence: 140 }))).toThrow(/confidence/);
    expect(() => validateCommitteeReview(validReview({ confidenceBand: "SURE" as never }))).toThrow(/confidenceBand/);
    expect(() => validateCommitteeReview({ ...validReview(), topPositiveFactors: "not-an-array" })).toThrow(/string array/);
    expect(() => validateCommitteeReview(null)).toThrow(/not a JSON object/);
    expect(() => validateCommitteeReview("BUY")).toThrow(/not a JSON object/);
  });
});

describe("clampReviewToGate — cap-only authority (code, not prompt)", () => {
  test("committee BUY over a WAIT gate is lowered to WATCH, with the clamp recorded", () => {
    const { review, clamped, clampNotes } = clampReviewToGate(
      validReview({ action: "BUY", newEntryAction: "BUY", confidence: 80, confidenceBand: "HIGH" }),
      ctx()
    );
    expect(clamped).toBe(true);
    expect(review.newEntryAction).toBe("WATCH");
    expect(review.action).toBe("WATCH");
    expect(clampNotes.join(" ")).toMatch(/exceeded the TradeGate/);
  });

  test("HIGH confidence is impossible with Brier skill ≤ 0", () => {
    const { review, clampNotes } = clampReviewToGate(
      validReview({ confidenceBand: "HIGH", confidence: 85 }),
      ctx()
    );
    expect(review.confidenceBand).not.toBe("HIGH");
    expect(review.confidence).toBeLessThanOrEqual(60);
    expect(clampNotes.join(" ")).toMatch(/Brier skill/);
  });

  test("effective samples < 10 forces LOW confidence", () => {
    const { review } = clampReviewToGate(
      validReview({ confidenceBand: "MEDIUM", confidence: 55 }),
      ctx({ calibration: { brier: 0.2, brierSkill: 0.05, bandCoveragePct: 80, calibrated: true } })
    );
    expect(review.confidenceBand).toBe("LOW");
    expect(review.confidence).toBeLessThanOrEqual(40);
  });

  test("committee cannot push existing holders toward selling when the deterministic policy says HOLD", () => {
    const { review, clampNotes } = clampReviewToGate(validReview({ existingHolderAction: "REDUCE" }), ctx());
    expect(review.existingHolderAction).toBe("HOLD");
    expect(clampNotes.join(" ")).toMatch(/conflicts with the deterministic HOLD/);
  });

  test("a compliant review passes through unclamped", () => {
    const { clamped, clampNotes } = clampReviewToGate(validReview(), ctx());
    expect(clamped).toBe(false);
    expect(clampNotes).toHaveLength(0);
  });

  test("BUY is allowed only when the gate itself says BUY_CANDIDATE (and evidence supports confidence)", () => {
    const strongCtx = ctx({
      gate: { newEntryAction: "BUY_CANDIDATE", existingHolderAction: "HOLD", unmetGates: [], decisionPolicyVersion: "decision-policy-v3" },
      calibration: { brier: 0.2, brierSkill: 0.05, bandCoveragePct: 81, calibrated: true },
      effectiveSampleSize: 100,
    });
    const { review, clamped } = clampReviewToGate(
      validReview({ action: "BUY", newEntryAction: "BUY", confidence: 70, confidenceBand: "MEDIUM" }),
      strongCtx
    );
    expect(clamped).toBe(false);
    expect(review.newEntryAction).toBe("BUY");
  });
});
