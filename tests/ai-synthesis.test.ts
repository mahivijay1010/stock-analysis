/**
 * O2/O3 tests — the DETERMINISTIC synthesis around the AI roles:
 * aiDisagreementScore (contradictions reduce confidence, never averaged away)
 * and the counterfactual engine (conditions derive from the gate, never
 * invented).
 */

import { computeAiDisagreement } from "../src/services/ai/disagreement";
import { deriveUpgradeConditions } from "../src/services/ai/counterfactuals";
import { FundamentalAnalysis, ForecastCritique, TechnicalSynthesis } from "../src/services/reasoning/roles";

const fundamental = (over?: Partial<FundamentalAnalysis>): FundamentalAnalysis => ({
  businessTrajectory: "IMPROVING",
  qualityAssessment: "STRONG",
  valuationAssessment: "FAIR",
  earningsQuality: 70,
  executionRisk: 40,
  topPositiveEvidence: [],
  topNegativeEvidence: [],
  missingEvidence: [],
  contradictions: [],
  citedEvidenceIds: [],
  summary: "",
  ...over,
});

const critic = (over?: Partial<ForecastCritique>): ForecastCritique => ({
  forecastUsable: true,
  confidence: "MEDIUM",
  primaryConcerns: [],
  modelDisagreement: "",
  distributionAssessment: "",
  calibrationAssessment: "",
  missingEvidence: [],
  recommendedActionCap: "WATCH",
  summary: "",
  ...over,
});

const technical = (over?: Partial<TechnicalSynthesis>): TechnicalSynthesis => ({
  longTermTrend: "BULLISH",
  mediumTermState: "UPTREND",
  shortTermState: "UPTREND",
  momentum: "STRONG",
  participation: "STRONG",
  volatilityCharacter: "NORMAL",
  location: "",
  overallState: "",
  entryImplication: "",
  citedEvidenceIds: [],
  ...over,
});

describe("computeAiDisagreement — contradictions raise the score", () => {
  test("aligned roles ⇒ 0", () => {
    const r = computeAiDisagreement({ fundamental: fundamental(), technical: technical(), critic: critic() });
    expect(r.score).toBe(0);
    expect(r.reasons).toHaveLength(0);
  });

  test("positive fundamentals vs unusable forecast ⇒ major disagreement", () => {
    const r = computeAiDisagreement({
      fundamental: fundamental(),
      critic: critic({ forecastUsable: false, confidence: "LOW" }),
    });
    expect(r.score).toBeGreaterThanOrEqual(30);
    expect(r.reasons[0]).toMatch(/Forecast Critic/);
  });

  test("quality company + weak entry + extreme valuation stack (BHEL pattern)", () => {
    const r = computeAiDisagreement({
      fundamental: fundamental({ valuationAssessment: "EXTREME" }),
      technical: technical({ shortTermState: "CONSOLIDATION", participation: "WEAK" }),
      critic: critic({ forecastUsable: false, confidence: "LOW" }),
    });
    expect(r.score).toBeGreaterThanOrEqual(70);
    expect(r.reasons.join(" ")).toMatch(/weak current entry/);
    expect(r.reasons.join(" ")).toMatch(/valuation/);
  });

  test("score is capped at 100", () => {
    const r = computeAiDisagreement({
      fundamental: fundamental({ valuationAssessment: "EXTREME", contradictions: ["a", "b", "c"] }),
      technical: technical({ shortTermState: "DISTRIBUTION", participation: "WEAK" }),
      critic: critic({ forecastUsable: false, confidence: "LOW" }),
    });
    expect(r.score).toBeLessThanOrEqual(100);
  });
});

describe("deriveUpgradeConditions — conditions come from the gate, dynamically", () => {
  test("maps unmet gates to condition ids and appends calibration/monitoring conditions", () => {
    const conditions = deriveUpgradeConditions({
      decisionStatus: "WAIT",
      unmetGates: [
        { gate: "directional edge", current: "79.5% over ~1 independent obs", required: "≥10 independent obs" },
        { gate: "entry quality", current: "35", required: "≥40" },
      ],
      inputs: {
        directionProbability: { status: "unavailable" },
        modelHealth: { overallState: "INSUFFICIENT_HISTORY" },
      },
    } as never);
    const ids = conditions.map((c) => c.conditionId);
    expect(ids).toContain("gate:directional-edge");
    expect(ids).toContain("gate:entry-quality");
    expect(ids).toContain("calibration:direction-probability");
    expect(ids).toContain("monitoring:live-history");
    const edge = conditions.find((c) => c.conditionId === "gate:directional-edge")!;
    expect(edge.category).toBe("evidence");
    expect(edge.required).toMatch(/independent obs/);
  });

  test("no unmet gates + calibrated probability ⇒ no conditions (nothing invented)", () => {
    const conditions = deriveUpgradeConditions({
      decisionStatus: "BUY_CANDIDATE",
      unmetGates: [],
      inputs: { directionProbability: { status: "calibrated" }, modelHealth: { overallState: "HEALTHY" } },
    } as never);
    expect(conditions).toHaveLength(0);
  });

  test("no arbitrary price targets ever appear", () => {
    const conditions = deriveUpgradeConditions({
      decisionStatus: "WAIT",
      unmetGates: [{ gate: "expected value", current: "-0.4% after costs", required: "> 0%" }],
      inputs: {},
    } as never);
    for (const c of conditions) {
      expect(c.required).not.toMatch(/₹\s*\d/);
      expect(c.conditionId).not.toMatch(/price-target/);
    }
  });
});
