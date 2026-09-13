/**
 * LiveEvaluationOrchestrator (reviewer priority 3) — the 10-minute coordinator.
 * One cycle: freeze data → evaluate the whole universe → diff vs the previous
 * checkpoint → material changes trigger the AI critic → rank → persist an
 * APPEND-ONLY revision per stock and an event per transition.
 *
 * Design rules baked in:
 *  - NO silent partial universe: if 11/151 fail, the cycle reports
 *    universeCoverage and flags lowConfidence — it never ranks 140 as if it
 *    were the whole market.
 *  - Ranking is computed BEFORE persistence so each revision carries its rank
 *    (revisions are append-only — never updated after the fact).
 *  - The action is capped by the data mode (a SCRAPED_SNAPSHOT can't BUY).
 *  - Coordination only: the analytical context builder and all persistence are
 *    injected, so this is deterministic and unit-testable with fakes.
 */

import { MarketDataProvider, Security, MarketSnapshot, snapshotToDataQuality, capActionByMode } from "./marketDataProvider";
import { LiveStockContext, StateDelta } from "./types";
import { computeStateDelta } from "./stateDelta";
import { detectMateriality, MaterialityResult } from "./materiality";
import { rankOpportunities, OpportunityRanking } from "./opportunityRanker";
import { hashCanonical } from "../decision/decisionSnapshot";

export interface RevisionInput {
  ticker: string;
  evaluatedAt: number;
  previousRevisionId: string | null;
  contextHash: string;
  deltaHash: string | null;
  assessment: string;
  setupState: string;
  expectedR: number | null;
  expectedRLowerBound: number | null;
  entryQuality: string;
  riskState: string;
  dataQuality: string;
  dataMode: string;
  gate: string;
  opportunityRank: number | null;
  actionableRank: number | null;
}

export interface EventInput {
  ticker: string;
  occurredAt: number;
  fromState: string;
  toState: string;
  trigger: string;
  evidenceIds: string[];
  predictionRevisionId: string | null;
}

export interface OrchestratorDeps {
  provider: MarketDataProvider;
  universe: Security[];
  now: () => number;
  /** Session/holiday awareness — a closed market skips the cycle honestly. */
  isMarketOpen: (now: number) => boolean;
  /** Analytical assembly (features/setup/EV/gate). Returns null if it cannot
   *  build a trustworthy context for this snapshot (e.g. unavailable data). */
  buildContext: (security: Security, snapshot: MarketSnapshot, previous: LiveStockContext | null) => LiveStockContext | null;
  /** Append-only persistence (injected; real repos in prod, fakes in tests). */
  saveRevision: (rev: RevisionInput) => Promise<{ id: string }>;
  saveEvent: (ev: EventInput) => Promise<void>;
  getPreviousRevisionId: (ticker: string) => Promise<string | null>;
  /** Fires only on a material change; the grounded AI critic plugs in here. */
  onMaterialChange?: (ctx: LiveStockContext, delta: StateDelta, materiality: MaterialityResult) => Promise<void>;
  /** Below this fraction the cycle is flagged low-confidence. */
  minCoverage?: number;
}

export interface CycleResult {
  evaluatedAt: number;
  skipped: boolean;
  reason?: string;
  universeSize: number;
  evaluated: number;
  covered: number;
  universeCoverage: number;
  lowConfidence: boolean;
  ranking: OpportunityRanking | null;
  revisionsWritten: number;
  eventsWritten: number;
  failures: Array<{ ticker: string; reason: string }>;
}

export class LiveEvaluationOrchestrator {
  private readonly deps: OrchestratorDeps;
  /** Previous checkpoint's context per ticker — drives the StateDelta. Held in
   *  memory (a long-running coordinator); on restart the first cycle simply has
   *  null deltas, which is honest rather than fabricated. */
  private readonly prev = new Map<string, LiveStockContext>();

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
  }

  async runCycle(): Promise<CycleResult> {
    const now = this.deps.now();
    const universeSize = this.deps.universe.length;
    const empty = (skipped: boolean, reason?: string): CycleResult => ({
      evaluatedAt: now, skipped, reason, universeSize, evaluated: 0, covered: 0, universeCoverage: 0,
      lowConfidence: true, ranking: null, revisionsWritten: 0, eventsWritten: 0, failures: [],
    });
    if (!this.deps.isMarketOpen(now)) return empty(true, "market closed");
    if (universeSize === 0) return empty(true, "empty universe");

    const snapshots = await this.deps.provider.fetchUniverse(this.deps.universe);
    const byTicker = new Map(snapshots.map((s) => [s.ticker, s]));

    // ── Pass 1: build contexts, diff, fire AI on material change ──────────────
    const contexts: LiveStockContext[] = [];
    const materialByTicker = new Map<string, { delta: StateDelta; mat: MaterialityResult }>();
    const failures: Array<{ ticker: string; reason: string }> = [];

    for (const sec of this.deps.universe) {
      const snap = byTicker.get(sec.ticker);
      if (!snap) { failures.push({ ticker: sec.ticker, reason: "no snapshot returned" }); continue; }
      if (snapshotToDataQuality(snap) === "UNAVAILABLE") { failures.push({ ticker: sec.ticker, reason: `data ${snap.quality}/${snap.freshness}` }); continue; }
      const previous = this.prev.get(sec.ticker) ?? null;
      const ctx = this.deps.buildContext(sec, snap, previous);
      if (!ctx) { failures.push({ ticker: sec.ticker, reason: "context could not be built" }); continue; }

      // Enforce the data-mode authority ceiling before anything downstream.
      ctx.gate = capActionByMode(ctx.gate, snap.mode);

      const delta = computeStateDelta(previous, ctx);
      const mat = detectMateriality(delta);
      if (mat.material) {
        materialByTicker.set(sec.ticker, { delta, mat });
        if (this.deps.onMaterialChange) {
          try { await this.deps.onMaterialChange(ctx, delta, mat); } catch { /* AI failure never breaks the cycle */ }
        }
      }
      contexts.push(ctx);
    }

    // ── Coverage: never rank a partial universe as if it were whole ───────────
    const covered = contexts.length;
    const universeCoverage = universeSize > 0 ? covered / universeSize : 0;
    const lowConfidence = universeCoverage < (this.deps.minCoverage ?? 0.9);

    const ranking = rankOpportunities(contexts);
    const oppRank = new Map(ranking.opportunity.map((r) => [r.securityId, r.rank]));
    const actRank = new Map(ranking.actionable.map((r) => [r.securityId, r.rank]));

    // ── Pass 2: append-only persistence (revisions carry their rank) ──────────
    let revisionsWritten = 0;
    let eventsWritten = 0;
    for (const ctx of contexts) {
      const previous = this.prev.get(ctx.securityId) ?? null;
      const delta = materialByTicker.get(ctx.ticker)?.delta ?? computeStateDelta(previous, ctx);
      const previousRevisionId = await this.deps.getPreviousRevisionId(ctx.ticker);
      const rev = await this.deps.saveRevision({
        ticker: ctx.ticker,
        evaluatedAt: now,
        previousRevisionId,
        contextHash: hashCanonical(ctx),
        deltaHash: previous ? hashCanonical(delta) : null,
        assessment: ctx.liveAssessment,
        setupState: ctx.setupState,
        expectedR: ctx.expectedR,
        expectedRLowerBound: ctx.expectedRLowerBound,
        entryQuality: ctx.entryQuality,
        riskState: ctx.riskState,
        dataQuality: ctx.dataQuality,
        dataMode: this.deps.provider.mode,
        gate: ctx.gate,
        opportunityRank: oppRank.get(ctx.securityId) ?? null,
        actionableRank: actRank.get(ctx.securityId) ?? null,
      });
      revisionsWritten++;

      // Transition event: only when the live assessment actually changed.
      if (previous && previous.liveAssessment !== ctx.liveAssessment) {
        const mat = materialByTicker.get(ctx.ticker)?.mat;
        await this.deps.saveEvent({
          ticker: ctx.ticker,
          occurredAt: now,
          fromState: previous.liveAssessment,
          toState: ctx.liveAssessment,
          trigger: mat?.reasons[0] ?? "ASSESSMENT_CHANGE",
          evidenceIds: mat?.reasons ?? [],
          predictionRevisionId: rev.id,
        });
        eventsWritten++;
      }
      this.prev.set(ctx.ticker, ctx);
    }

    return {
      evaluatedAt: now, skipped: false, universeSize, evaluated: contexts.length + failures.length,
      covered, universeCoverage, lowConfidence, ranking, revisionsWritten, eventsWritten, failures,
    };
  }
}
