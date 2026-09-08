/**
 * RoleOrchestrator (Parts 2/3/12/13/24) — runs the multi-role AI pipeline over
 * the evidence graph, with:
 *
 *  - role-scoped evidence (each analyst sees ONLY its sections),
 *  - evidence-hash caching (ticker + evidenceHash + promptVersion + model ⇒
 *    reuse the stored valid row instead of re-calling OpenAI — Part 24),
 *  - failure isolation (a failed/invalid role is recorded and skipped; the
 *    deterministic decision is never blocked),
 *  - full audit persistence in ai_reviews (role, responseId, schemaVersion,
 *    validationResult, meta),
 *  - deterministic aiDisagreementScore + counterfactual conditions,
 *  - the Risk Committee (reasoning tier) receiving the ROLE FINDINGS, then
 *    clamped cap-only against the gate as always.
 */

import { createHash } from "crypto";
import { AppDataSource } from "../../config/database";
import { AiReview, DecisionSnapshot, Instrument } from "../../entities";
import { HttpError } from "../../types";
import { evidenceGraphService, EvidenceGraph } from "./EvidenceGraphService";
import { getOpenAIProvider } from "../reasoning/providerRegistry";
import { AiCallMeta } from "../reasoning/OpenAIProvider";
import {
  EventAnalysis,
  ForecastCritique,
  FundamentalAnalysis,
  ROLE_PROMPT_VERSION,
  TechnicalSynthesis,
} from "../reasoning/roles";
import { computeAiDisagreement, DisagreementReport } from "./disagreement";
import { deriveUpgradeConditions, UpgradeCondition, COUNTERFACTUAL_VERSION } from "./counterfactuals";
import { reasoningService } from "../reasoning/ReasoningService";
import { CommitteeResult } from "../reasoning/types";

const CACHE_TTL_HOURS = 24 * 7; // reuse valid role output for a week if evidence unchanged

export interface RoleRunReport {
  ticker: string;
  evidenceHash: string;
  ranAt: string;
  fundamental: FundamentalAnalysis | null;
  events: EventAnalysis | null;
  technical: TechnicalSynthesis | null;
  critic: ForecastCritique | null;
  disagreement: DisagreementReport;
  upgradeConditions: UpgradeCondition[];
  counterfactualExplanations: Array<{ conditionId: string; explanation: string }> | null;
  committee: CommitteeResult | null;
  /** Roles served from cache instead of a fresh OpenAI call. */
  cached: string[];
  /** Roles that failed (schema violation, timeout, outage) — recorded, never faked. */
  failures: Array<{ role: string; error: string }>;
}

export class RoleOrchestrator {
  /** Cache key = evidence content + prompt + model tier (Part 24). */
  private cacheHash(evidenceHash: string, model: string): string {
    return createHash("sha256").update(evidenceHash).update(ROLE_PROMPT_VERSION).update(model).digest("hex");
  }

  private async cachedRow(ticker: string, role: string, cacheHash: string): Promise<AiReview | null> {
    return AppDataSource.getRepository(AiReview)
      .createQueryBuilder("r")
      .where("r.ticker = :ticker AND r.role = :role AND r.input_hash = :h", { ticker, role, h: cacheHash })
      .andWhere("r.validation_result = 'valid'")
      .andWhere("r.created_at > now() - interval '" + CACHE_TTL_HOURS + " hours'")
      .orderBy("r.created_at", "DESC")
      .getOne();
  }

  private async persist(
    ticker: string,
    role: string,
    cacheHash: string,
    context: Record<string, unknown>,
    response: unknown,
    meta: AiCallMeta | null,
    validationError?: string
  ): Promise<AiReview> {
    const repo = AppDataSource.getRepository(AiReview);
    return repo.save(
      repo.create({
        ticker,
        role,
        promptVersion: meta?.promptVersion ?? ROLE_PROMPT_VERSION,
        modelName: meta?.modelSnapshot ?? meta?.model ?? "unknown",
        provider: "openai",
        inputHash: cacheHash,
        requestContext: context,
        response: (validationError ? { rejected: true } : (response as Record<string, unknown>)) ?? {},
        clamped: false,
        clampNotes: null,
        latencyMs: meta?.latencyMs ?? 0,
        tokensIn: meta?.tokensIn ?? null,
        tokensOut: meta?.tokensOut ?? null,
        responseId: meta?.responseId ?? null,
        schemaVersion: meta?.schemaVersion ?? null,
        validationResult: validationError ? "invalid" : "valid",
        meta: {
          modelSnapshot: meta?.modelSnapshot ?? null,
          evidenceSections: Object.keys(context),
          ...(validationError ? { validationError } : {}),
        },
      })
    );
  }

  /**
   * Run one role with cache + failure isolation. Returns null on failure —
   * the pipeline continues; the failure is recorded in ai_reviews AND in the
   * run report.
   */
  private async runRole<T>(opts: {
    ticker: string;
    role: string;
    model: string;
    graph: EvidenceGraph;
    payload: string;
    call: () => Promise<{ data: T; meta: AiCallMeta }>;
    report: RoleRunReport;
    force?: boolean;
  }): Promise<T | null> {
    const cacheHash = this.cacheHash(opts.graph.evidenceHash, opts.model);
    try {
      if (!opts.force) {
        const hit = await this.cachedRow(opts.ticker, opts.role, cacheHash);
        if (hit) {
          opts.report.cached.push(opts.role);
          return hit.response as T;
        }
      }
      const { data, meta } = await opts.call();
      await this.persist(opts.ticker, opts.role, cacheHash, { payloadBytes: opts.payload.length }, data, meta);
      return data;
    } catch (e) {
      const err = e as Error & { meta?: AiCallMeta };
      opts.report.failures.push({ role: opts.role, error: err.message.slice(0, 300) });
      try {
        await this.persist(opts.ticker, opts.role, cacheHash, { payloadBytes: opts.payload.length }, null, err.meta ?? null, err.message.slice(0, 500));
      } catch {
        /* audit-write failure must not break the pipeline */
      }
      return null;
    }
  }

  /**
   * Full pipeline for one ticker. Requires a published snapshot (AI reasons
   * about deterministic outputs — same contract as the committee).
   */
  async analyze(
    ticker: string,
    opts?: { positionContext?: Record<string, unknown> | null; force?: boolean; includeCommittee?: boolean }
  ): Promise<RoleRunReport> {
    const provider = getOpenAIProvider();
    if (!provider.isAvailable()) {
      throw new HttpError(
        503,
        "AI review unavailable (OPENAI_API_KEY not configured). The deterministic evidence-gated decision remains active."
      );
    }
    const t = ticker.trim().toUpperCase();
    const yahooTicker = /\.(NS|BO)$/.test(t) ? t : `${t}.NS`;

    const instrument = await AppDataSource.getRepository(Instrument)
      .createQueryBuilder("i")
      .where("i.yahoo_ticker = :yt", { yt: yahooTicker })
      .getOne();
    if (!instrument) throw new HttpError(404, `${ticker} is not in the supported instrument universe.`);
    const snapshot = await AppDataSource.getRepository(DecisionSnapshot).findOne({
      where: { instrumentId: instrument.id },
      order: { asOf: "DESC" },
    });
    if (!snapshot) {
      throw new HttpError(409, `No published decision snapshot for ${yahooTicker} — publish one first (the AI reviews deterministic outputs, it never replaces them).`);
    }

    const graph = await evidenceGraphService.build(yahooTicker, opts?.positionContext ?? null);
    const models = provider.models();
    const report: RoleRunReport = {
      ticker: yahooTicker,
      evidenceHash: graph.evidenceHash,
      ranAt: new Date().toISOString(),
      fundamental: null,
      events: null,
      technical: null,
      critic: null,
      disagreement: { score: 0, reasons: [] },
      upgradeConditions: [],
      counterfactualExplanations: null,
      committee: null,
      cached: [],
      failures: [],
    };

    // ── Stage: analysts (terra) — role-scoped evidence, run concurrently ────
    const fundPayload = evidenceGraphService.slice(graph, ["business", "fundamentals", "valuation"]);
    const eventPayload = evidenceGraphService.slice(graph, ["events"]);
    const techPayload = evidenceGraphService.slice(graph, ["technicalState", "regime"]);
    const knownEventIds = new Set(graph.sections.events.map((f) => f.id));

    const [fundamental, events, technical] = await Promise.all([
      this.runRole<FundamentalAnalysis>({
        ticker: yahooTicker,
        role: "fundamental_analyst",
        model: models.analyst,
        graph,
        payload: fundPayload,
        report,
        force: opts?.force,
        call: () => provider.analyzeFundamentals(fundPayload),
      }),
      graph.sections.events.length > 0
        ? this.runRole<EventAnalysis>({
            ticker: yahooTicker,
            role: "event_analyst",
            model: models.analyst,
            graph,
            payload: eventPayload,
            report,
            force: opts?.force,
            call: () => provider.analyzeEvents(eventPayload, knownEventIds),
          })
        : Promise.resolve(null),
      this.runRole<TechnicalSynthesis>({
        ticker: yahooTicker,
        role: "technical_analyst",
        model: models.analyst,
        graph,
        payload: techPayload,
        report,
        force: opts?.force,
        call: () => provider.analyzeTechnicalState(techPayload),
      }),
    ]);
    report.fundamental = fundamental;
    report.events = events;
    report.technical = technical;

    // ── Stage: Forecast Critic (sol) ─────────────────────────────────────────
    const criticPayload = evidenceGraphService.slice(graph, [
      "forecasts",
      "calibration",
      "modelHealth",
      "expectedValue",
      "risks",
    ]);
    report.critic = await this.runRole<ForecastCritique>({
      ticker: yahooTicker,
      role: "forecast_critic",
      model: models.reasoning,
      graph,
      payload: criticPayload,
      report,
      force: opts?.force,
      call: () => provider.critiqueForecast(criticPayload),
    });

    // ── Deterministic synthesis: disagreement + upgrade conditions ──────────
    report.disagreement = computeAiDisagreement({
      fundamental: report.fundamental,
      technical: report.technical,
      events: report.events,
      critic: report.critic,
    });
    report.upgradeConditions = deriveUpgradeConditions(snapshot);

    // ── Counterfactual explanations (analyst tier, ids validated) ───────────
    if (report.upgradeConditions.length > 0) {
      const conditionsJson = JSON.stringify({ version: COUNTERFACTUAL_VERSION, conditions: report.upgradeConditions });
      const knownConditionIds = new Set(report.upgradeConditions.map((c) => c.conditionId));
      const cf = await this.runRole({
        ticker: yahooTicker,
        role: "counterfactual",
        model: models.analyst,
        graph,
        payload: conditionsJson,
        report,
        force: opts?.force,
        call: () => provider.generateCounterfactualConditions(conditionsJson, knownConditionIds),
      });
      report.counterfactualExplanations = cf?.conditions ?? null;
    }

    // ── Risk Committee (sol) with the role findings attached (Part 13) ──────
    if (opts?.includeCommittee !== false) {
      try {
        const pc = (opts?.positionContext ?? null) as {
          holdsPosition?: boolean;
          purchasePrice?: number | null;
          investmentHorizon?: string | null;
          riskTolerance?: string | null;
        } | null;
        const { result } = await reasoningService.review(yahooTicker, pc, {
          roleFindings: {
            fundamental: report.fundamental,
            events: report.events ? { overallEventRisk: report.events.overallEventRisk, summary: report.events.summary } : null,
            technical: report.technical,
            critic: report.critic,
          },
          aiDisagreement: report.disagreement,
        });
        report.committee = result;
      } catch (e) {
        report.failures.push({ role: "risk_committee", error: e instanceof Error ? e.message.slice(0, 300) : String(e) });
      }
    }

    return report;
  }

  /** Latest stored role outputs for the UI (read-only; no OpenAI calls). */
  async latest(ticker: string): Promise<Record<string, { response: unknown; createdAt: string; model: string; validationResult: string | null } | null>> {
    const t = ticker.trim().toUpperCase();
    const yahooTicker = /\.(NS|BO)$/.test(t) ? t : `${t}.NS`;
    const roles = ["fundamental_analyst", "event_analyst", "technical_analyst", "forecast_critic", "counterfactual", "risk_committee"];
    const out: Record<string, { response: unknown; createdAt: string; model: string; validationResult: string | null } | null> = {};
    for (const role of roles) {
      const row = await AppDataSource.getRepository(AiReview)
        .createQueryBuilder("r")
        .where("r.ticker = :yt AND r.role = :role AND r.validation_result = 'valid'", { yt: yahooTicker, role })
        .orderBy("r.created_at", "DESC")
        .getOne();
      out[role] = row
        ? { response: row.response, createdAt: row.createdAt.toISOString(), model: row.modelName, validationResult: row.validationResult ?? null }
        : null;
    }
    return out;
  }
}

export const roleOrchestrator = new RoleOrchestrator();
