/**
 * AI role contracts (OpenAI-first upgrade, Parts 3/4/12/13/16) — the strict
 * output shapes for every reasoning role, their OpenAI json_schema documents,
 * and server-side validators.
 *
 * Two layers of enforcement, by design:
 *  1. the OpenAI Responses API is asked for `json_schema, strict: true`;
 *  2. every response is REVALIDATED here before it can touch application
 *     state. A response failing validation is rejected and logged — never
 *     coerced into advice. The deterministic decision is unaffected.
 */

export const ROLE_PROMPT_VERSION = "roles-v1";

// ── shared helpers ───────────────────────────────────────────────────────────

/** Build a strict OpenAI json_schema object (all fields required, no extras). */
export function strictSchema(
  name: string,
  properties: Record<string, unknown>
): { type: "json_schema"; name: string; strict: true; schema: Record<string, unknown> } {
  return {
    type: "json_schema",
    name,
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties,
      required: Object.keys(properties),
    },
  };
}

const nullableNumber = { type: ["number", "null"] };
const stringArray = { type: "array", items: { type: "string" } };

function fail(role: string, msg: string): never {
  throw new Error(`${role} output schema violation: ${msg}`);
}

function reqString(role: string, o: Record<string, unknown>, f: string): string {
  const v = o[f];
  if (typeof v !== "string") fail(role, `"${f}" must be a string`);
  return v as string;
}

function reqEnum<T extends string>(role: string, o: Record<string, unknown>, f: string, allowed: readonly T[]): T {
  const v = o[f];
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    fail(role, `"${f}" must be one of ${allowed.join("|")}, got ${JSON.stringify(v)}`);
  }
  return v as T;
}

function reqStrArr(role: string, o: Record<string, unknown>, f: string, maxLen = 12): string[] {
  const v = o[f];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) fail(role, `"${f}" must be a string array`);
  return (v as string[]).slice(0, maxLen);
}

function nullableScore(role: string, o: Record<string, unknown>, f: string): number | null {
  const v = o[f];
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) {
    fail(role, `"${f}" must be null or a number 0-100, got ${JSON.stringify(v)}`);
  }
  return v as number;
}

function obj(role: string, raw: unknown): Record<string, unknown> {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) fail(role, "output is not a JSON object");
  return raw as Record<string, unknown>;
}

// ── Role A: Fundamental Analyst (Part 3) ─────────────────────────────────────

export const TRAJECTORIES = ["IMPROVING", "STABLE", "DETERIORATING", "INSUFFICIENT_DATA"] as const;
export const QUALITY_BANDS = ["STRONG", "MODERATE", "WEAK", "INSUFFICIENT_DATA"] as const;
export const VALUATION_BANDS = ["CHEAP", "FAIR", "EXPENSIVE", "EXTREME", "INSUFFICIENT_DATA"] as const;

export interface FundamentalAnalysis {
  businessTrajectory: (typeof TRAJECTORIES)[number];
  qualityAssessment: (typeof QUALITY_BANDS)[number];
  valuationAssessment: (typeof VALUATION_BANDS)[number];
  earningsQuality: number | null;
  executionRisk: number | null;
  topPositiveEvidence: string[];
  topNegativeEvidence: string[];
  missingEvidence: string[];
  contradictions: string[];
  citedEvidenceIds: string[];
  summary: string;
}

export const FUNDAMENTAL_SCHEMA = strictSchema("fundamental_analysis", {
  businessTrajectory: { type: "string", enum: [...TRAJECTORIES] },
  qualityAssessment: { type: "string", enum: [...QUALITY_BANDS] },
  valuationAssessment: { type: "string", enum: [...VALUATION_BANDS] },
  earningsQuality: nullableNumber,
  executionRisk: nullableNumber,
  topPositiveEvidence: stringArray,
  topNegativeEvidence: stringArray,
  missingEvidence: stringArray,
  contradictions: stringArray,
  citedEvidenceIds: stringArray,
  summary: { type: "string" },
});

export function validateFundamentalAnalysis(raw: unknown): FundamentalAnalysis {
  const R = "fundamental analyst";
  const o = obj(R, raw);
  return {
    businessTrajectory: reqEnum(R, o, "businessTrajectory", TRAJECTORIES),
    qualityAssessment: reqEnum(R, o, "qualityAssessment", QUALITY_BANDS),
    valuationAssessment: reqEnum(R, o, "valuationAssessment", VALUATION_BANDS),
    earningsQuality: nullableScore(R, o, "earningsQuality"),
    executionRisk: nullableScore(R, o, "executionRisk"),
    topPositiveEvidence: reqStrArr(R, o, "topPositiveEvidence"),
    topNegativeEvidence: reqStrArr(R, o, "topNegativeEvidence"),
    missingEvidence: reqStrArr(R, o, "missingEvidence"),
    contradictions: reqStrArr(R, o, "contradictions"),
    citedEvidenceIds: reqStrArr(R, o, "citedEvidenceIds", 40),
    summary: reqString(R, o, "summary"),
  };
}

// ── Role B: Event Analyst (Part 4 interpretation — extraction never invents) ─

export const EVENT_DIRECTIONS = ["POSITIVE", "NEGATIVE", "MIXED", "NEUTRAL", "UNCLEAR"] as const;
export const MATERIALITY = ["HIGH", "MEDIUM", "LOW", "NONE"] as const;
export const TIME_HORIZONS = ["IMMEDIATE", "WEEKS", "MONTHS", "QUARTERS", "YEARS", "UNCLEAR"] as const;

export interface EventInterpretation {
  eventId: string;
  materiality: (typeof MATERIALITY)[number];
  direction: (typeof EVENT_DIRECTIONS)[number];
  confidence: number | null;
  timeHorizon: (typeof TIME_HORIZONS)[number];
  novelty: number | null;
  alreadyPricedProbability: number | null;
  explanation: string;
}

export interface EventAnalysis {
  interpretations: EventInterpretation[];
  overallEventRisk: (typeof MATERIALITY)[number];
  missingEvidence: string[];
  summary: string;
}

export const EVENT_ANALYSIS_SCHEMA = strictSchema("event_analysis", {
  interpretations: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        eventId: { type: "string" },
        materiality: { type: "string", enum: [...MATERIALITY] },
        direction: { type: "string", enum: [...EVENT_DIRECTIONS] },
        confidence: nullableNumber,
        timeHorizon: { type: "string", enum: [...TIME_HORIZONS] },
        novelty: nullableNumber,
        alreadyPricedProbability: nullableNumber,
        explanation: { type: "string" },
      },
      required: [
        "eventId",
        "materiality",
        "direction",
        "confidence",
        "timeHorizon",
        "novelty",
        "alreadyPricedProbability",
        "explanation",
      ],
    },
  },
  overallEventRisk: { type: "string", enum: [...MATERIALITY] },
  missingEvidence: stringArray,
  summary: { type: "string" },
});

export function validateEventAnalysis(raw: unknown, knownEventIds: Set<string>): EventAnalysis {
  const R = "event analyst";
  const o = obj(R, raw);
  const arr = o.interpretations;
  if (!Array.isArray(arr)) fail(R, `"interpretations" must be an array`);
  const interpretations = (arr as unknown[]).map((item) => {
    const e = obj(R, item);
    const eventId = reqString(R, e, "eventId");
    // Anti-hallucination: an interpretation may only reference events we sent.
    if (!knownEventIds.has(eventId)) fail(R, `interpretation references unknown eventId "${eventId}" (hallucinated event)`);
    const prob = e.alreadyPricedProbability;
    if (prob !== null && (typeof prob !== "number" || prob < 0 || prob > 1)) {
      fail(R, `"alreadyPricedProbability" must be null or 0..1`);
    }
    return {
      eventId,
      materiality: reqEnum(R, e, "materiality", MATERIALITY),
      direction: reqEnum(R, e, "direction", EVENT_DIRECTIONS),
      confidence: nullableScore(R, e, "confidence"),
      timeHorizon: reqEnum(R, e, "timeHorizon", TIME_HORIZONS),
      novelty: nullableScore(R, e, "novelty"),
      alreadyPricedProbability: prob as number | null,
      explanation: reqString(R, e, "explanation"),
    };
  });
  return {
    interpretations,
    overallEventRisk: reqEnum(R, o, "overallEventRisk", MATERIALITY),
    missingEvidence: reqStrArr(R, o, "missingEvidence"),
    summary: reqString(R, o, "summary"),
  };
}

// ── Role C: Technical / Regime state synthesis (Part 16) ────────────────────

export const TREND_STATES = ["BULLISH", "BEARISH", "SIDEWAYS", "INSUFFICIENT_DATA"] as const;
export const SHORT_STATES = [
  "BREAKOUT",
  "UPTREND",
  "CONSOLIDATION",
  "PULLBACK",
  "DISTRIBUTION",
  "DOWNTREND",
  "BASING",
  "INSUFFICIENT_DATA",
] as const;
export const STRENGTH_BANDS = ["STRONG", "NEUTRAL", "WEAK", "INSUFFICIENT_DATA"] as const;

export interface TechnicalSynthesis {
  longTermTrend: (typeof TREND_STATES)[number];
  mediumTermState: (typeof SHORT_STATES)[number];
  shortTermState: (typeof SHORT_STATES)[number];
  momentum: (typeof STRENGTH_BANDS)[number];
  participation: (typeof STRENGTH_BANDS)[number];
  volatilityCharacter: "LOW" | "NORMAL" | "HIGH" | "EXTREME" | "INSUFFICIENT_DATA";
  location: string;
  overallState: string;
  entryImplication: string;
  citedEvidenceIds: string[];
}

export const TECHNICAL_SCHEMA = strictSchema("technical_synthesis", {
  longTermTrend: { type: "string", enum: [...TREND_STATES] },
  mediumTermState: { type: "string", enum: [...SHORT_STATES] },
  shortTermState: { type: "string", enum: [...SHORT_STATES] },
  momentum: { type: "string", enum: [...STRENGTH_BANDS] },
  participation: { type: "string", enum: [...STRENGTH_BANDS] },
  volatilityCharacter: { type: "string", enum: ["LOW", "NORMAL", "HIGH", "EXTREME", "INSUFFICIENT_DATA"] },
  location: { type: "string" },
  overallState: { type: "string" },
  entryImplication: { type: "string" },
  citedEvidenceIds: stringArray,
});

export function validateTechnicalSynthesis(raw: unknown): TechnicalSynthesis {
  const R = "technical analyst";
  const o = obj(R, raw);
  return {
    longTermTrend: reqEnum(R, o, "longTermTrend", TREND_STATES),
    mediumTermState: reqEnum(R, o, "mediumTermState", SHORT_STATES),
    shortTermState: reqEnum(R, o, "shortTermState", SHORT_STATES),
    momentum: reqEnum(R, o, "momentum", STRENGTH_BANDS),
    participation: reqEnum(R, o, "participation", STRENGTH_BANDS),
    volatilityCharacter: reqEnum(R, o, "volatilityCharacter", ["LOW", "NORMAL", "HIGH", "EXTREME", "INSUFFICIENT_DATA"] as const),
    location: reqString(R, o, "location"),
    overallState: reqString(R, o, "overallState"),
    entryImplication: reqString(R, o, "entryImplication"),
    citedEvidenceIds: reqStrArr(R, o, "citedEvidenceIds", 40),
  };
}

// ── Role D: Forecast Critic (Part 12) — cap-only by contract ────────────────

export const CRITIC_CAPS = ["BUY", "ACCUMULATE", "WATCH", "AVOID", "INSUFFICIENT_DATA"] as const;

export interface ForecastCritique {
  forecastUsable: boolean;
  confidence: "LOW" | "MEDIUM" | "HIGH";
  primaryConcerns: string[];
  modelDisagreement: string;
  distributionAssessment: string;
  calibrationAssessment: string;
  missingEvidence: string[];
  recommendedActionCap: (typeof CRITIC_CAPS)[number];
  summary: string;
}

export const CRITIC_SCHEMA = strictSchema("forecast_critique", {
  forecastUsable: { type: "boolean" },
  confidence: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
  primaryConcerns: stringArray,
  modelDisagreement: { type: "string" },
  distributionAssessment: { type: "string" },
  calibrationAssessment: { type: "string" },
  missingEvidence: stringArray,
  recommendedActionCap: { type: "string", enum: [...CRITIC_CAPS] },
  summary: { type: "string" },
});

export function validateForecastCritique(raw: unknown): ForecastCritique {
  const R = "forecast critic";
  const o = obj(R, raw);
  if (typeof o.forecastUsable !== "boolean") fail(R, `"forecastUsable" must be a boolean`);
  return {
    forecastUsable: o.forecastUsable as boolean,
    confidence: reqEnum(R, o, "confidence", ["LOW", "MEDIUM", "HIGH"] as const),
    primaryConcerns: reqStrArr(R, o, "primaryConcerns"),
    modelDisagreement: reqString(R, o, "modelDisagreement"),
    distributionAssessment: reqString(R, o, "distributionAssessment"),
    calibrationAssessment: reqString(R, o, "calibrationAssessment"),
    missingEvidence: reqStrArr(R, o, "missingEvidence"),
    recommendedActionCap: reqEnum(R, o, "recommendedActionCap", CRITIC_CAPS),
    summary: reqString(R, o, "summary"),
  };
}

// ── Counterfactual explanation (Part 15 — conditions come from the GATE) ────

export interface CounterfactualExplanation {
  /** One plain-language line per DETERMINISTIC condition supplied to the model. */
  conditions: Array<{ conditionId: string; explanation: string }>;
  summary: string;
}

export const COUNTERFACTUAL_SCHEMA = strictSchema("counterfactual_explanation", {
  conditions: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      properties: { conditionId: { type: "string" }, explanation: { type: "string" } },
      required: ["conditionId", "explanation"],
    },
  },
  summary: { type: "string" },
});

export function validateCounterfactual(raw: unknown, knownConditionIds: Set<string>): CounterfactualExplanation {
  const R = "counterfactual engine";
  const o = obj(R, raw);
  const arr = o.conditions;
  if (!Array.isArray(arr)) fail(R, `"conditions" must be an array`);
  const conditions = (arr as unknown[]).map((item) => {
    const c = obj(R, item);
    const conditionId = reqString(R, c, "conditionId");
    if (!knownConditionIds.has(conditionId)) {
      fail(R, `references unknown conditionId "${conditionId}" (invented condition)`);
    }
    return { conditionId, explanation: reqString(R, c, "explanation") };
  });
  return { conditions, summary: reqString(R, o, "summary") };
}

// ── Missing-evidence sweep (shared) ─────────────────────────────────────────

export const MISSING_EVIDENCE_SCHEMA = strictSchema("missing_evidence", {
  missingEvidence: stringArray,
});

export function validateMissingEvidence(raw: unknown): string[] {
  const R = "missing-evidence sweep";
  const o = obj(R, raw);
  return reqStrArr(R, o, "missingEvidence", 20);
}
