/**
 * ModelHealthService (completion directive, Phase 13) — LIVE model monitoring
 * over the immutable prediction_logs, per horizon.
 *
 * States (thresholds fixed here, chosen conservatively BEFORE observing the
 * live tape; changing them requires a validated study per Phase 18):
 *  - INSUFFICIENT_HISTORY: fewer than 10 overlap-adjusted resolved predictions
 *    at the horizon — monitoring cannot say anything yet, and says so.
 *  - SUSPENDED: rolling Brier > 0.35 (constant-50 scores 0.25) OR 80% band
 *    coverage < 55% — catastrophically off; a SUSPENDED model may not support
 *    a BUY (hard cap in decision-policy).
 *  - DEGRADED: rolling Brier > 0.28 OR coverage < 68% — drifting; displayed,
 *    and the drift is stated on every surface.
 *  - HEALTHY: within all tolerances.
 *
 * The OVERALL state is the WORST state among horizons with enough history
 * (conservative: a model catastrophically wrong at 1d live is not trusted at
 * 30d merely because 30d outcomes haven't matured yet). All metrics come from
 * resolved rows only; nothing is imputed or backfilled.
 */

import { AppDataSource } from "../../config/database";

export const MODEL_HEALTH_VERSION = "model-health-v1";

export type ModelHealthState = "HEALTHY" | "DEGRADED" | "SUSPENDED" | "INSUFFICIENT_HISTORY";

export const HEALTH_THRESHOLDS = {
  minEffectiveResolved: 10,
  degradedBrier: 0.28,
  suspendedBrier: 0.35,
  degradedCoveragePct: 68,
  suspendedCoveragePct: 55,
  windowDays: 90,
} as const;

/** Calendar horizon → trading-day overlap for effective-sample adjustment. */
const H_OVERLAP: Record<number, number> = { 1: 1, 3: 2, 7: 5, 15: 10, 30: 21 };

export interface HorizonHealth {
  horizonDays: number;
  resolvedCount: number;
  distinctDates: number;
  effectiveResolved: number;
  rollingBrier: number | null;
  rollingHitRatePct: number | null;
  rollingCoverage80Pct: number | null;
  state: ModelHealthState;
  reasons: string[];
}

export interface ModelHealthAssessment {
  version: string;
  modelVersion: string;
  asOf: string;
  windowDays: number;
  overallState: ModelHealthState;
  overallReasons: string[];
  horizons: HorizonHealth[];
}

interface Row {
  horizon_days: number;
  n: string;
  dates: string;
  brier: string | null;
  hits: string | null;
  covered: string | null;
  cov_n: string | null;
}

export class ModelHealthService {
  async assess(modelVersion = "quant-v1"): Promise<ModelHealthAssessment> {
    const T = HEALTH_THRESHOLDS;
    const rows: Row[] = await AppDataSource.query(
      `SELECT horizon_days,
              COUNT(*)::text AS n,
              COUNT(DISTINCT prediction_date)::text AS dates,
              AVG(POWER(predicted_probability - CASE WHEN actual_return > 0 THEN 1 ELSE 0 END, 2))::text AS brier,
              AVG(CASE WHEN (predicted_probability > 0.5) = (actual_return > 0) THEN 1.0 ELSE 0.0 END)::text AS hits,
              SUM(CASE WHEN low80_pct IS NOT NULL AND high80_pct IS NOT NULL
                        AND actual_return >= low80_pct AND actual_return <= high80_pct THEN 1 ELSE 0 END)::text AS covered,
              SUM(CASE WHEN low80_pct IS NOT NULL AND high80_pct IS NOT NULL THEN 1 ELSE 0 END)::text AS cov_n
         FROM prediction_logs
        WHERE model_version = $1
          AND actual_return IS NOT NULL
          AND predicted_probability IS NOT NULL
          AND horizon_days IS NOT NULL
          AND prediction_date > now() - ($2 || ' days')::interval
        GROUP BY horizon_days
        ORDER BY horizon_days`,
      [modelVersion, String(T.windowDays)]
    );

    const horizons: HorizonHealth[] = rows.map((r) => {
      const h = Number(r.horizon_days);
      const overlap = H_OVERLAP[h] ?? h;
      const distinctDates = Number(r.dates);
      const effective = Math.max(0, Math.floor(distinctDates / Math.max(1, overlap)));
      const brier = r.brier != null ? Math.round(Number(r.brier) * 10000) / 10000 : null;
      const hit = r.hits != null ? Math.round(Number(r.hits) * 1000) / 10 : null;
      const covN = Number(r.cov_n ?? 0);
      const coverage = covN > 0 ? Math.round((Number(r.covered) / covN) * 1000) / 10 : null;

      const reasons: string[] = [];
      let state: ModelHealthState;
      if (effective < T.minEffectiveResolved) {
        state = "INSUFFICIENT_HISTORY";
        reasons.push(
          `only ~${effective} overlap-adjusted resolved prediction(s) (${r.n} raw over ${distinctDates} dates; ` +
            `need ≥${T.minEffectiveResolved}) — live monitoring cannot assess this horizon yet`
        );
      } else if ((brier != null && brier > T.suspendedBrier) || (coverage != null && coverage < T.suspendedCoveragePct)) {
        state = "SUSPENDED";
        if (brier != null && brier > T.suspendedBrier)
          reasons.push(`rolling Brier ${brier} > ${T.suspendedBrier} (constant-50 scores 0.25) — suspension threshold breached`);
        if (coverage != null && coverage < T.suspendedCoveragePct)
          reasons.push(`80% band coverage ${coverage}% < ${T.suspendedCoveragePct}% — suspension threshold breached`);
      } else if ((brier != null && brier > T.degradedBrier) || (coverage != null && coverage < T.degradedCoveragePct)) {
        state = "DEGRADED";
        if (brier != null && brier > T.degradedBrier) reasons.push(`rolling Brier ${brier} > ${T.degradedBrier} — drifting`);
        if (coverage != null && coverage < T.degradedCoveragePct)
          reasons.push(`80% band coverage ${coverage}% < ${T.degradedCoveragePct}% — drifting`);
      } else {
        state = "HEALTHY";
        reasons.push(
          `rolling Brier ${brier ?? "n/a"} and coverage ${coverage ?? "n/a"}% within tolerances over ~${effective} independent windows`
        );
      }

      return {
        horizonDays: h,
        resolvedCount: Number(r.n),
        distinctDates,
        effectiveResolved: effective,
        rollingBrier: brier,
        rollingHitRatePct: hit,
        rollingCoverage80Pct: coverage,
        state,
        reasons,
      };
    });

    // Overall: worst state among horizons with history; none assessable ⇒ INSUFFICIENT_HISTORY.
    const rank: Record<ModelHealthState, number> = { HEALTHY: 0, DEGRADED: 1, SUSPENDED: 2, INSUFFICIENT_HISTORY: -1 };
    const assessable = horizons.filter((h) => h.state !== "INSUFFICIENT_HISTORY");
    let overallState: ModelHealthState;
    const overallReasons: string[] = [];
    if (assessable.length === 0) {
      overallState = "INSUFFICIENT_HISTORY";
      overallReasons.push(
        "no horizon has enough resolved live predictions yet — the walk-forward gates remain the only evidence, and they already refuse BUY without validated edge"
      );
    } else {
      const worst = assessable.reduce((a, b) => (rank[b.state] > rank[a.state] ? b : a));
      overallState = worst.state;
      overallReasons.push(`worst assessable horizon: ${worst.horizonDays}d → ${worst.state} (${worst.reasons[0] ?? ""})`);
      const immature = horizons.filter((h) => h.state === "INSUFFICIENT_HISTORY").map((h) => `${h.horizonDays}d`);
      if (immature.length > 0) overallReasons.push(`not yet assessable: ${immature.join(", ")} (outcomes still maturing)`);
    }

    return {
      version: MODEL_HEALTH_VERSION,
      modelVersion,
      asOf: new Date().toISOString(),
      windowDays: T.windowDays,
      overallState,
      overallReasons,
      horizons,
    };
  }
}

export const modelHealthService = new ModelHealthService();
