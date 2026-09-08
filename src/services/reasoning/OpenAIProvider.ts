/**
 * OpenAIProvider (OpenAI-first upgrade, Part 1) — the primary reasoning
 * provider, built on the official OpenAI SDK + Responses API with STRICT
 * Structured Outputs.
 *
 * Model routing (all env-overridable, never hardcoded to a snapshot):
 *   OPENAI_EXTRACTION_MODEL (default gpt-5.6-luna)  — bulk extraction/classification
 *   OPENAI_ANALYST_MODEL    (default gpt-5.6-terra) — analytical synthesis roles
 *   OPENAI_REASONING_MODEL  (default gpt-5.6-sol)   — Forecast Critic / Risk Committee
 *
 * Hard rules enforced HERE, not just in prompts:
 *  - every response is schema-validated server-side; invalid ⇒ rejected +
 *    logged, deterministic decision unchanged (never coerced);
 *  - committee outputs pass through the SAME clampReviewToGate as Claude's —
 *    AI can lower, never raise;
 *  - OPENAI_API_KEY lives in server env only; it is never logged, never
 *    serialized into results, never sent to the frontend.
 */

import OpenAI from "openai";
import { createHash } from "crypto";
import {
  clampReviewToGate,
  CommitteeContext,
  CommitteeResult,
  COMMITTEE_PROMPT_VERSION,
  InvestmentReasoningProvider,
  validateCommitteeReview,
} from "./types";
import {
  COUNTERFACTUAL_SCHEMA,
  CRITIC_SCHEMA,
  CounterfactualExplanation,
  EVENT_ANALYSIS_SCHEMA,
  EventAnalysis,
  ForecastCritique,
  FUNDAMENTAL_SCHEMA,
  FundamentalAnalysis,
  MISSING_EVIDENCE_SCHEMA,
  ROLE_PROMPT_VERSION,
  strictSchema,
  TECHNICAL_SCHEMA,
  TechnicalSynthesis,
  validateCounterfactual,
  validateEventAnalysis,
  validateForecastCritique,
  validateFundamentalAnalysis,
  validateMissingEvidence,
  validateTechnicalSynthesis,
} from "./roles";

const TIMEOUT_MS = 90_000;
const MAX_OUTPUT_TOKENS = 3000;

/** Audit metadata attached to every structured call (Part 1 storage contract). */
export interface AiCallMeta {
  provider: "openai";
  model: string;
  modelSnapshot: string | null;
  promptVersion: string;
  inputHash: string;
  responseId: string | null;
  latencyMs: number;
  tokensIn: number | null;
  tokensOut: number | null;
  schemaVersion: string;
  validationResult: "valid" | "invalid";
  timestamp: string;
}

export interface RoleResult<T> {
  data: T;
  meta: AiCallMeta;
}

const COMMITTEE_SCHEMA = strictSchema("committee_review", {
  action: { type: "string", enum: ["BUY", "ACCUMULATE", "WATCH", "HOLD", "REDUCE", "AVOID", "INSUFFICIENT_DATA"] },
  newEntryAction: { type: "string", enum: ["BUY", "ACCUMULATE", "WATCH", "HOLD", "REDUCE", "AVOID", "INSUFFICIENT_DATA"] },
  existingHolderAction: { type: "string", enum: ["BUY", "ACCUMULATE", "WATCH", "HOLD", "REDUCE", "AVOID", "INSUFFICIENT_DATA"] },
  confidence: { type: "number" },
  confidenceBand: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
  setupScore: { type: "number" },
  entryScore: { type: "number" },
  topPositiveFactors: { type: "array", items: { type: "string" } },
  topNegativeFactors: { type: "array", items: { type: "string" } },
  missingCriticalEvidence: { type: "array", items: { type: "string" } },
  invalidationConditions: { type: "array", items: { type: "string" } },
  betterEntryConditions: { type: "array", items: { type: "string" } },
  riskSummary: { type: "string" },
  reasoningSummary: { type: "string" },
  modelDisagreement: { type: "string" },
  dataTimestamp: { type: "string" },
});

const SHARED_DISCIPLINE = `Non-negotiable discipline:
- You receive ONLY structured JSON computed by deterministic systems. Reason about THAT evidence.
- NEVER invent financial figures, prices, news, events, or probabilities. If evidence is absent, say so in missingEvidence.
- Historical bootstrap frequencies are NOT calibrated probabilities. Overlap-adjusted effective sample sizes are the real evidence counts.
- Insufficient evidence ⇒ prefer INSUFFICIENT_DATA / LOW confidence. "No trade" is a valid, respectable answer.
- Your output is advisory and CAP-ONLY: code clamps anything that would raise the deterministic gate's action.
- Cite evidence by the ids provided in the input where the schema asks for citedEvidenceIds.`;

export class OpenAIProvider implements InvestmentReasoningProvider {
  readonly name = "openai";
  private client: OpenAI | null = null;

  private get apiKey(): string {
    return process.env.OPENAI_API_KEY ?? "";
  }

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  /** Task-tier model routing (Part 1). All env-overridable. */
  models(): { extraction: string; analyst: string; reasoning: string } {
    return {
      extraction: process.env.OPENAI_EXTRACTION_MODEL || "gpt-5.6-luna",
      analyst: process.env.OPENAI_ANALYST_MODEL || "gpt-5.6-terra",
      reasoning: process.env.OPENAI_REASONING_MODEL || "gpt-5.6-sol",
    };
  }

  private getClient(): OpenAI {
    if (!this.isAvailable()) {
      throw new Error("OpenAI reasoning unavailable: OPENAI_API_KEY is not configured.");
    }
    if (!this.client) this.client = new OpenAI({ apiKey: this.apiKey, timeout: TIMEOUT_MS, maxRetries: 1 });
    return this.client;
  }

  /**
   * One structured call: Responses API + strict json_schema + server-side
   * revalidation. Throws on invalid output (after logging metadata) — the
   * caller keeps the deterministic decision unchanged.
   */
  async structured<T>(opts: {
    model: string;
    system: string;
    user: string;
    format: ReturnType<typeof strictSchema>;
    promptVersion: string;
    validate: (raw: unknown) => T;
  }): Promise<RoleResult<T>> {
    const client = this.getClient();
    const started = Date.now();
    const inputHash = createHash("sha256")
      .update(opts.promptVersion)
      .update(opts.model)
      .update(opts.system)
      .update(opts.user)
      .digest("hex");

    const res = await client.responses.create({
      model: opts.model,
      instructions: opts.system,
      input: [{ role: "user", content: opts.user }],
      max_output_tokens: MAX_OUTPUT_TOKENS,
      text: { format: opts.format as never },
    });

    const meta: AiCallMeta = {
      provider: "openai",
      model: opts.model,
      modelSnapshot: (res as { model?: string }).model ?? null,
      promptVersion: opts.promptVersion,
      inputHash,
      responseId: (res as { id?: string }).id ?? null,
      latencyMs: Date.now() - started,
      tokensIn: res.usage?.input_tokens ?? null,
      tokensOut: res.usage?.output_tokens ?? null,
      schemaVersion: opts.format.name,
      validationResult: "invalid",
      timestamp: new Date().toISOString(),
    };

    const text = res.output_text;
    if (!text) throw Object.assign(new Error("OpenAI returned no output text"), { meta });
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw Object.assign(new Error("OpenAI output is not valid JSON"), { meta });
    }
    let data: T;
    try {
      data = opts.validate(parsed);
    } catch (e) {
      // Validation failure is logged by the caller with this meta; the raw
      // output is discarded — malformed AI output never becomes advice.
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), { meta });
    }
    meta.validationResult = "valid";
    return { data, meta };
  }

  // ── InvestmentReasoningProvider (Risk Committee on the reasoning tier) ────

  private committeeSystem(): string {
    return `You are the independent Investment Risk Committee for StockSense (prompt ${COMMITTEE_PROMPT_VERSION}).
Your job is NOT to find reasons to buy. Determine whether the quantitative evidence justifies any action.
${SHARED_DISCIPLINE}
Confidence rules (code re-enforces them; violations only get clamped):
- Brier skill <= 0 ⇒ confidence cannot be HIGH.
- Inadequate effective sample size ⇒ confidence LOW.
- Missing fundamentals / very wide intervals / extended price ⇒ reduce confidence and entry score.
- The deterministic TradeGate verdict is a CEILING for new-entry actions, never a floor.
- confidence, setupScore and entryScore are INTEGERS on a 0-100 scale (e.g. 35 means 35/100 — never 0.35).
- dataTimestamp must be the timestamp from the input data.`;
  }

  private async committee(context: CommitteeContext, focus: string): Promise<CommitteeResult> {
    const { data, meta } = await this.structured({
      model: this.models().reasoning,
      system: this.committeeSystem(),
      user: `${focus}\n\nINPUT DATA (deterministic, structured):\n${JSON.stringify(context)}`,
      format: COMMITTEE_SCHEMA,
      promptVersion: COMMITTEE_PROMPT_VERSION,
      validate: validateCommitteeReview,
    });
    const { review, clamped, clampNotes } = clampReviewToGate(data, context);
    return {
      review,
      clamped,
      clampNotes,
      provider: this.name,
      modelName: meta.modelSnapshot ?? meta.model,
      promptVersion: COMMITTEE_PROMPT_VERSION,
      latencyMs: meta.latencyMs,
      inputHash: meta.inputHash,
      tokensIn: meta.tokensIn,
      tokensOut: meta.tokensOut,
    };
  }

  evaluateStock(context: CommitteeContext): Promise<CommitteeResult> {
    return this.committee(context, "Evaluate this stock for a prospective NEW investor (and separately for an existing holder).");
  }

  evaluateExistingPosition(context: CommitteeContext): Promise<CommitteeResult> {
    return this.committee(
      context,
      "The user HOLDS this position (context in userContext). Evaluate the EXISTING position first; also state the new-entry view."
    );
  }

  async explainDecision(context: CommitteeContext): Promise<string> {
    const { data } = await this.structured({
      model: this.models().analyst,
      system: `You explain a deterministic investment decision in plain language. ${SHARED_DISCIPLINE}`,
      user: `Explain WHY the gate decided "${context.gate.newEntryAction}" using only this input:\n${JSON.stringify(context)}`,
      format: strictSchema("decision_explanation", { explanation: { type: "string" } }),
      promptVersion: ROLE_PROMPT_VERSION,
      validate: (raw) => {
        const o = raw as Record<string, unknown>;
        if (typeof o?.explanation !== "string") throw new Error("decision explanation schema violation");
        return o.explanation as string;
      },
    });
    return data;
  }

  async identifyMissingEvidence(context: CommitteeContext): Promise<string[]> {
    const { data } = await this.structured({
      model: this.models().analyst,
      system: `You audit evidence completeness for an investment decision. ${SHARED_DISCIPLINE}`,
      user: `List the most decision-relevant MISSING evidence (not present or null in the input). Input:\n${JSON.stringify(context)}`,
      format: MISSING_EVIDENCE_SCHEMA,
      promptVersion: ROLE_PROMPT_VERSION,
      validate: validateMissingEvidence,
    });
    return data;
  }

  // ── Role methods (Parts 3/4/12/15/16) — evidence-graph payloads in, strict JSON out ──

  async analyzeFundamentals(evidenceJson: string): Promise<RoleResult<FundamentalAnalysis>> {
    return this.structured({
      model: this.models().analyst,
      system: `You are the Fundamental Analyst. Assess business trajectory, quality, valuation, earnings quality and execution risk STRICTLY from the sourced facts provided (each fact has an id + provenance). ${SHARED_DISCIPLINE}`,
      user: `FUNDAMENTAL EVIDENCE (deterministic, with provenance):\n${evidenceJson}`,
      format: FUNDAMENTAL_SCHEMA,
      promptVersion: ROLE_PROMPT_VERSION,
      validate: validateFundamentalAnalysis,
    });
  }

  async analyzeEvents(evidenceJson: string, knownEventIds: Set<string>): Promise<RoleResult<EventAnalysis>> {
    return this.structured({
      model: this.models().analyst,
      system: `You are the Event Analyst. INTERPRET the structured events provided (materiality, direction, horizon, novelty, already-priced probability). You may NOT invent events — every interpretation must reference a provided eventId. ${SHARED_DISCIPLINE}`,
      user: `STRUCTURED EVENTS (point-in-time, with source tiers):\n${evidenceJson}`,
      format: EVENT_ANALYSIS_SCHEMA,
      promptVersion: ROLE_PROMPT_VERSION,
      validate: (raw) => validateEventAnalysis(raw, knownEventIds),
    });
  }

  async analyzeTechnicalState(evidenceJson: string): Promise<RoleResult<TechnicalSynthesis>> {
    return this.structured({
      model: this.models().analyst,
      system: `You are the Technical/Regime Analyst. Synthesize the deterministic indicators into trend/momentum/participation/volatility/location states. Derive ONLY from the provided indicators; never from imagined price action. ${SHARED_DISCIPLINE}`,
      user: `TECHNICAL + REGIME EVIDENCE:\n${evidenceJson}`,
      format: TECHNICAL_SCHEMA,
      promptVersion: ROLE_PROMPT_VERSION,
      validate: validateTechnicalSynthesis,
    });
  }

  async critiqueForecast(evidenceJson: string): Promise<RoleResult<ForecastCritique>> {
    return this.structured({
      model: this.models().reasoning,
      system: `You are the Forecast Critic. You NEVER produce a forecast. Judge whether the supplied model forecasts are USABLE given calibration, effective samples, model health, disagreement, drift, regime and data quality. Your recommendedActionCap may only LOWER the deterministic action — code enforces this. ${SHARED_DISCIPLINE}`,
      user: `FORECAST EVIDENCE:\n${evidenceJson}`,
      format: CRITIC_SCHEMA,
      promptVersion: ROLE_PROMPT_VERSION,
      validate: validateForecastCritique,
    });
  }

  async generateCounterfactualConditions(
    conditionsJson: string,
    knownConditionIds: Set<string>
  ): Promise<RoleResult<CounterfactualExplanation>> {
    return this.structured({
      model: this.models().analyst,
      system: `You explain DETERMINISTIC upgrade conditions ("what would make this a BUY") in plain language. The conditions were computed by the TradeGate — you may only explain the provided conditionIds, never invent thresholds or price targets. ${SHARED_DISCIPLINE}`,
      user: `DETERMINISTIC UPGRADE CONDITIONS:\n${conditionsJson}`,
      format: COUNTERFACTUAL_SCHEMA,
      promptVersion: ROLE_PROMPT_VERSION,
      validate: (raw) => validateCounterfactual(raw, knownConditionIds),
    });
  }

  /** Bulk extraction/classification on the cheap tier (Part 24 stage 2). */
  async extract<T>(opts: {
    system: string;
    user: string;
    format: ReturnType<typeof strictSchema>;
    validate: (raw: unknown) => T;
  }): Promise<RoleResult<T>> {
    return this.structured({
      model: this.models().extraction,
      system: `${opts.system}\nExtract ONLY what is present in the input. Missing ⇒ null. Never guess.`,
      user: opts.user,
      format: opts.format,
      promptVersion: ROLE_PROMPT_VERSION,
      validate: opts.validate,
    });
  }
}

export const openaiProvider = new OpenAIProvider();
