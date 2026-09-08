/**
 * AiCostGovernor + ShortTermTradeAnalyst (S10/S11).
 *
 * FREE-FIRST: the Trade Radar never needs OpenAI. The analyst is an
 * escalation layer — a deterministic local summary is always available; a
 * local LLM (Ollama) is used when configured; OpenAI (luna → terra → sol)
 * only within the governor's budgets and only at the requested depth.
 * AI output is advisory and CAP-ONLY versus the deterministic action.
 */

import { createHash } from "crypto";
import { AppDataSource } from "../../config/database";
import { AiReview } from "../../entities";
import { getOpenAIProvider } from "../reasoning/providerRegistry";
import { strictSchema } from "../reasoning/roles";
import { ShortTermAction, ShortTermCandidateView } from "./types";

// ── Cost governor ────────────────────────────────────────────────────────────

/** USD per 1M tokens (input, output) — env-overridable so pricing is data. */
const PRICES: Record<string, { in: number; out: number }> = {
  "gpt-5.6-luna": { in: Number(process.env.AI_PRICE_LUNA_IN ?? 0.1), out: Number(process.env.AI_PRICE_LUNA_OUT ?? 0.4) },
  "gpt-5.6-terra": { in: Number(process.env.AI_PRICE_TERRA_IN ?? 1.25), out: Number(process.env.AI_PRICE_TERRA_OUT ?? 5) },
  "gpt-5.6-sol": { in: Number(process.env.AI_PRICE_SOL_IN ?? 5), out: Number(process.env.AI_PRICE_SOL_OUT ?? 20) },
};

export interface AiUsageReport {
  todayUsd: number;
  monthUsd: number;
  dailyBudgetUsd: number;
  monthlyBudgetUsd: number;
  calls: Record<string, number>; // LOCAL / LUNA / TERRA / SOL counts today
  cacheHitPct: number | null;
  withinBudget: boolean;
}

export class AiCostGovernor {
  private tier(model: string): "LUNA" | "TERRA" | "SOL" | "OTHER" {
    if (model.includes("luna")) return "LUNA";
    if (model.includes("terra")) return "TERRA";
    if (model.includes("sol")) return "SOL";
    return "OTHER";
  }

  private costUsd(model: string, tokensIn: number, tokensOut: number): number {
    const key = Object.keys(PRICES).find((k) => model.startsWith(k)) ?? "gpt-5.6-terra";
    const p = PRICES[key];
    return (tokensIn * p.in + tokensOut * p.out) / 1_000_000;
  }

  /** Usage computed from the ai_reviews audit trail — no separate meter to drift. */
  async usage(): Promise<AiUsageReport> {
    const rows: Array<{ model_name: string; tin: string | null; tout: string | null; day: string }> =
      await AppDataSource.query(
        `SELECT model_name, SUM(tokens_in)::text AS tin, SUM(tokens_out)::text AS tout,
                CASE WHEN created_at >= date_trunc('day', now()) THEN 'today' ELSE 'month' END AS day
           FROM ai_reviews
          WHERE provider = 'openai' AND created_at >= date_trunc('month', now())
          GROUP BY model_name, day`
      ).catch(() => []);
    let todayUsd = 0;
    let monthUsd = 0;
    for (const r of rows) {
      const c = this.costUsd(r.model_name, Number(r.tin ?? 0), Number(r.tout ?? 0));
      monthUsd += c;
      if (r.day === "today") todayUsd += c;
    }
    const callRows: Array<{ model_name: string; n: string }> = await AppDataSource.query(
      `SELECT model_name, COUNT(*)::text AS n FROM ai_reviews
        WHERE provider = 'openai' AND created_at >= date_trunc('day', now()) GROUP BY model_name`
    ).catch(() => []);
    const calls: Record<string, number> = { LOCAL: 0, LUNA: 0, TERRA: 0, SOL: 0 };
    for (const r of callRows) calls[this.tier(r.model_name)] = (calls[this.tier(r.model_name)] ?? 0) + Number(r.n);
    const cacheRows: Array<{ hits: string; total: string }> = await AppDataSource.query(
      `SELECT COUNT(*) FILTER (WHERE (meta->>'cacheHit') = 'true')::text AS hits, COUNT(*)::text AS total
         FROM ai_reviews WHERE created_at >= date_trunc('day', now())`
    ).catch(() => []);
    const total = Number(cacheRows[0]?.total ?? 0);
    const dailyBudgetUsd = Number(process.env.AI_DAILY_BUDGET_USD ?? 2);
    const monthlyBudgetUsd = Number(process.env.AI_MONTHLY_BUDGET_USD ?? 30);
    return {
      todayUsd: Math.round(todayUsd * 100) / 100,
      monthUsd: Math.round(monthUsd * 100) / 100,
      dailyBudgetUsd,
      monthlyBudgetUsd,
      calls,
      cacheHitPct: total > 0 ? Math.round((Number(cacheRows[0]?.hits ?? 0) / total) * 100) : null,
      withinBudget: todayUsd < dailyBudgetUsd && monthUsd < monthlyBudgetUsd,
    };
  }

  /** May we place a call on this tier right now? Hard per-tier daily caps + $ budgets. */
  async allow(tier: "LUNA" | "TERRA" | "SOL"): Promise<{ ok: boolean; reason: string }> {
    const u = await this.usage();
    if (!u.withinBudget) return { ok: false, reason: `AI budget reached (today $${u.todayUsd}/${u.dailyBudgetUsd}) — deterministic/local analysis continues` };
    const caps = {
      LUNA: Number(process.env.AI_MAX_LUNA_CALLS_PER_DAY ?? 200),
      TERRA: Number(process.env.AI_MAX_TERRA_CALLS_PER_DAY ?? 40),
      SOL: Number(process.env.AI_MAX_SOL_CALLS_PER_DAY ?? 10),
    };
    if ((u.calls[tier] ?? 0) >= caps[tier]) return { ok: false, reason: `${tier} daily call cap (${caps[tier]}) reached` };
    return { ok: true, reason: "within budget" };
  }
}

export const aiCostGovernor = new AiCostGovernor();

// ── ShortTermTradeAnalyst ────────────────────────────────────────────────────

const ST_ACTIONS = ["NO_TRADE", "WATCH", "WAIT_FOR_ENTRY", "ENTRY_READY", "HOLD", "TAKE_PARTIAL", "TRAIL", "EXIT"] as const;
const ACTION_RANK: Record<string, number> = { NO_TRADE: 0, EXIT: 0, WATCH: 1, WAIT_FOR_ENTRY: 2, ENTRY_READY: 3, HOLD: 3, TAKE_PARTIAL: 2, TRAIL: 2 };

export interface ShortTermAiReview {
  state: (typeof ST_ACTIONS)[number];
  confidence: "LOW" | "MEDIUM" | "HIGH";
  whyCandidate: string[];
  whyNotCandidate: string[];
  entrySummary: string;
  exitSummary: string;
  riskSummary: string;
  missingEvidence: string[];
  whatWouldImproveSetup: string[];
  whatWouldInvalidateSetup: string[];
  dataTimestamp: string;
  provider: string;
  model: string;
  clamped: boolean;
  clampNote: string | null;
}

const ST_SCHEMA = strictSchema("short_term_review", {
  state: { type: "string", enum: [...ST_ACTIONS] },
  confidence: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
  whyCandidate: { type: "array", items: { type: "string" } },
  whyNotCandidate: { type: "array", items: { type: "string" } },
  entrySummary: { type: "string" },
  exitSummary: { type: "string" },
  riskSummary: { type: "string" },
  missingEvidence: { type: "array", items: { type: "string" } },
  whatWouldImproveSetup: { type: "array", items: { type: "string" } },
  whatWouldInvalidateSetup: { type: "array", items: { type: "string" } },
  dataTimestamp: { type: "string" },
});

/** Map the deterministic radar action (V2 states) into the analyst's ceiling. */
function ceilingFor(action: string): (typeof ST_ACTIONS)[number] {
  switch (action) {
    case "ENTRY_CONFIRMED":
      return "ENTRY_READY";
    case "ZONE_REACHED":
    case "WAIT_FOR_CONFIRMATION":
      return "WAIT_FOR_ENTRY";
    case "SETUP_DETECTED":
    case "RESEARCH_WATCH":
      return "WATCH";
    case "ACTIVE_POSITION":
      return "HOLD";
    case "TAKE_PARTIAL":
      return "TAKE_PARTIAL";
    case "TRAIL":
      return "TRAIL";
    case "EXIT":
      return "EXIT";
    default:
      return "NO_TRADE";
  }
}

/** Deterministic zero-cost summary — always available (LOCAL tier). */
export function localSummary(v: ShortTermCandidateView, question?: string): ShortTermAiReview {
  const why = v.gates.passed ? v.whyCandidate : [];
  const whyNot = v.gates.passed ? [] : v.gates.failures.map((f) => `${f.gate}: ${f.current} (needs ${f.required})`);
  return {
    state: ceilingFor(v.action),
    confidence: "LOW",
    whyCandidate: why,
    whyNotCandidate: whyNot,
    entrySummary:
      v.plan.entryType === "NONE"
        ? "No structural entry derivable."
        : `${v.plan.entryType}: ${v.plan.entryTrigger ?? `zone ₹${v.plan.entryZoneLow}–₹${v.plan.entryZoneHigh}`}; stop ₹${v.plan.initialStop} (${v.plan.stopBasis}).`,
    exitSummary: `T1 ₹${v.plan.target1 ?? "—"} (R:R ${v.plan.rewardRiskToTarget1 ?? "—"}), T2 ₹${v.plan.target2 ?? "—"}; time stop ${v.plan.expectedHoldingDays}+ sessions; invalidation: ${v.plan.invalidationReason ?? "stop"}`,
    riskSummary: v.whatCanGoWrong.join(" "),
    missingEvidence: [v.forecast.probabilityStatement],
    whatWouldImproveSetup: v.gates.failures.map((f) => `${f.gate} → ${f.required}`),
    whatWouldInvalidateSetup: [v.plan.invalidationReason ?? "close below the stop"],
    dataTimestamp: v.freshness.lastUpdate ?? new Date().toISOString(),
    provider: "local-deterministic",
    model: question ? "template+question(no-LLM)" : "template",
    clamped: false,
    clampNote: null,
  };
}

export class ShortTermTradeAnalyst {
  /**
   * depth AUTO/LOW_COST → luna; DEEP_REVIEW → sol (governed); LOCAL_ONLY →
   * deterministic summary. Falls back local on any failure/budget stop.
   */
  async review(
    v: ShortTermCandidateView,
    opts: { depth: "AUTO" | "LOCAL_ONLY" | "LOW_COST" | "DEEP_REVIEW"; question?: string; userBudget?: number | null; userRiskPct?: number | null }
  ): Promise<ShortTermAiReview> {
    if (opts.depth === "LOCAL_ONLY") return localSummary(v, opts.question);
    const provider = getOpenAIProvider();
    if (!provider.isAvailable()) return localSummary(v, opts.question);

    const tier = opts.depth === "DEEP_REVIEW" ? "SOL" : "LUNA";
    const gate = await aiCostGovernor.allow(tier);
    if (!gate.ok) {
      const local = localSummary(v, opts.question);
      local.missingEvidence.push(`AI escalation skipped: ${gate.reason}`);
      return local;
    }

    const model = tier === "SOL" ? provider.models().reasoning : provider.models().extraction;
    const ceiling = ceilingFor(v.action);
    const evidence = {
      candidate: v,
      userBudget: opts.userBudget ?? null,
      userRiskPct: opts.userRiskPct ?? null,
      question: opts.question ?? null,
      deterministicCeiling: ceiling,
    };
    const inputHash = createHash("sha256").update("st-analyst-v1").update(model).update(JSON.stringify(evidence)).digest("hex");

    // Evidence-hash cache.
    const cached = await AppDataSource.getRepository(AiReview)
      .createQueryBuilder("r")
      .where("r.ticker = :t AND r.role = 'short_term_analyst' AND r.input_hash = :h AND r.validation_result = 'valid'", { t: v.ticker, h: inputHash })
      .andWhere("r.created_at > now() - interval '24 hours'")
      .orderBy("r.created_at", "DESC")
      .getOne();
    if (cached) return cached.response as unknown as ShortTermAiReview;

    try {
      const { data, meta } = await provider.structured<Omit<ShortTermAiReview, "provider" | "model" | "clamped" | "clampNote">>({
        model,
        system: `You are the Short-Term Trade Analyst. Reason ONLY over the structured deterministic evidence provided (levels, stops, targets, gates, freshness). NEVER invent prices, targets, stops, events or probabilities — every number you mention must appear in the input. The deterministic action is a CEILING: your "state" may be equal or more cautious, never more aggressive. Insufficient evidence ⇒ LOW confidence. dataTimestamp = the input's freshness timestamp.`,
        user: `${opts.question ? `USER QUESTION: ${opts.question}\n\n` : ""}DETERMINISTIC EVIDENCE:\n${JSON.stringify(evidence)}`,
        format: ST_SCHEMA,
        promptVersion: "st-analyst-v1",
        validate: (raw) => {
          const o = raw as Record<string, unknown>;
          if (typeof o?.state !== "string" || !ST_ACTIONS.includes(o.state as never)) throw new Error("short-term analyst schema violation: state");
          for (const k of ["entrySummary", "exitSummary", "riskSummary", "dataTimestamp"]) if (typeof o[k] !== "string") throw new Error(`short-term analyst schema violation: ${k}`);
          for (const k of ["whyCandidate", "whyNotCandidate", "missingEvidence", "whatWouldImproveSetup", "whatWouldInvalidateSetup"])
            if (!Array.isArray(o[k])) throw new Error(`short-term analyst schema violation: ${k}`);
          if (!["LOW", "MEDIUM", "HIGH"].includes(o.confidence as string)) throw new Error("short-term analyst schema violation: confidence");
          return o as never;
        },
      });

      // CAP-ONLY clamp in code.
      let state = data.state;
      let clamped = false;
      let clampNote: string | null = null;
      if ((ACTION_RANK[state] ?? 0) > (ACTION_RANK[ceiling] ?? 0)) {
        clampNote = `AI proposed ${state} above the deterministic ceiling ${ceiling} — clamped.`;
        state = ceiling;
        clamped = true;
      }
      const review: ShortTermAiReview = { ...data, state, provider: "openai", model: meta.modelSnapshot ?? model, clamped, clampNote };

      const repo = AppDataSource.getRepository(AiReview);
      await repo.save(
        repo.create({
          ticker: v.ticker,
          role: "short_term_analyst",
          promptVersion: "st-analyst-v1",
          modelName: meta.modelSnapshot ?? model,
          provider: "openai",
          inputHash,
          requestContext: { depth: opts.depth, question: opts.question ?? null },
          response: review as unknown as Record<string, unknown>,
          clamped,
          clampNotes: clampNote ? [clampNote] : null,
          latencyMs: meta.latencyMs,
          tokensIn: meta.tokensIn,
          tokensOut: meta.tokensOut,
          responseId: meta.responseId,
          schemaVersion: meta.schemaVersion,
          validationResult: "valid",
          meta: { cacheHit: false, tier },
        })
      );
      return review;
    } catch {
      const local = localSummary(v, opts.question);
      local.missingEvidence.push("AI escalation failed — deterministic summary shown (decision unaffected).");
      return local;
    }
  }
}

export const shortTermTradeAnalyst = new ShortTermTradeAnalyst();
