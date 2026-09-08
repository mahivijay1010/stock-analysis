/**
 * ClaudeProvider (risk-spec Rule 13 + "AI API DESIGN") — the Claude-backed
 * InvestmentReasoningProvider. Plain HTTPS to the Anthropic Messages API (no
 * SDK dependency); ANTHROPIC_API_KEY absent ⇒ isAvailable() false and the
 * product shows "committee unavailable" instead of pretending.
 *
 * The committee NEVER generates price forecasts from imagination: it receives
 * the deterministic systems' structured JSON and must reason about evidence
 * sufficiency. Its output is schema-validated and then CAP-CLAMPED in code
 * (types.ts) — the prompt asks for discipline; the code guarantees it.
 */

import { createHash } from "crypto";
import {
  clampReviewToGate,
  CommitteeContext,
  CommitteeResult,
  COMMITTEE_PROMPT_VERSION,
  InvestmentReasoningProvider,
  validateCommitteeReview,
} from "./types";

const DEFAULT_MODEL = "claude-sonnet-5";
const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 2000;
const TIMEOUT_MS = 60_000;

const SYSTEM_PROMPT = `You are the independent Investment Risk Committee for StockSense (prompt ${COMMITTEE_PROMPT_VERSION}).

Your job is NOT to find reasons to buy a stock. Your job is to determine whether the quantitative evidence is strong enough to justify an investment action. You receive structured data calculated by deterministic systems.

You MUST NOT:
- invent financial figures, news, or probabilities
- treat setupScore as confidence
- treat historical bootstrap frequencies as calibrated probabilities
- ignore missing data or poor backtesting
- recommend BUY simply because momentum is positive

Evaluate: business, valuation, trend, entry quality, regime, forecast distribution, calibration, sample quality (overlap-adjusted effective sample size), expected value after costs, data quality, model disagreement, and position context (a new investor and an existing holder need SEPARATE recommendations).

Confidence rules (the caller also enforces these in code — violating them only gets your output clamped):
- Brier skill <= 0: confidence cannot be HIGH.
- Inadequate effective sample size: confidence must be LOW.
- Missing major fundamentals, very wide intervals, or extended price: reduce confidence / entry score.
- Insufficient evidence: choose WATCH or INSUFFICIENT_DATA. NO TRADE is a valid answer.
- The deterministic TradeGate's verdict is a CEILING for new-entry actions, never a floor.

Respond ONLY with a single valid JSON object, no markdown fences, matching EXACTLY:
{
  "action": "BUY|ACCUMULATE|WATCH|HOLD|REDUCE|AVOID|INSUFFICIENT_DATA",
  "newEntryAction": "same enum",
  "existingHolderAction": "same enum",
  "confidence": 0-100,
  "confidenceBand": "LOW|MEDIUM|HIGH",
  "setupScore": 0-100,
  "entryScore": 0-100,
  "topPositiveFactors": ["..."],
  "topNegativeFactors": ["..."],
  "missingCriticalEvidence": ["..."],
  "invalidationConditions": ["..."],
  "betterEntryConditions": ["..."],
  "riskSummary": "...",
  "reasoningSummary": "...",
  "modelDisagreement": "...",
  "dataTimestamp": "ISO timestamp of the input data"
}`;

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
}

export class ClaudeProvider implements InvestmentReasoningProvider {
  readonly name = "claude";
  private readonly apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  private readonly model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  private async call(userText: string): Promise<{ text: string; latencyMs: number; tokensIn: number | null; tokensOut: number | null }> {
    if (!this.isAvailable()) {
      throw new Error("Claude committee unavailable: ANTHROPIC_API_KEY is not configured.");
    }
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userText }],
        }),
      });
      const body = (await res.json()) as AnthropicResponse;
      if (!res.ok) {
        throw new Error(`Anthropic API ${res.status}: ${body.error?.message ?? "unknown error"}`);
      }
      const text = (body.content ?? [])
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("");
      if (!text) throw new Error("Anthropic API returned no text content");
      return {
        text,
        latencyMs: Date.now() - started,
        tokensIn: body.usage?.input_tokens ?? null,
        tokensOut: body.usage?.output_tokens ?? null,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async evaluate(context: CommitteeContext, focus: string): Promise<CommitteeResult> {
    const inputJson = JSON.stringify(context);
    const inputHash = createHash("sha256").update(COMMITTEE_PROMPT_VERSION).update(inputJson).digest("hex");
    const { text, latencyMs, tokensIn, tokensOut } = await this.call(
      `${focus}\n\nSTRUCTURED INPUT (deterministic systems' output — the only facts you may use):\n${inputJson}`
    );
    // Strict parse: the response must BE the JSON object (tolerate stray fences).
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error("committee response was not valid JSON — refused (never coerced into advice)");
    }
    const review = validateCommitteeReview(parsed);
    const { review: clampedReview, clamped, clampNotes } = clampReviewToGate(review, context);
    return {
      review: clampedReview,
      clamped,
      clampNotes,
      provider: this.name,
      modelName: this.model,
      promptVersion: COMMITTEE_PROMPT_VERSION,
      latencyMs,
      inputHash,
      tokensIn,
      tokensOut,
    };
  }

  evaluateStock(context: CommitteeContext): Promise<CommitteeResult> {
    return this.evaluate(context, "Evaluate this stock for a prospective NEW investor (and separately for an existing holder).");
  }

  evaluateExistingPosition(context: CommitteeContext): Promise<CommitteeResult> {
    return this.evaluate(
      context,
      "Evaluate the EXISTING POSITION described in userContext. The holder decision is primary; still fill the new-entry fields honestly."
    );
  }

  async explainDecision(context: CommitteeContext): Promise<string> {
    const r = await this.evaluateStock(context);
    return r.review.reasoningSummary;
  }

  async identifyMissingEvidence(context: CommitteeContext): Promise<string[]> {
    const r = await this.evaluateStock(context);
    return r.review.missingCriticalEvidence;
  }
}

export const claudeProvider = new ClaudeProvider();
