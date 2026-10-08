/**
 * AiResearchService — the AI research layer. It receives a structured profile
 * with numbered evidence items and returns three SEPARATE lists:
 *   FACT        a restatement of one or more evidence items (must cite ids; numbers must match)
 *   INFERENCE   a reading that follows from cited facts
 *   HYPOTHESIS  a conditional, testable idea ("may … if …"), cited
 * Items that cite nothing, cite unknown ids, or introduce numbers absent from
 * the cited evidence are dropped and the drop is logged. The AI never produces
 * a price, target, stop, probability or recommendation. Cost-governed; output
 * is stored on the profile row with research/model/prompt versions.
 */

import { AppDataSource } from "../../config/database";
import { AiReview } from "../../entities";
import { getOpenAIProvider } from "../reasoning/providerRegistry";
import { strictSchema } from "../reasoning/roles";
import { aiCostGovernor } from "../shortterm/aiAnalyst";
import { EvidenceItem, ResearchProfile } from "./CompanyResearchProfileService";

export const AI_RESEARCH_PROMPT_VERSION = "ai-research-v1";
const BANNED = /guarantee|will rise|will fall|safe profit|best stock|sure shot|multibagger/i;

export interface AiStatement {
  kind: "FACT" | "INFERENCE" | "HYPOTHESIS";
  text: string;
  cites: string[];
}
export interface AiResearchOutput {
  promptVersion: string;
  modelVersion: string;
  researchVersion: string;
  timestamp: string;
  facts: AiStatement[];
  inferences: AiStatement[];
  hypotheses: AiStatement[];
  dropped: number;
  dropReasons: string[];
}

/** Pure validation so tests can pin the grounding rules without an LLM. */
export function validateStatements(raw: AiStatement[], evidence: EvidenceItem[]): { kept: AiStatement[]; dropped: string[] } {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const kept: AiStatement[] = [];
  const dropped: string[] = [];
  for (const s of raw) {
    if (!s || typeof s.text !== "string" || !Array.isArray(s.cites) || !["FACT", "INFERENCE", "HYPOTHESIS"].includes(s.kind)) {
      dropped.push("malformed statement");
      continue;
    }
    if (s.cites.length === 0 || !s.cites.every((c) => byId.has(c))) {
      dropped.push(`${s.kind} cites unknown or no evidence: "${s.text.slice(0, 60)}"`);
      continue;
    }
    if (BANNED.test(s.text)) {
      dropped.push(`${s.kind} uses banned wording`);
      continue;
    }
    // Numbers in the text must appear in the cited evidence (statement or value).
    const nums = s.text.match(/-?\d+(?:\.\d+)?/g) ?? [];
    const cited = s.cites.map((c) => byId.get(c) as EvidenceItem);
    const pool = cited.map((e) => `${e.statement} ${e.value ?? ""} ${e.asOf ?? ""}`).join(" ");
    const foreign = nums.filter((x) => !pool.includes(x) && !pool.includes(String(Number(x))) && Math.abs(Number(x)) > 1);
    if (foreign.length) {
      dropped.push(`${s.kind} introduces numbers not in evidence (${foreign.slice(0, 3).join(", ")})`);
      continue;
    }
    if (s.kind === "HYPOTHESIS" && !/\b(may|could|if|would)\b/i.test(s.text)) {
      dropped.push("HYPOTHESIS not phrased conditionally");
      continue;
    }
    kept.push({ kind: s.kind, text: s.text.trim(), cites: [...new Set(s.cites)] });
  }
  return { kept, dropped };
}

export class AiResearchService {
  async research(symbol: string, built: { profile: ResearchProfile; evidence: EvidenceItem[]; profileId: string | null }): Promise<AiResearchOutput | null> {
    const gate = await aiCostGovernor.allow("LUNA");
    if (!gate.ok) return null;
    const provider = getOpenAIProvider();
    const model = provider.models().analyst;
    const evidence = built.evidence.slice(0, 60);
    const res = await provider.structured<{ statements: AiStatement[] }>({
      model,
      system:
        "You are a research assistant for an Indian equity research system that has NOT demonstrated an edge. You receive a company profile and a numbered evidence list. Produce at most 12 statements, each typed FACT, INFERENCE or HYPOTHESIS, each citing evidence ids in `cites`. FACT restates evidence only. INFERENCE is a reading that follows from the cited facts. HYPOTHESIS is conditional ('may … if …') and testable. Never invent a number, price, target, stop, probability, catalyst or recommendation. Never use guarantee/will rise/safe profit/best stock. If evidence is thin, say so in an INFERENCE citing the coverage facts.",
      user: JSON.stringify({ symbol, identity: built.profile.identity, gaps: built.profile.gaps, dataAsOf: built.profile.dataAsOf, evidence: evidence.map((e) => ({ id: e.id, section: e.section, statement: e.statement, asOf: e.asOf })) }),
      format: strictSchema("ai_research", {
        statements: { type: "array", items: { type: "object", properties: { kind: { type: "string", enum: ["FACT", "INFERENCE", "HYPOTHESIS"] }, text: { type: "string" }, cites: { type: "array", items: { type: "string" } } }, required: ["kind", "text", "cites"], additionalProperties: false } },
      }),
      promptVersion: AI_RESEARCH_PROMPT_VERSION,
      validate: (raw) => {
        const o = raw as { statements?: unknown };
        if (!o || !Array.isArray(o.statements)) throw new Error("statements missing");
        return { statements: o.statements as AiStatement[] };
      },
    });
    const { kept, dropped } = validateStatements(res.data.statements, evidence);
    const out: AiResearchOutput = {
      promptVersion: AI_RESEARCH_PROMPT_VERSION,
      modelVersion: res.meta.modelSnapshot ?? model,
      researchVersion: built.profile.researchVersion,
      timestamp: new Date().toISOString(),
      facts: kept.filter((k) => k.kind === "FACT"),
      inferences: kept.filter((k) => k.kind === "INFERENCE"),
      hypotheses: kept.filter((k) => k.kind === "HYPOTHESIS"),
      dropped: dropped.length,
      dropReasons: dropped.slice(0, 10),
    };
    if (built.profileId) {
      // The profile row is append-only; the AI result is written as a NEW profile version carrying the same evidence.
      await AppDataSource.query(
        `INSERT INTO company_research_profiles (symbol, research_version, data_as_of, profile, evidence_items, source_references, ai, model_version, coverage_score)
         SELECT symbol, research_version, data_as_of, profile, evidence_items, source_references, $2::jsonb, $3, coverage_score FROM company_research_profiles WHERE id = $1`,
        [built.profileId, JSON.stringify(out), out.modelVersion]
      );
    }
    try {
      const repo = AppDataSource.getRepository(AiReview);
      await repo.save(repo.create({ ticker: symbol, role: "research_assistant", promptVersion: AI_RESEARCH_PROMPT_VERSION, modelName: out.modelVersion, provider: provider.name, inputHash: res.meta.inputHash, requestContext: { evidenceIds: evidence.map((e) => e.id) }, response: out as unknown as Record<string, unknown>, clamped: dropped.length > 0, clampNotes: dropped.length ? dropped.slice(0, 10) : null, latencyMs: res.meta.latencyMs, tokensIn: res.meta.tokensIn, tokensOut: res.meta.tokensOut, responseId: res.meta.responseId, schemaVersion: res.meta.schemaVersion, validationResult: "valid", meta: { cacheHit: false, tier: "LUNA" } }));
    } catch { /* cost accounting best-effort */ }
    return out;
  }
}

export const aiResearchService = new AiResearchService();
