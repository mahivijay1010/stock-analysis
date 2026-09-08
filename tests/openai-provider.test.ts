/**
 * O1 tests — provider routing, availability, and the strict role validators
 * that stand between OpenAI output and application state. No network calls:
 * validators are pure; routing is env-driven.
 */

import { OpenAIProvider } from "../src/services/reasoning/OpenAIProvider";
import { resolveProvider } from "../src/services/reasoning/providerRegistry";
import {
  validateCounterfactual,
  validateEventAnalysis,
  validateForecastCritique,
  validateFundamentalAnalysis,
  validateTechnicalSynthesis,
} from "../src/services/reasoning/roles";

const ENV_KEYS = ["AI_PROVIDER", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("provider routing (AI_PROVIDER)", () => {
  test("AI_PROVIDER=openai selects OpenAI", () => {
    process.env.AI_PROVIDER = "openai";
    expect(resolveProvider().name).toBe("openai");
  });

  test("AI_PROVIDER=claude keeps the Claude provider available", () => {
    process.env.AI_PROVIDER = "claude";
    expect(resolveProvider().name).toBe("claude");
  });

  test("unset: prefers OpenAI when OPENAI_API_KEY exists", () => {
    delete process.env.AI_PROVIDER;
    process.env.OPENAI_API_KEY = "sk-test";
    expect(resolveProvider().name).toBe("openai");
  });

  test("unset: falls back to Claude when only ANTHROPIC_API_KEY exists", () => {
    delete process.env.AI_PROVIDER;
    delete process.env.OPENAI_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(resolveProvider().name).toBe("claude");
  });

  test("no keys at all: provider reports unavailable (honest 503 downstream, never a default BUY)", () => {
    delete process.env.AI_PROVIDER;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    expect(resolveProvider().isAvailable()).toBe(false);
  });
});

describe("OpenAIProvider availability + model routing", () => {
  test("isAvailable false without OPENAI_API_KEY; structured() refuses to call", async () => {
    delete process.env.OPENAI_API_KEY;
    const p = new OpenAIProvider();
    expect(p.isAvailable()).toBe(false);
    await expect(
      p.explainDecision({ gate: { newEntryAction: "WAIT" } } as never)
    ).rejects.toThrow(/OPENAI_API_KEY is not configured/);
  });

  test("model tiers come from env with the documented defaults", () => {
    delete process.env.OPENAI_EXTRACTION_MODEL;
    delete process.env.OPENAI_ANALYST_MODEL;
    delete process.env.OPENAI_REASONING_MODEL;
    const p = new OpenAIProvider();
    expect(p.models()).toEqual({ extraction: "gpt-5.6-luna", analyst: "gpt-5.6-terra", reasoning: "gpt-5.6-sol" });
    process.env.OPENAI_REASONING_MODEL = "gpt-5.2";
    expect(p.models().reasoning).toBe("gpt-5.2");
    delete process.env.OPENAI_REASONING_MODEL;
  });
});

describe("role validators — malformed AI output is rejected, never coerced", () => {
  const goodFundamental = {
    businessTrajectory: "IMPROVING",
    qualityAssessment: "MODERATE",
    valuationAssessment: "EXPENSIVE",
    earningsQuality: 62,
    executionRisk: 55,
    topPositiveEvidence: ["rev growth"],
    topNegativeEvidence: ["valuation"],
    missingEvidence: ["order book"],
    contradictions: [],
    citedEvidenceIds: ["fund:revenue"],
    summary: "ok",
  };

  test("fundamental: valid passes, bad enum rejected, out-of-range score rejected", () => {
    expect(validateFundamentalAnalysis(goodFundamental).businessTrajectory).toBe("IMPROVING");
    expect(() => validateFundamentalAnalysis({ ...goodFundamental, businessTrajectory: "TO_THE_MOON" })).toThrow(/schema violation/);
    expect(() => validateFundamentalAnalysis({ ...goodFundamental, earningsQuality: 140 })).toThrow(/0-100/);
  });

  test("event analyst: interpretation of an UNKNOWN eventId is a hallucination and is rejected", () => {
    const known = new Set(["evt-1"]);
    const base = {
      interpretations: [
        {
          eventId: "evt-1",
          materiality: "HIGH",
          direction: "POSITIVE",
          confidence: 70,
          timeHorizon: "MONTHS",
          novelty: 60,
          alreadyPricedProbability: 0.4,
          explanation: "order win vs revenue",
        },
      ],
      overallEventRisk: "MEDIUM",
      missingEvidence: [],
      summary: "ok",
    };
    expect(validateEventAnalysis(base, known).interpretations).toHaveLength(1);
    const hallucinated = { ...base, interpretations: [{ ...base.interpretations[0], eventId: "evt-999" }] };
    expect(() => validateEventAnalysis(hallucinated, known)).toThrow(/hallucinated event/);
  });

  test("forecast critic: valid passes; missing boolean rejected", () => {
    const good = {
      forecastUsable: false,
      confidence: "LOW",
      primaryConcerns: ["no calibrated probability"],
      modelDisagreement: "champion vs baselines: none beat baselines",
      distributionAssessment: "bands usable",
      calibrationAssessment: "30d refused",
      missingEvidence: [],
      recommendedActionCap: "WATCH",
      summary: "not usable directionally",
    };
    expect(validateForecastCritique(good).recommendedActionCap).toBe("WATCH");
    expect(() => validateForecastCritique({ ...good, forecastUsable: "yes" })).toThrow(/boolean/);
  });

  test("counterfactual: invented conditionId rejected — conditions are deterministic", () => {
    const known = new Set(["gate:entry-quality"]);
    const good = { conditions: [{ conditionId: "gate:entry-quality", explanation: "entry must improve" }], summary: "s" };
    expect(validateCounterfactual(good, known).conditions).toHaveLength(1);
    const invented = { conditions: [{ conditionId: "gate:price-target-999", explanation: "x" }], summary: "s" };
    expect(() => validateCounterfactual(invented, known)).toThrow(/invented condition/);
  });

  test("technical synthesis: enums enforced", () => {
    const good = {
      longTermTrend: "BULLISH",
      mediumTermState: "CONSOLIDATION",
      shortTermState: "PULLBACK",
      momentum: "NEUTRAL",
      participation: "WEAK",
      volatilityCharacter: "HIGH",
      location: "above SMA50/200, near SMA20",
      overallState: "consolidation within long-term uptrend",
      entryImplication: "not a confirmed breakout",
      citedEvidenceIds: ["tech:sma50"],
    };
    expect(validateTechnicalSynthesis(good).overallState).toMatch(/consolidation/);
    expect(() => validateTechnicalSynthesis({ ...good, momentum: "AMAZING" })).toThrow(/schema violation/);
  });
});
