/**
 * Sub-₹100 AI scout (wide-scout-v1) — the DeepSeek agent in the cheap-stock loop.
 *
 * It is a RED-FLAG and RISK agent, not an oracle. Grounded strictly to the
 * quantitative screen evidence it is handed (liquidity, delivery trend, returns,
 * volatility, drawdown, distance-from-high, surveillance history, index
 * membership), it:
 *   - names concrete penny-stock risks it can SEE in that evidence,
 *   - lists what it was NOT given (no news / filings / promoter-pledge feed),
 *   - emits a CAP-ONLY action: AFFIRM | CAP_TO_WATCH | CAP_TO_NO_TRADE.
 *
 * Hard guarantees (enforced in code, not trusted to the model):
 *   - capAction is coerced into the enum; anything else ⇒ AFFIRM (no silent
 *     downgrade AND no illegal upgrade — AFFIRM is the neutral default).
 *   - the model has NO lever that raises a decision; the richest thing it can
 *     say is AFFIRM. applyAiCap() does the rest deterministically.
 *   - catalysts are only admissible if the evidence contained them; with no
 *     news feed supplied, the schema still has the field but the prompt forbids
 *     inventing one, and we surface "no news evidence supplied" to the user.
 *
 * Cost: cheap tier only (extraction model), hard-gated by aiCostGovernor and
 * capped per run, so scanning a shortlist can never blow the daily budget.
 */

import { getOpenAIProvider } from "../reasoning/providerRegistry";
import { strictSchema } from "../reasoning/roles";
import { aiCostGovernor } from "./aiAnalyst";
import { WideScreenEvidence, AiCapAction } from "./wideLedger";

export const WIDE_SCOUT_PROMPT_VERSION = "wide-scout-v1";

const CAP_ACTIONS: AiCapAction[] = ["AFFIRM", "CAP_TO_WATCH", "CAP_TO_NO_TRADE"];

export interface WideScoutDossier {
  /** Concrete risks visible IN THE EVIDENCE (empty if none seen). */
  redFlags: string[];
  /** Catalysts ONLY if present in supplied evidence — empty when none given. */
  catalysts: string[];
  /** Evidence the scout would need but was not handed (always honest). */
  missingEvidence: string[];
  /** One-paragraph plain risk read, referencing only supplied numbers. */
  riskNarrative: string;
  /** Cap-only lever. Never raises the deterministic decision. */
  capAction: AiCapAction;
  capReason: string;
  confidence: "LOW" | "MEDIUM" | "HIGH";
}

export interface WideScoutResult {
  dossier: WideScoutDossier;
  provider: string;
  model: string;
  /** True when we could not call the model and returned a neutral AFFIRM. */
  degraded: boolean;
  degradedReason: string | null;
}

const WIDE_SCOUT_SCHEMA = strictSchema("wide_scout", {
  redFlags: { type: "array", items: { type: "string" } },
  catalysts: { type: "array", items: { type: "string" } },
  missingEvidence: { type: "array", items: { type: "string" } },
  riskNarrative: { type: "string" },
  capAction: { type: "string", enum: CAP_ACTIONS },
  capReason: { type: "string" },
  confidence: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
});

const SYSTEM = [
  "You are the Sub-₹100 Risk Scout for Indian (NSE) stocks.",
  "You reason ONLY over the quantitative evidence object provided. You must NOT invent news, orders, earnings, promoter actions, or any fact not present in that object — if you were given no news, you have no catalysts.",
  "Cheap stocks carry specific dangers: thin liquidity (you cannot exit), circuit locks, exchange surveillance (ASM/GSM), pump-and-dump spikes, collapsing delivery %, extreme drawdowns, and prices far below their 1-year high for a reason.",
  "Your job is to flag what is RISKY in the evidence and to be conservative.",
  "You have exactly one lever — capAction — and it can only keep (AFFIRM) or REDUCE the system's decision: AFFIRM | CAP_TO_WATCH | CAP_TO_NO_TRADE. You cannot and must not recommend buying; there is no such option.",
  "Prefer CAP_TO_NO_TRADE when liquidity is thin, surveillance is present, delivery is deteriorating, or the move looks like a spike. Insufficient evidence ⇒ LOW confidence.",
].join(" ");

/** Build the dossier for one sub-₹100 candidate. Never throws — on any
 *  provider/budget failure it returns a NEUTRAL AFFIRM so the deterministic
 *  decision stands unchanged (the scout is additive, never a blocker). */
export async function scoutCandidate(evidence: WideScreenEvidence): Promise<WideScoutResult> {
  const neutral = (reason: string): WideScoutResult => ({
    dossier: {
      redFlags: [],
      catalysts: [],
      missingEvidence: ["AI scout unavailable — deterministic decision stands without a second opinion"],
      riskNarrative: "No AI risk review was performed for this candidate; rely on the quantitative screen and gates.",
      capAction: "AFFIRM",
      capReason: reason,
      confidence: "LOW",
    },
    provider: "none",
    model: "none",
    degraded: true,
    degradedReason: reason,
  });

  const provider = getOpenAIProvider();
  if (!provider.isAvailable()) return neutral("no reasoning provider configured");
  const gate = await aiCostGovernor.allow("LUNA").catch(() => ({ ok: false, reason: "cost governor error" }));
  if (!gate.ok) return neutral(gate.reason);

  const model = provider.models().extraction;
  try {
    const { data, meta } = await provider.structured<WideScoutDossier>({
      model,
      system: SYSTEM,
      user: `SUB-₹100 CANDIDATE EVIDENCE (quantitative only; no news/filings feed was supplied):\n${JSON.stringify(evidence)}`,
      format: WIDE_SCOUT_SCHEMA,
      promptVersion: WIDE_SCOUT_PROMPT_VERSION,
      validate: (raw) => {
        const o = raw as Record<string, unknown>;
        for (const k of ["redFlags", "catalysts", "missingEvidence"]) if (!Array.isArray(o[k])) throw new Error(`wide scout schema violation: ${k}`);
        if (typeof o.riskNarrative !== "string" || typeof o.capReason !== "string") throw new Error("wide scout schema violation: narrative/capReason");
        if (!CAP_ACTIONS.includes(o.capAction as AiCapAction)) throw new Error("wide scout schema violation: capAction");
        if (!["LOW", "MEDIUM", "HIGH"].includes(o.confidence as string)) throw new Error("wide scout schema violation: confidence");
        return o as unknown as WideScoutDossier;
      },
    });

    // Defence in depth: coerce any unexpected capAction to the neutral AFFIRM.
    // The model structurally cannot upgrade, but we never trust that blindly.
    const capAction: AiCapAction = CAP_ACTIONS.includes(data.capAction) ? data.capAction : "AFFIRM";
    return {
      dossier: { ...data, capAction },
      provider: provider.name,
      model: meta.modelSnapshot ?? model,
      degraded: false,
      degradedReason: null,
    };
  } catch (err) {
    return neutral(`scout call failed: ${(err as Error).message}`);
  }
}
