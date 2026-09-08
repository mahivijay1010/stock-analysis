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
import { analysisCloses } from "../market/canonical";
import { HORIZON_TD, ShortTermHorizon } from "../shortterm/types";
import { LIVE_AUTHORITY } from "../shortterm/shortTermHealth";
import { modelGovernanceService } from "./governance";
import { round4 } from "./metrics";

export class ResearchJobsService {
  /** Resolve matured shadow predictions on completed bars (idempotent). */
  async resolveShadowOutcomes(): Promise<{ pending: number; resolved: number }> {
    const repo = AppDataSource.getRepository(ShortTermShadowPrediction);
    const unresolved = await repo
      .createQueryBuilder("p")
      .where("p.outcome IS NULL")
      .take(2000)
      .getMany();
    let resolved = 0;
    for (const p of unresolved) {
      const h = HORIZON_TD[p.horizon as ShortTermHorizon] ?? { max: 10 };
      const plan = p.plan as { entryZoneHigh?: number | null; entryTriggerPrice?: number | null; initialStop?: number | null; target1?: number | null };
      const entry = plan.entryTriggerPrice ?? plan.entryZoneHigh ?? null;
      const stop = plan.initialStop ?? null;
      const target = plan.target1 ?? null;
      if (entry == null || stop == null || target == null) continue;
      try {
        const bars = await marketDataService.getDailyBars(p.ticker, "6mo");
        const closes = analysisCloses(bars);
        const anchorIdx = bars.findIndex((b) => b.date > p.anchorDate);
        if (anchorIdx < 0 || anchorIdx + h.max >= bars.length) continue; // not matured — stays pending, honestly
        let outcome: "TARGET_FIRST" | "STOP_FIRST" | "TIMEOUT" = "TIMEOUT";
        let exitPrice = closes[Math.min(anchorIdx + h.max, bars.length - 1)];
        let mfe = 0;
        let mae = 0;
        let holdingDays = h.max;
        for (let k = anchorIdx; k <= anchorIdx + h.max; k++) {
          mfe = Math.max(mfe, (bars[k].high - entry) / entry);
          mae = Math.min(mae, (bars[k].low - entry) / entry);
          if (bars[k].open <= stop || bars[k].low <= stop) {
            outcome = "STOP_FIRST";
            exitPrice = Math.min(bars[k].open, stop);
            holdingDays = k - anchorIdx + 1;
            break;
          }
          if (bars[k].open >= target || bars[k].high >= target) {
            outcome = "TARGET_FIRST";
            exitPrice = Math.max(bars[k].open, target);
            holdingDays = k - anchorIdx + 1;
            break;
          }
        }
        p.outcome = {
          outcome,
          entryAssumed: entry,
          exitPrice: round4(exitPrice),
          returnPct: round4(((exitPrice - entry) / entry) * 100),
          mfePct: round4(mfe * 100),
          maePct: round4(mae * 100),
          holdingDays,
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
    const rows: Array<{ setup_type: string; horizon: string; resolved: string; dates: string; exp: string | null }> = await AppDataSource.query(
      `SELECT setup_type, horizon,
              COUNT(*) FILTER (WHERE outcome IS NOT NULL)::text AS resolved,
              COUNT(DISTINCT anchor_date) FILTER (WHERE outcome IS NOT NULL)::text AS dates,
              AVG((outcome->>'returnPct')::numeric) FILTER (WHERE outcome IS NOT NULL)::text AS exp
         FROM short_term_shadow_predictions GROUP BY setup_type, horizon`
    );
    const perf = AppDataSource.getRepository(ShortTermModelPerformance);
    let transitions = 0;
    for (const r of rows) {
      const eff = Number(r.dates);
      const exp = r.exp != null ? Number(r.exp) : null;
      await perf.save(
        perf.create({
          modelName: "st-live-shadow-review",
          modelVersion: `${r.setup_type}|${r.horizon}`,
          state: "SHADOW",
          metrics: { resolved: Number(r.resolved), independentDates: eff, liveExpectancyPct: exp },
          verdict: eff < LIVE_AUTHORITY.minEffectiveShadowTrades ? "insufficient live evidence — remains SHADOW" : `live expectancy ${exp}%`,
        })
      );
      // Governance action only on the tracked candidate setups.
      const key = `setup-${r.setup_type.toLowerCase().replace(/_/g, "-")}-${r.horizon}`;
      const gov = await modelGovernanceService.get(key);
      if (gov && gov.state === "CANDIDATE" && eff >= LIVE_AUTHORITY.minEffectiveShadowTrades && exp != null && exp < 0) {
        await modelGovernanceService.transition(key, "SHADOW", `live-shadow expectancy ${exp}% negative over ${eff} independent dates — demoted pending re-validation`, null);
        transitions++;
      }
    }
    return { snapshots: rows.length, transitions };
  }
}

export const researchJobsService = new ResearchJobsService();
