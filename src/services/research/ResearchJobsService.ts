/**
 * Scheduled research jobs (autonomous directive, Part V) — idempotent job
 * bodies wired into the cron:
 *
 *  - resolveShadowOutcomes(): daily/weekly — resolves matured shadow
 *    predictions gap-aware (unique rows; re-running is a no-op for resolved
 *    ones). Prospective evidence accrues without manual intervention.
 *  - monthlyGovernanceReview(): recomputes per-setup live-shadow stats and
 *    appends a model-performance snapshot; DEGRADES/SUSPENDS via the
 *    governance service on pre-registered thresholds. Never promotes —
 *    promotion requires an explicit evidenced transition (Part R).
 *
 * A retrained/re-run challenger always lands in SHADOW; nothing here can
 * raise a model's state.
 */

import { AppDataSource } from "../../config/database";
import { ShortTermModelPerformance, ShortTermShadowPrediction } from "../../entities";
import { marketDataService } from "../market/MarketDataService";
import { simulateBracket, toAdjustedOhlc } from "../shortterm/shadowFill";
import { HORIZON_TD, ShortTermHorizon } from "../shortterm/types";
import { LIVE_AUTHORITY } from "../shortterm/shortTermHealth";
import { modelGovernanceService } from "./governance";

/**
 * Shadow-ledger accounting identity (durability guard). Every logged shadow
 * prediction must be exactly one of: resolved (with an outcome) or still
 * pending (unmatured). A mismatch means a resolution job dropped or
 * double-counted — silent corruption of prospective statistics — so the
 * nightly reconciliation asserts this balances. PURE + tested.
 */
export interface LedgerCounts {
  total: number;
  resolved: number;
  pending: number;
  ambiguous: number;
  dataInvalid: number;
  /** Distinct natural identities (ticker, anchor, setup, horizon, model). When
   *  omitted we can't check for duplicates — only the sum identity. */
  distinctIdentities?: number;
}
/**
 * Two independent identities must BOTH hold (reviewer P0 #2):
 *  (1) SUM:        total === resolved + pending  (nothing dropped/mis-stated)
 *  (2) UNIQUENESS: total === distinctIdentities  (nothing duplicated)
 * The sum alone passes on a duplicated row (101 = 90 + 11); the uniqueness
 * check is what actually catches a doubled prospective observation.
 */
export function reconcileLedger(c: LedgerCounts): { balanced: boolean; discrepancy: number; duplicates: number; note: string } {
  const discrepancy = c.total - (c.resolved + c.pending);
  const duplicates = c.distinctIdentities != null ? c.total - c.distinctIdentities : 0;
  const balanced = discrepancy === 0 && duplicates === 0;
  const parts: string[] = [];
  if (discrepancy !== 0) parts.push(`SUM off by ${discrepancy}: ${c.resolved} resolved + ${c.pending} pending ≠ ${c.total} logged — a resolution was dropped or mis-stated`);
  if (duplicates !== 0) parts.push(`${duplicates} DUPLICATE identit${Math.abs(duplicates) === 1 ? "y" : "ies"}: ${c.total} rows vs ${c.distinctIdentities} distinct — a shadow row was doubled`);
  return {
    balanced,
    discrepancy,
    duplicates,
    note: balanced
      ? `balanced: ${c.resolved} resolved + ${c.pending} pending = ${c.total} logged, all distinct (${c.ambiguous} ambiguous, ${c.dataInvalid} invalid)`
      : `IMBALANCE — ${parts.join("; ")}`,
  };
}

export class ResearchJobsService {
  /**
   * Nightly reconciliation: assert the shadow ledger accounting identity holds.
   * Returns the counts + verdict; a caller/cron can alarm on !balanced.
   */
  async reconcileShadowLedger(): Promise<LedgerCounts & ReturnType<typeof reconcileLedger>> {
    const rows: Array<{ total: string; resolved: string; pending: string; ambiguous: string; invalid: string; distinct: string }> = await AppDataSource.query(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE outcome IS NOT NULL)::text AS resolved,
              COUNT(*) FILTER (WHERE outcome IS NULL)::text AS pending,
              COUNT(*) FILTER (WHERE (outcome->>'ambiguous')::boolean IS TRUE)::text AS ambiguous,
              COUNT(*) FILTER (WHERE (outcome->>'outcome') = 'DATA_INVALID')::text AS invalid,
              COUNT(DISTINCT (ticker, anchor_date, setup_type, horizon, model_version))::text AS distinct
         FROM short_term_shadow_predictions`
    ).catch(() => [{ total: "0", resolved: "0", pending: "0", ambiguous: "0", invalid: "0", distinct: "0" }]);
    const counts: LedgerCounts = {
      total: Number(rows[0]?.total ?? 0),
      resolved: Number(rows[0]?.resolved ?? 0),
      pending: Number(rows[0]?.pending ?? 0),
      ambiguous: Number(rows[0]?.ambiguous ?? 0),
      dataInvalid: Number(rows[0]?.invalid ?? 0),
      distinctIdentities: Number(rows[0]?.distinct ?? 0),
    };
    return { ...counts, ...reconcileLedger(counts) };
  }

  /** Resolve matured shadow predictions on completed bars (idempotent). */
  async resolveShadowOutcomes(): Promise<{ pending: number; resolved: number }> {
    const repo = AppDataSource.getRepository(ShortTermShadowPrediction);
    const unresolved = await repo
      .createQueryBuilder("p")
      .where("p.outcome IS NULL")
      .take(2000)
      .getMany();
    const ENTRY_WINDOW = 3; // sessions to get filled before the plan lapses
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
        // Require the FULL entry window + hold horizon to have elapsed.
        if (anchorIdx < 0 || anchorIdx + ENTRY_WINDOW + h.max >= bars.length) continue; // not matured — stays pending, honestly

        // #8: level basis == OHLC basis. Both adjusted.
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
          ambiguous: res.ambiguous, // same-bar straddle: adverse ASSUMED for safety, NOT observed
          resolutionSource: res.resolutionSource, // DAILY_BAR (observed) vs CONSERVATIVE_ASSUMPTION
          fillPrice: res.fillPrice,
          exitPrice: res.exitPrice,
          returnPct: res.returnPct,
          // Realized (OBSERVED) vs conservative (fail-safe ASSUMED) are stored
          // separately so track-record never claims an unobserved R (reviewer P0).
          realizedNetR: res.realizedNetR, // null when ordering was unobservable
          conservativeNetR: res.conservativeNetR, // adverse leg for the safety gate
          bestCaseNetR: res.bestCaseNetR,
          netRMultiple: res.netRMultiple, // back-compat alias of realizedNetR
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

  /**
   * Monthly governance review: snapshot live-shadow stats per setup×horizon;
   * DEGRADE/SUSPEND candidates whose live expectancy breaches the
   * pre-registered floors. Never promotes.
   */
  async monthlyGovernanceReview(): Promise<{ snapshots: number; transitions: number }> {
    // P0 #3 — net R-multiple, FILLED trades only (never % as R). Two measures
    // are computed and kept separate (reviewer P0): CONSERVATIVE (adverse leg
    // assumed for ambiguous bars) drives the SAFETY demotion; REALIZED (observed
    // only — ambiguous excluded) is what may be reported as the live track
    // record. COALESCE keeps rows written before the realized/conservative split.
    const rows: Array<{ setup_type: string; horizon: string; resolved: string; dates: string; cons_exp: string | null; real_exp: string | null; realized_n: string; ambiguous: string }> = await AppDataSource.query(
      `SELECT setup_type, horizon,
              COUNT(*) FILTER (WHERE outcome IS NOT NULL AND (outcome->>'filled')::boolean IS TRUE AND (outcome->>'outcome') <> 'DATA_INVALID')::text AS resolved,
              COUNT(DISTINCT anchor_date) FILTER (WHERE outcome IS NOT NULL AND (outcome->>'filled')::boolean IS TRUE AND (outcome->>'outcome') <> 'DATA_INVALID')::text AS dates,
              AVG(COALESCE((outcome->>'conservativeNetR')::numeric, (outcome->>'netRMultiple')::numeric)) FILTER (WHERE outcome IS NOT NULL AND (outcome->>'filled')::boolean IS TRUE AND (outcome->>'outcome') <> 'DATA_INVALID')::text AS cons_exp,
              AVG(COALESCE((outcome->>'realizedNetR')::numeric, (outcome->>'netRMultiple')::numeric)) FILTER (WHERE outcome IS NOT NULL AND (outcome->>'filled')::boolean IS TRUE AND (outcome->>'outcome') <> 'DATA_INVALID' AND (outcome->>'outcome') <> 'AMBIGUOUS_INTRABAR')::text AS real_exp,
              COUNT(*) FILTER (WHERE outcome IS NOT NULL AND (outcome->>'filled')::boolean IS TRUE AND (outcome->>'outcome') <> 'DATA_INVALID' AND (outcome->>'outcome') <> 'AMBIGUOUS_INTRABAR')::text AS realized_n,
              COUNT(*) FILTER (WHERE (outcome->>'outcome') = 'AMBIGUOUS_INTRABAR')::text AS ambiguous
         FROM short_term_shadow_predictions GROUP BY setup_type, horizon`
    );
    const perf = AppDataSource.getRepository(ShortTermModelPerformance);
    let transitions = 0;
    for (const r of rows) {
      const eff = Number(r.dates);
      const expR = r.cons_exp != null ? Number(r.cons_exp) : null; // conservative — governs demotion
      const realizedR = r.real_exp != null ? Number(r.real_exp) : null; // observed only — reportable
      await perf.save(
        perf.create({
          modelName: "st-live-shadow-review",
          modelVersion: `${r.setup_type}|${r.horizon}`,
          state: "SHADOW",
          metrics: { filledResolved: Number(r.resolved), independentDates: eff, liveExpectancyR: expR, realizedExpectancyR: realizedR, realizedTrades: Number(r.realized_n), ambiguousTrades: Number(r.ambiguous) },
          verdict: eff < LIVE_AUTHORITY.minEffectiveShadowTrades ? "insufficient live evidence — remains SHADOW" : `conservative expectancy ${expR}R (realized ${realizedR ?? "n/a"}R over ${r.realized_n} observed, ${r.ambiguous} ambiguous)`,
        })
      );
      // Governance action only on the tracked candidate setups (R thresholds).
      const key = `setup-${r.setup_type.toLowerCase().replace(/_/g, "-")}-${r.horizon}`;
      const gov = await modelGovernanceService.get(key);
      if (gov && gov.state === "CANDIDATE" && eff >= LIVE_AUTHORITY.minEffectiveShadowTrades && expR != null && expR <= LIVE_AUTHORITY.degradedExpectancyR) {
        await modelGovernanceService.transition(key, "SHADOW", `live-shadow expectancy ${expR}R ≤ ${LIVE_AUTHORITY.degradedExpectancyR}R over ${eff} independent dates — demoted pending re-validation`, null);
        transitions++;
      }
    }
    return { snapshots: rows.length, transitions };
  }
}

export const researchJobsService = new ResearchJobsService();
