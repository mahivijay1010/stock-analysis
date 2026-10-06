/**
 * DeepSeekProvider — the same reasoning/role surface as OpenAIProvider, served
 * by DeepSeek's OpenAI-compatible Chat Completions API. Selected with
 * AI_PROVIDER=deepseek (providerRegistry.ts).
 *
 * Every prompt, schema, validator and cap-only clamp is INHERITED from
 * OpenAIProvider; only the transport differs:
 *
 *  - DeepSeek rejects `response_format: json_schema` ("unavailable now",
 *    verified 2026-10-05), so this uses `json_object` mode and embeds the
 *    schema in the system prompt. That is a weaker guarantee at the
 *    transport, NOT at the boundary: the same server-side `validate()`
 *    still rejects any output that does not match, and a rejected output
 *    never becomes advice (deterministic decision unchanged).
 *  - Models are reasoning models: hidden reasoning tokens count against
 *    max_tokens, so the budget is larger, and a `length` stop is rejected
 *    rather than parsed (truncated JSON is not an answer).
 *
 * Model routing (env-overridable; ids verified against GET /models 2026-10-05):
 *   DEEPSEEK_EXTRACTION_MODEL (default deepseek-flash)
 *   DEEPSEEK_ANALYST_MODEL    (default deepseek-flash)
 *   DEEPSEEK_REASONING_MODEL  (default deepseek-v4-pro) — Forecast Critic / Risk Committee
 *
 * DEEPSEEK_API_KEY lives in server env only: never logged, never serialized,
 * never sent to the frontend.
 */

import OpenAI from "openai";
import { createHash } from "crypto";
import { strictSchema } from "./roles";
import { AiCallMeta, OpenAIProvider, RoleResult } from "./OpenAIProvider";

const TIMEOUT_MS = 120_000;
/** Reasoning tokens share this budget with the JSON answer. */
const MAX_TOKENS = 8000;

export class DeepSeekProvider extends OpenAIProvider {
  readonly name: string = "deepseek";
  private dsClient: OpenAI | null = null;

  private get dsKey(): string {
    return process.env.DEEPSEEK_API_KEY ?? "";
  }

  isAvailable(): boolean {
    return this.dsKey.length > 0;
  }

  models(): { extraction: string; analyst: string; reasoning: string } {
    return {
      extraction: process.env.DEEPSEEK_EXTRACTION_MODEL || "deepseek-flash",
      analyst: process.env.DEEPSEEK_ANALYST_MODEL || "deepseek-flash",
      reasoning: process.env.DEEPSEEK_REASONING_MODEL || "deepseek-v4-pro",
    };
  }

  private dsGetClient(): OpenAI {
    if (!this.isAvailable()) throw new Error("DeepSeek reasoning unavailable: DEEPSEEK_API_KEY is not configured.");
    if (!this.dsClient) {
      this.dsClient = new OpenAI({
        apiKey: this.dsKey,
        baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
        timeout: TIMEOUT_MS,
        maxRetries: 1,
      });
    }
    return this.dsClient;
  }

  async structured<T>(opts: {
    model: string;
    system: string;
    user: string;
    format: ReturnType<typeof strictSchema>;
    promptVersion: string;
    validate: (raw: unknown) => T;
  }): Promise<RoleResult<T>> {
    const client = this.dsGetClient();
    const started = Date.now();
    const inputHash = createHash("sha256")
      .update(opts.promptVersion)
      .update(opts.model)
      .update(opts.system)
      .update(opts.user)
      .digest("hex");

    const system =
      `${opts.system}\n\nOUTPUT FORMAT: reply with ONE json object and nothing else. It must validate against this JSON Schema ` +
      `(every property required, no extra properties, enums exact):\n${JSON.stringify(opts.format.schema)}`;

    const res = await client.chat.completions.create({
      model: opts.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: opts.user },
      ],
      max_tokens: MAX_TOKENS,
      response_format: { type: "json_object" },
    });

    const choice = res.choices?.[0];
    const meta: AiCallMeta = {
      provider: "deepseek",
      model: opts.model,
      modelSnapshot: res.model ?? null,
      promptVersion: opts.promptVersion,
      inputHash,
      responseId: res.id ?? null,
      latencyMs: Date.now() - started,
      tokensIn: res.usage?.prompt_tokens ?? null,
      tokensOut: res.usage?.completion_tokens ?? null,
      schemaVersion: opts.format.name,
      validationResult: "invalid",
      timestamp: new Date().toISOString(),
    };

    if (choice?.finish_reason === "length") throw Object.assign(new Error("DeepSeek output truncated (finish_reason=length)"), { meta });
    const text = choice?.message?.content;
    if (!text) throw Object.assign(new Error("DeepSeek returned no output text"), { meta });
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw Object.assign(new Error("DeepSeek output is not valid JSON"), { meta });
    }
    let data: T;
    try {
      data = opts.validate(parsed);
    } catch (e) {
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), { meta });
    }
    meta.validationResult = "valid";
    return { data, meta };
  }
}

export const deepseekProvider = new DeepSeekProvider();
