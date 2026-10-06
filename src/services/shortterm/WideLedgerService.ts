/**
 * WideLedgerService — the sub-₹100 lane's prospective ledger, grader, AI scout
 * runner and track record. Everything here is isolated from the radar's
 * evidence base by construction: it reads/writes ONLY wide_shadow_predictions.
 *
 *  - logPicks():        persist today's gradeable sub-₹100 picks (one per
 *                       identity; a re-scan is a no-op).
 *  - scoutShortlist():  run the DeepSeek scout over the top unscouted picks,
 *                       store the dossier, and apply its CAP-ONLY action to
 *                       finalDecision (never raised above deterministic).
 *  - resolveWideShadowOutcomes(): grade matured picks with the SAME
 *                       simulateBracket engine as every other lane.
 *  - trackRecord():     honest, deduped, sample-size-gated cohort stats.
 */

import { AppDataSource } from "../../config/database";
import { WideShadowPrediction } from "../../entities";
import { marketDataService } from "../market/MarketDataService";
import { simulateBracket, toAdjustedOhlc } from "./shadowFill";
import { HORIZON_TD, ShortTermHorizon, SHORT_TERM_VERSION, SHORT_TERM_POLICY_VERSION, SHORT_TERM_FEATURE_VERSION } from "./types";
import { scoutCandidate } from "./wideScout";
import {
  selectPicksToLog,
  applyAiCap,
  aggregateWideTrackRecord,
  LoggableRow,
  WideScreenEvidence,
  WideDecision,
  WideOutcomeRow,
  WideTrackRecord,
} from "./wideLedger";

const ENTRY_WINDOW = 3; // sessions to get filled before the plan lapses (mirrors the radar grader)

/** The minimum shape logPicks needs — passed by runWideScan to avoid an import
 *  cycle (wideScan imports THIS service). */
export interface LogPicksInput {
  horizon: string;
  rows: Array<
    LoggableRow & {
      /** Full ScreenRow for evidence capture (structurally typed). */
      screenRow?: Partial<WideScreenEvidence> & { symbol: string } & Record<string, unknown>;
    }
  >;
  fallbackAnchor: string;
}

export class WideLedgerService {
  async logPicks(input: LogPicksInput): Promise<{ logged: number; skipped: { ungradeable: number; noEvaluation: number } }> {
    const { picks, skipped } = selectPicksToLog(input.rows, input.fallbackAnchor);
    if (picks.length === 0) return { logged: 0, skipped };

    const repo = AppDataSource.getRepository(WideShadowPrediction);
    let logged = 0;
    for (const p of picks) {
      try {
        const result = await repo
          .createQueryBuilder()
          .insert()
          .values({
            ticker: p.ticker,
            symbol: p.symbol,
            anchorDate: p.anchorDate,
            setupType: p.setupType,
            horizon: input.horizon,
            modelVersion: SHORT_TERM_VERSION,
            policyVersion: SHORT_TERM_POLICY_VERSION,
            featureVersion: SHORT_TERM_FEATURE_VERSION,
            deterministicDecision: p.decision,
            finalDecision: p.decision, // equals deterministic until a scout caps it
            gatesPassed: p.gatesPassed,
            plan: p.plan as unknown as Record<string, unknown>,
            screenEvidence: (p.screen ?? null) as Record<string, unknown> | null,
          } as never)
          .orIgnore()
          .execute();
        if ((result.identifiers?.length ?? 0) > 0) logged++;
      } catch {
        /* a single bad row never sinks the batch */
      }
    }
    return { logged, skipped };
  }

  /**
   * Run the AI scout over the most recent UNSCOUTED picks and persist each
   * dossier + the capped finalDecision. Cap-only: finalDecision is recomputed
   * as applyAiCap(deterministic, capAction) — never above deterministic.
   */
  async scoutShortlist(limit = 20): Promise<{ scouted: number; capped: number; degraded: number }> {
    const repo = AppDataSource.getRepository(WideShadowPrediction);
    const pending = await repo
      .createQueryBuilder("p")
      .where("p.ai_dossier IS NULL")
      .orderBy("p.created_at", "DESC")
      .take(limit)
      .getMany();

    let scouted = 0;
    let capped = 0;
    let degraded = 0;
    for (const row of pending) {
      const ev = (row.screenEvidence ?? {}) as Partial<WideScreenEvidence>;
      const evidence: WideScreenEvidence = {
        symbol: row.symbol,
        companyName: ev.companyName ?? null,
        industry: ev.industry ?? null,
        price: ev.price ?? 0,
        medianTurnoverCr20: ev.medianTurnoverCr20 ?? null,
        medianTrades20: ev.medianTrades20 ?? null,
        avgDelivPct60: ev.avgDelivPct60 ?? null,
        delivTrendPp: ev.delivTrendPp ?? null,
        ret20Pct: ev.ret20Pct ?? null,
        ret60Pct: ev.ret60Pct ?? null,
        ret250Pct: ev.ret250Pct ?? null,
        vol60AnnPct: ev.vol60AnnPct ?? null,
        maxDrawdown1yPct: ev.maxDrawdown1yPct ?? null,
        pctFrom1yHigh: ev.pctFrom1yHigh ?? null,
        indices: ev.indices ?? [],
        surveillanceCodes: ev.surveillanceCodes ?? [],
        corporateActionSuspect: ev.corporateActionSuspect ?? false,
      };
      const result = await scoutCandidate(evidence);
      const det = row.deterministicDecision as WideDecision;
      const final = applyAiCap(det, result.dossier.capAction);
      row.aiDossier = { ...result.dossier, provider: result.provider, model: result.model, degraded: result.degraded, degradedReason: result.degradedReason };
      row.finalDecision = final;
      await repo.save(row);
      scouted++;
      if (final !== det) capped++;
      if (result.degraded) degraded++;
    }
    return { scouted, capped, degraded };
  }

  /** Grade matured picks — mirrors ResearchJobsService.resolveShadowOutcomes
   *  but over the wide ledger, so penny-stock outcomes stay out of the radar. */
  async resolveWideShadowOutcomes(): Promise<{ pending: number; resolved: number }> {
    const repo = AppDataSource.getRepository(WideShadowPrediction);
    const unresolved = await repo.createQueryBuilder("p").where("p.outcome IS NULL").take(2000).getMany();
    let resolved = 0;
    for (const p of unresolved) {
      const h = HORIZON_TD[p.horizon as ShortTermHorizon] ?? { max: 10 };
      const plan = p.plan as {
        entryType?: string;
        entryZoneLow?: number | null;
        entryZoneHigh?: number | null;
        entryTriggerPrice?: number | null;
        initialStop?: number | null;
        target1?: number | null;
        transactionCostPct?: number | null;
        estimatedSlippagePct?: number | null;
      };
      const stop = plan.initialStop ?? null;
      const target = plan.target1 ?? null;
      if (stop == null || target == null) continue;
      try {
        const bars = await marketDataService.getDailyBars(p.ticker, "6mo");
        const anchorIdx = bars.findIndex((b) => b.date > p.anchorDate);
        if (anchorIdx < 0 || anchorIdx + ENTRY_WINDOW + h.max >= bars.length) continue; // not matured — stays pending

        const forward = toAdjustedOhlc(bars.slice(anchorIdx + 1));
        const isTrigger = (plan.entryType ?? "").includes("BREAKOUT") || plan.entryTriggerPrice != null;
        const res = simulateBracket({
          forward,
          entryType: isTrigger ? "trigger" : "zone",
          zoneLow: plan.entryZoneLow ?? null,
          zoneHigh: plan.entryZoneHigh ?? null,
          triggerPrice: plan.entryTriggerPrice ?? null,
          stop,
          target,
          entryWindow: ENTRY_WINDOW,
          maxHold: h.max,
          roundTripCostPct: plan.transactionCostPct ?? 0.3,
          slippagePct: plan.estimatedSlippagePct ?? 0.2,
        });
        p.outcome = {
          outcome: res.outcome,
          filled: res.filled,
          ambiguous: res.ambiguous,
          resolutionSource: res.resolutionSource,
          fillPrice: res.fillPrice,
          exitPrice: res.exitPrice,
          returnPct: res.returnPct,
          realizedNetR: res.realizedNetR,
          conservativeNetR: res.conservativeNetR,
          bestCaseNetR: res.bestCaseNetR,
          netRMultiple: res.netRMultiple,
          mfeR: res.mfeR,
          maeR: res.maeR,
          holdingDays: res.holdingDays,
        };
        p.resolvedAt = new Date();
        await repo.save(p);
        resolved++;
      } catch {
        /* transient; retried next run */
      }
    }
    return { pending: unresolved.length - resolved, resolved };
  }

  async trackRecord(): Promise<WideTrackRecord> {
    // One vote per (ticker, anchor day): the LATEST pick that day, with its
    // resolved outcome. Deduped in SQL so a re-scan can't double-count.
    const rows: Array<Record<string, unknown>> = await AppDataSource.query(
      `SELECT DISTINCT ON (ticker, anchor_date)
              final_decision, outcome
         FROM wide_shadow_predictions
        WHERE outcome IS NOT NULL
        ORDER BY ticker, anchor_date, created_at DESC`
    );
    const [tot]: Array<Record<string, unknown>> = await AppDataSource.query(
      `SELECT COUNT(*)::int AS logged,
              COUNT(*) FILTER (WHERE outcome IS NOT NULL)::int AS resolved,
              COUNT(*) FILTER (WHERE outcome IS NULL)::int AS pending
         FROM wide_shadow_predictions`
    );

    const outcomes: WideOutcomeRow[] = rows.map((r) => {
      const o = (r.outcome ?? {}) as Record<string, unknown>;
      return {
        decision: String(r.final_decision) as WideDecision,
        outcomeStatus: String(o.outcome ?? "DATA_INVALID"),
        filled: o.filled === true,
        realizedNetR: o.realizedNetR == null ? null : Number(o.realizedNetR),
        returnPct: o.returnPct == null ? null : Number(o.returnPct),
      };
    });

    return aggregateWideTrackRecord(outcomes, {
      logged: Number(tot?.logged ?? 0),
      resolved: Number(tot?.resolved ?? 0),
      pending: Number(tot?.pending ?? 0),
    });
  }
}

export const wideLedgerService = new WideLedgerService();
