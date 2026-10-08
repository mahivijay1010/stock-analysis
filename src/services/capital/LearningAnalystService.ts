/**
 * Learning Analyst — answers "what is the system learning?" from MEASURED data.
 *
 * Step 1 (always, deterministic): build a list of facts, each carrying the
 * metric, value, sample size and the record it came from. Facts below the
 * sample floor are emitted as "insufficient evidence" facts, never as claims.
 * Step 2 (optional, cost-governed): ask the configured LLM to phrase a short
 * narrative. Every sentence must cite a fact id from step 1; a sentence that
 * cites nothing, or cites an id we did not supply, is dropped. The LLM cannot
 * add numbers, promote models, or change thresholds — it only re-states.
 */

import { AppDataSource } from "../../config/database";
import { AiReview } from "../../entities";
import { getOpenAIProvider } from "../reasoning/providerRegistry";
import { strictSchema } from "../reasoning/roles";
import { aiCostGovernor } from "../shortterm/aiAnalyst";
import { capitalOutcomeService } from "./CapitalOutcomeService";
import { CapitalTrackRecord, MIN_GRADED_FOR_CAPITAL_RATE, SegmentRow } from "./capitalTrackRecord";

export interface LearningFact {
  id: string;
  kind: "FINDING" | "INSUFFICIENT" | "CONTEXT";
  statement: string;
  metric: string;
  value: number | string | null;
  n: number;
  source: string; // table / endpoint the number came from
}

export interface LearningReport {
  version: string;
  generatedAt: string;
  facts: LearningFact[];
  narrative: Array<{ text: string; cites: string[] }>;
  narrativeSource: "deterministic" | "llm" | "llm-unavailable";
  evidenceStatus: string;
  caveat: string;
}

const PROMPT_VERSION = "learning-analyst-v1";

export class LearningAnalystService {
  async report(opts: { useAi?: boolean } = {}): Promise<LearningReport> {
    const facts: LearningFact[] = [];
    const rec = await capitalOutcomeService.trackRecord().catch(() => null);
    if (rec) facts.push(...factsFromTrackRecord(rec));
    facts.push(...(await this.factsFromSetupEvidence()));
    facts.push(...(await this.factsFromShadowLedgers()));
    const findings = facts.filter((f) => f.kind === "FINDING");
    const evidenceStatus = findings.length
      ? `${findings.length} measured finding(s), ${facts.filter((f) => f.kind === "INSUFFICIENT").length} question(s) still below the sample floor.`
      : `No finding clears the sample floor yet. ${facts.filter((f) => f.kind === "INSUFFICIENT").length} question(s) are accruing evidence.`;
    let narrative: LearningReport["narrative"] = facts.filter((f) => f.kind !== "CONTEXT").map((f) => ({ text: f.statement, cites: [f.id] }));
    let narrativeSource: LearningReport["narrativeSource"] = "deterministic";
    if (opts.useAi && findings.length > 0) {
      const ai = await this.phraseWithLlm(facts).catch(() => null);
      if (ai && ai.length) {
        narrative = ai;
        narrativeSource = "llm";
      } else narrativeSource = "llm-unavailable";
    }
    return {
      version: PROMPT_VERSION,
      generatedAt: new Date().toISOString(),
      facts,
      narrative,
      narrativeSource,
      evidenceStatus,
      caveat: "Every statement references a measured metric and its sample size. Findings below 10 observed outcomes are reported as insufficient, not as conclusions. Nothing here changes a threshold or promotes a model.",
    };
  }

  private async factsFromSetupEvidence(): Promise<LearningFact[]> {
    const out: LearningFact[] = [];
    try {
      const rows: Array<{ metrics: Record<string, unknown>; created_at: string }> = await AppDataSource.query(
        `SELECT metrics, created_at FROM short_term_model_performance WHERE model_name = 'st-setup-expectancy' ORDER BY created_at DESC LIMIT 1`
      );
      const cells = (rows[0]?.metrics?.cells ?? []) as Array<Record<string, unknown>>;
      const usable = cells.filter((c) => c.usableForEntry === true);
      out.push({
        id: "setup-cells",
        kind: "CONTEXT",
        statement: `${cells.length} setup×horizon cells in the sealed-data expectancy study; ${usable.length} usable for entry (tier A).`,
        metric: "setup cells usable for entry",
        value: usable.length,
        n: cells.length,
        source: "short_term_model_performance:st-setup-expectancy",
      });
      const ranked = cells
        .filter((c) => typeof c.expectancyAfterCosts === "number" && Number(c.independentEntryDates) >= 60)
        .sort((a, b) => Number(b.expectancyAfterCosts) - Number(a.expectancyAfterCosts));
      if (ranked.length >= 2) {
        const best = ranked[0];
        const worst = ranked[ranked.length - 1];
        out.push({
          id: "setup-best-vs-worst",
          kind: "FINDING",
          statement: `${best.setupType} (${best.horizon}) has after-cost expectancy ${Number(best.expectancyAfterCosts).toFixed(2)}R on ${best.independentEntryDates} independent dates versus ${worst.setupType} (${worst.horizon}) at ${Number(worst.expectancyAfterCosts).toFixed(2)}R on ${worst.independentEntryDates} — on sealed backtest data, not live.`,
          metric: "expectancyAfterCosts (R)",
          value: Number(best.expectancyAfterCosts),
          n: Number(best.independentEntryDates),
          source: "short_term_model_performance:st-setup-expectancy.cells",
        });
      }
    } catch {
      /* table optional */
    }
    return out;
  }

  private async factsFromShadowLedgers(): Promise<LearningFact[]> {
    const out: LearningFact[] = [];
    try {
      const rows: Array<{ lane: string; n: string; observed: string; mean_r: string | null; wins: string }> = await AppDataSource.query(
        `SELECT 'radar' AS lane, COUNT(*)::text AS n,
                COUNT(*) FILTER (WHERE outcome->>'realizedNetR' IS NOT NULL)::text AS observed,
                AVG((outcome->>'realizedNetR')::numeric)::text AS mean_r,
                COUNT(*) FILTER (WHERE (outcome->>'realizedNetR')::numeric > 0)::text AS wins
           FROM short_term_shadow_predictions WHERE outcome IS NOT NULL
         UNION ALL
         SELECT 'sub100', COUNT(*)::text, COUNT(*) FILTER (WHERE outcome->>'realizedNetR' IS NOT NULL)::text,
                AVG((outcome->>'realizedNetR')::numeric)::text, COUNT(*) FILTER (WHERE (outcome->>'realizedNetR')::numeric > 0)::text
           FROM wide_shadow_predictions WHERE outcome IS NOT NULL`
      );
      for (const r of rows) {
        const observed = Number(r.observed);
        if (observed >= MIN_GRADED_FOR_CAPITAL_RATE && r.mean_r != null) {
          out.push({
            id: `shadow-${r.lane}`,
            kind: "FINDING",
            statement: `${r.lane} shadow ledger: mean realized ${Number(r.mean_r).toFixed(2)}R over ${observed} observed outcomes (${r.wins} positive). ${Number(r.mean_r) <= 0 ? "Not positive — no live edge demonstrated." : "Positive so far; live authority needs ≥20 independent dates per setup."}`,
            metric: "mean realizedNetR",
            value: Number(r.mean_r),
            n: observed,
            source: r.lane === "radar" ? "short_term_shadow_predictions.outcome" : "wide_shadow_predictions.outcome",
          });
        } else {
          out.push({
            id: `shadow-${r.lane}`,
            kind: "INSUFFICIENT",
            statement: `${r.lane} shadow ledger: ${observed} observed outcomes of ${r.n} resolved — below the ${MIN_GRADED_FOR_CAPITAL_RATE}-outcome floor, so no expectancy is stated.`,
            metric: "observed outcomes",
            value: observed,
            n: Number(r.n),
            source: r.lane === "radar" ? "short_term_shadow_predictions" : "wide_shadow_predictions",
          });
        }
      }
    } catch {
      /* ledgers optional */
    }
    return out;
  }

  private async phraseWithLlm(facts: LearningFact[]): Promise<Array<{ text: string; cites: string[] }> | null> {
    const gate = await aiCostGovernor.allow("LUNA");
    if (!gate.ok) return null;
    const provider = getOpenAIProvider();
    const model = provider.models().analyst;
    const ids = new Set(facts.map((f) => f.id));
    const res = await provider.structured<{ sentences: Array<{ text: string; cites: string[] }> }>({
      model,
      system:
        "You are the Learning Analyst for a stock research system that has NOT demonstrated an edge. You receive measured facts with ids. Write at most 6 short sentences summarising what the system is learning. RULES: every sentence must cite one or more fact ids in `cites`; never introduce a number, ticker, probability or conclusion that is not in the facts; never say guaranteed, will rise, safe profit, or best stock; findings marked INSUFFICIENT must be described as insufficient evidence.",
      user: JSON.stringify({ facts }),
      format: strictSchema("learning_narrative", {
        sentences: {
          type: "array",
          items: { type: "object", properties: { text: { type: "string" }, cites: { type: "array", items: { type: "string" } } }, required: ["text", "cites"], additionalProperties: false },
        },
      }),
      promptVersion: PROMPT_VERSION,
      validate: (raw) => {
        const o = raw as { sentences?: unknown };
        if (!o || !Array.isArray(o.sentences)) throw new Error("sentences missing");
        return { sentences: o.sentences as Array<{ text: string; cites: string[] }> };
      },
    });
    const banned = /guarantee|will rise|safe profit|best stock/i;
    const kept = res.data.sentences
      .filter((s) => typeof s.text === "string" && Array.isArray(s.cites) && s.cites.length > 0 && s.cites.every((c) => ids.has(c)) && !banned.test(s.text))
      .slice(0, 6);
    try {
      const repo = AppDataSource.getRepository(AiReview);
      await repo.save(
        repo.create({
          ticker: "LEARNING",
          role: "learning_analyst",
          promptVersion: PROMPT_VERSION,
          modelName: res.meta.modelSnapshot ?? model,
          provider: provider.name,
          inputHash: res.meta.inputHash,
          requestContext: { factIds: [...ids] },
          response: { sentences: kept } as unknown as Record<string, unknown>,
          clamped: kept.length !== res.data.sentences.length,
          clampNotes: kept.length !== res.data.sentences.length ? [`${res.data.sentences.length - kept.length} sentence(s) dropped: uncited or banned wording`] : null,
          latencyMs: res.meta.latencyMs,
          tokensIn: res.meta.tokensIn,
          tokensOut: res.meta.tokensOut,
          responseId: res.meta.responseId,
          schemaVersion: res.meta.schemaVersion,
          validationResult: "valid",
          meta: { cacheHit: false, tier: "LUNA" },
        })
      );
    } catch {
      /* cost accounting best-effort */
    }
    return kept;
  }
}

function factsFromTrackRecord(rec: CapitalTrackRecord): LearningFact[] {
  const out: LearningFact[] = [];
  const o = rec.overall;
  if (o.withheld) {
    out.push({
      id: "desk-overall",
      kind: "INSUFFICIENT",
      statement: `Money Desk: ${o.totalRecommendations} recommendations logged, ${o.observed} observed outcomes — below the ${MIN_GRADED_FOR_CAPITAL_RATE}-outcome floor; no win rate or excess return is stated.`,
      metric: "observed outcomes",
      value: o.observed,
      n: o.totalRecommendations,
      source: "GET /api/capital/track-record",
    });
    return out;
  }
  out.push({
    id: "desk-overall",
    kind: "FINDING",
    statement: `Money Desk: win rate ${o.winRate.pct}% (Wilson lower bound ${o.winRate.wilsonLb95Pct}%), mean return ${o.avgReturnPct.mean}%, mean excess over NIFTY ${o.benchmarkExcessPct.mean ?? "—"}% on ${o.observed} observed outcomes.`,
    metric: "mean excess return vs NIFTY (%)",
    value: o.benchmarkExcessPct.mean,
    n: o.observed,
    source: "capital_decision_outcomes",
  });
  const seg = (rows: SegmentRow[], label: string, id: string) => {
    const shown = rows.filter((r) => !r.metrics.withheld);
    if (shown.length >= 2) {
      const best = shown.reduce((a, b) => ((b.metrics.expectancyR ?? -Infinity) > (a.metrics.expectancyR ?? -Infinity) ? b : a));
      const worst = shown.reduce((a, b) => ((b.metrics.expectancyR ?? Infinity) < (a.metrics.expectancyR ?? Infinity) ? b : a));
      out.push({
        id,
        kind: "FINDING",
        statement: `By ${label}: ${best.key} expectancy ${best.metrics.expectancyR}R (n=${best.metrics.observed}) versus ${worst.key} ${worst.metrics.expectancyR}R (n=${worst.metrics.observed}).`,
        metric: "expectancyR by segment",
        value: best.metrics.expectancyR,
        n: best.metrics.observed + worst.metrics.observed,
        source: "capital_decision_outcomes",
      });
    } else {
      out.push({
        id,
        kind: "INSUFFICIENT",
        statement: `By ${label}: fewer than two segments reach ${MIN_GRADED_FOR_CAPITAL_RATE} observed outcomes — no comparison stated.`,
        metric: "segments above floor",
        value: shown.length,
        n: rows.length,
        source: "capital_decision_outcomes",
      });
    }
  };
  seg(rec.bySetupType, "setup type", "desk-by-setup");
  seg(rec.byRegime, "market regime", "desk-by-regime");
  seg(rec.byHorizon, "holding horizon", "desk-by-horizon");
  return out;
}

export const learningAnalystService = new LearningAnalystService();
