/**
 * ShortTermRiskCritic (Part 28) — cap-only AI risk review, FREE-FIRST.
 *
 * A deterministic LOCAL critic is always produced (from the contradictions,
 * tier and EV evidence already computed). It may escalate to luna for
 * shortlisted candidates or sol on explicit Deep Review, under the
 * AiCostGovernor. The critic's `actionCap` can only LOWER the deterministic
 * ceiling passed in — never raise it (enforced in code).
 */

import { createHash } from "crypto";
import { AppDataSource } from "../../config/database";
import { AiReview } from "../../entities";
import { getOpenAIProvider } from "../reasoning/providerRegistry";
import { strictSchema } from "../reasoning/roles";
import { actionRank, capAction, ShortTermActionV2 } from "./actionStates";
import { aiCostGovernor } from "./aiAnalyst";
import { Contradiction } from "./contradictions";

const CRITIC_CAPS: ShortTermActionV2[] = ["NO_TRADE", "RESEARCH_WATCH", "SETUP_DETECTED", "ZONE_REACHED", "WAIT_FOR_CONFIRMATION", "ENTRY_CONFIRMED"];

export interface ShortTermCriticResult {
  actionCap: ShortTermActionV2;
  confidence: "LOW" | "MEDIUM" | "HIGH";
  primaryContradictions: string[];
  missingEvidence: string[];
  entryConcerns: string[];
  exitConcerns: string[];
  summary: string;
  provider: string;
  model: string;
}

export interface CriticInput {
  ticker: string;
  deterministicCeiling: ShortTermActionV2;
  tier: string;
  modelConfidence: string;
  modelHealthState: string | null;
  freshness: string;
  contradictions: Contradiction[];
  ev: Record<string, unknown> | null;
  setupEvidence: Record<string, unknown>;
  plan: Record<string, unknown>;
  sizing: Record<string, unknown> | null;
}

/** Deterministic critic — always available, zero cost. */
export function localCritic(i: CriticInput): ShortTermCriticResult {
  // The local critic never proposes above the deterministic ceiling.
  const cap = i.contradictions.reduce<ShortTermActionV2>((acc, c) => capAction(acc, c.cap), i.deterministicCeiling);
  return {
    actionCap: cap,
    confidence: "LOW",
    primaryContradictions: i.contradictions.map((c) => c.message),
    missingEvidence: [String((i.setupEvidence as { note?: string }).note ?? "setup evidence")],
    entryConcerns: i.contradictions.filter((c) => c.code.startsWith("ZONE")).map((c) => c.message),
    exitConcerns: [],
    summary:
      cap === "ENTRY_CONFIRMED"
        ? "No deterministic contradiction blocks entry; confirm on fresh data."
        : `Capped at ${cap} — ${i.contradictions[0]?.message ?? "evidence insufficient for entry"}.`,
    provider: "local-deterministic",
    model: "critic-template",
  };
}

const SCHEMA = strictSchema("short_term_risk_critique", {
  actionCap: { type: "string", enum: CRITIC_CAPS },
  confidence: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
  primaryContradictions: { type: "array", items: { type: "string" } },
  missingEvidence: { type: "array", items: { type: "string" } },
  entryConcerns: { type: "array", items: { type: "string" } },
  exitConcerns: { type: "array", items: { type: "string" } },
  summary: { type: "string" },
});

export class ShortTermRiskCritic {
  async review(i: CriticInput, opts: { depth: "AUTO" | "LOCAL_ONLY" | "LOW_COST" | "DEEP_REVIEW" }): Promise<ShortTermCriticResult> {
    const local = localCritic(i);
    if (opts.depth === "LOCAL_ONLY") return local;
    const provider = getOpenAIProvider();
    if (!provider.isAvailable()) return local;
    const tier = opts.depth === "DEEP_REVIEW" ? "SOL" : "LUNA";
    const gate = await aiCostGovernor.allow(tier);
    if (!gate.ok) return local;
    const model = tier === "SOL" ? provider.models().reasoning : provider.models().extraction;
    const inputHash = createHash("sha256").update("st-critic-v1").update(model).update(JSON.stringify(i)).digest("hex");
    const cached = await AppDataSource.getRepository(AiReview)
      .createQueryBuilder("r")
      .where("r.ticker = :t AND r.role = 'short_term_critic' AND r.input_hash = :h AND r.validation_result = 'valid'", { t: i.ticker, h: inputHash })
      .andWhere("r.created_at > now() - interval '24 hours'")
      .orderBy("r.created_at", "DESC")
      .getOne();
    if (cached) return cached.response as unknown as ShortTermCriticResult;

    try {
      const { data, meta } = await provider.structured<Omit<ShortTermCriticResult, "provider" | "model">>({
        model,
        system: `You are the Short-Term Risk Critic. Your job is to find reasons NOT to trade. Reason ONLY over the deterministic evidence provided; never invent prices/targets/probabilities. Your actionCap may be equal to or MORE CONSERVATIVE than the deterministic ceiling (${i.deterministicCeiling}); it may NEVER be more aggressive — code enforces this. Insufficient evidence ⇒ recommend a lower cap and LOW confidence.`,
        user: `DETERMINISTIC EVIDENCE:\n${JSON.stringify(i)}`,
        format: SCHEMA,
        promptVersion: "st-critic-v1",
        validate: (raw) => {
          const o = raw as Record<string, unknown>;
          if (!CRITIC_CAPS.includes(o.actionCap as ShortTermActionV2)) throw new Error("critic schema violation: actionCap");
          for (const k of ["primaryContradictions", "missingEvidence", "entryConcerns", "exitConcerns"]) if (!Array.isArray(o[k])) throw new Error(`critic schema violation: ${k}`);
          if (typeof o.summary !== "string" || !["LOW", "MEDIUM", "HIGH"].includes(o.confidence as string)) throw new Error("critic schema violation");
          return o as never;
        },
      });
      // Cap-only: never above the deterministic ceiling.
      const proposed = data.actionCap as ShortTermActionV2;
      const finalCap = actionRank(proposed) > actionRank(i.deterministicCeiling) ? i.deterministicCeiling : proposed;
      const result: ShortTermCriticResult = { ...data, actionCap: finalCap, provider: "openai", model: meta.modelSnapshot ?? model };
      const repo = AppDataSource.getRepository(AiReview);
      await repo.save(
        repo.create({
          ticker: i.ticker,
          role: "short_term_critic",
          promptVersion: "st-critic-v1",
          modelName: meta.modelSnapshot ?? model,
          provider: "openai",
          inputHash,
          requestContext: { depth: opts.depth },
          response: result as unknown as Record<string, unknown>,
          clamped: finalCap !== proposed,
          clampNotes: finalCap !== proposed ? [`AI proposed ${proposed} above ceiling ${i.deterministicCeiling} — clamped`] : null,
          latencyMs: meta.latencyMs,
          tokensIn: meta.tokensIn,
          tokensOut: meta.tokensOut,
          responseId: meta.responseId,
          schemaVersion: meta.schemaVersion,
          validationResult: "valid",
          meta: { cacheHit: false, tier },
        })
      );
      return result;
    } catch {
      return local;
    }
  }
}

export const shortTermRiskCritic = new ShortTermRiskCritic();
