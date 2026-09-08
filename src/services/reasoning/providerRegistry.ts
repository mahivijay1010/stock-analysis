/**
 * Provider registry (Part 1) — AI_PROVIDER routing over the preserved
 * InvestmentReasoningProvider abstraction.
 *
 *   AI_PROVIDER=openai  ⇒ OpenAIProvider (PRIMARY)
 *   AI_PROVIDER=claude  ⇒ ClaudeProvider (optional, kept intact)
 *   unset               ⇒ openai if OPENAI_API_KEY present, else claude if
 *                         ANTHROPIC_API_KEY present, else openai (which will
 *                         report itself unavailable — honest 503 downstream).
 *
 * The abstraction is NOT deleted because OpenAI is currently preferred; new
 * providers (e.g. DeepSeek) plug in here.
 */

import { InvestmentReasoningProvider } from "./types";
import { claudeProvider } from "./ClaudeProvider";
import { openaiProvider, OpenAIProvider } from "./OpenAIProvider";

const REGISTRY: Record<string, InvestmentReasoningProvider> = {
  openai: openaiProvider,
  claude: claudeProvider,
};

export function resolveProvider(): InvestmentReasoningProvider {
  const requested = (process.env.AI_PROVIDER ?? "").trim().toLowerCase();
  if (requested && REGISTRY[requested]) return REGISTRY[requested];
  if (requested && !REGISTRY[requested]) {
    // Unknown value: fail toward the default chain rather than crashing —
    // reasoning is optional; the deterministic system never depends on it.
    console.warn(`[reasoning] unknown AI_PROVIDER "${requested}" — falling back to default chain`);
  }
  if ((process.env.OPENAI_API_KEY ?? "").length > 0) return openaiProvider;
  if ((process.env.ANTHROPIC_API_KEY ?? "").length > 0) return claudeProvider;
  return openaiProvider;
}

/** The OpenAI provider regardless of committee routing — role analysts (Parts 3/4/12/15/16) are OpenAI-only. */
export function getOpenAIProvider(): OpenAIProvider {
  return openaiProvider;
}
