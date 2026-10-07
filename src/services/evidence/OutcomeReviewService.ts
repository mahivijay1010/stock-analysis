/**
 * OutcomeReviewService — the "predicted vs happened" feedback loop. Reads the
 * matured ledgers and answers the only question that matters: is any of this
 * working? It computes the calibration curve (do the probabilities mean what
 * they say), the realized hit rate by recommendation and horizon with Wilson
 * bounds, band coverage (did the actual land inside the stated 80% band), and
 * the "decisions worth reviewing" — the biggest surprises, which is where the
 * learning is. It also reports, honestly, which lanes have NOTHING graded yet.
 */

import { AppDataSource } from "../../config/database";
import { buildCalibration, CalibrationReport } from "./calibrationCurve";
import { wilsonLb95 } from "./selectivity";

export const OUTCOME_REVIEW_VERSION = "outcome-review-v1";

export interface CohortRate {
  key: string;
  n: number;
  hitRatePct: number;
  wilsonLb95Pct: number;
  meanActualReturnPct: number | null;
}

export interface SurpriseRow {
  ticker: string;
  recommendation: string;
  predictedReturnPct: number | null;
  actualReturnPct: number | null;
  surprisePct: number; // |actual − predicted|
  kind: string; // e.g. "big loss on a BUY", "big gain on an AVOID"
  outcomeDate: string | null;
}

export interface LaneMaturity {
  lane: string;
  logged: number;
  graded: number;
  note: string;
}

export interface OutcomeReview {
  version: string;
  generatedAt: string;
  laneA: {
    graded: number;
    overallHitRatePct: number | null;
    overallHitWilsonLb95Pct: number | null;
    meanPredictedReturnPct: number | null;
    meanActualReturnPct: number | null;
    band80CoveragePct: number | null;
    calibration: CalibrationReport;
    byRecommendation: CohortRate[];
    byHorizon: CohortRate[];
    surprises: SurpriseRow[];
  };
  lanes: LaneMaturity[];
  headline: string;
  caveat: string;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

interface GradedRow {
  ticker: string;
  rec: string;
  prob: string | null;
  exp: string | null;
  act: string | null;
  correct: boolean | null;
  horizon: number | null;
  lo: string | null;
  hi: string | null;
  od: string | null;
}

export class OutcomeReviewService {
  async review(): Promise<OutcomeReview> {
    // Lane A graded predictions (the only lane with a matured, probability-bearing
    // track record today). Everything here is OBSERVED, not forecast.
    const rows: GradedRow[] = await AppDataSource.query(
        `SELECT ticker, recommendation_given AS rec, predicted_probability AS prob, expected_return AS exp,
                actual_return AS act, prediction_correct AS correct, horizon_days AS horizon,
                low80_pct AS lo, high80_pct AS hi, to_char(outcome_date,'YYYY-MM-DD') AS od
           FROM prediction_logs
          WHERE actual_return IS NOT NULL`
      );

    const graded = rows.length;
    const calPoints = rows
      .filter((r) => num(r.prob) != null && num(r.act) != null)
      .map((r) => ({ predictedProb: num(r.prob) as number, won: (num(r.act) as number) >= 0 }));
    const calibration = buildCalibration(calPoints, { nBins: 10, minPerBin: 20 });

    const correctRows = rows.filter((r) => r.correct != null);
    const hits = correctRows.filter((r) => r.correct === true).length;
    const overallHit = correctRows.length ? Math.round((hits / correctRows.length) * 1000) / 10 : null;
    const overallWilson = correctRows.length ? wilsonLb95(hits, correctRows.length) : null;

    const preds = rows.map((r) => num(r.exp)).filter((v): v is number => v != null);
    const acts = rows.map((r) => num(r.act)).filter((v): v is number => v != null);
    const meanPred = preds.length ? Math.round((preds.reduce((a, b) => a + b, 0) / preds.length) * 1000) / 1000 : null;
    const meanAct = acts.length ? Math.round((acts.reduce((a, b) => a + b, 0) / acts.length) * 1000) / 1000 : null;

    // Band coverage: did the actual land inside the stated 80% band?
    const bandRows = rows.filter((r) => num(r.lo) != null && num(r.hi) != null && num(r.act) != null);
    const inBand = bandRows.filter((r) => (num(r.act) as number) >= (num(r.lo) as number) && (num(r.act) as number) <= (num(r.hi) as number)).length;
    const band80Coverage = bandRows.length >= 20 ? Math.round((inBand / bandRows.length) * 1000) / 10 : null;

    const byRecommendation = this.cohorts(correctRows, (r) => r.rec ?? "UNKNOWN");
    const byHorizon = this.cohorts(correctRows, (r) => `${r.horizon ?? "?"}d`);

    // Decisions worth reviewing: the biggest predicted-vs-actual surprises.
    const allSurprises: SurpriseRow[] = [];
    for (const r of rows) {
      const exp = num(r.exp);
      const act = num(r.act);
      if (exp == null || act == null) continue;
      let kind = "large miss vs expectation";
      if (r.rec === "BUY" && act < -3) kind = "big loss on a BUY";
      else if (r.rec === "AVOID" && act > 3) kind = "big gain on an AVOID";
      else if (r.rec === "BUY" && act > 5) kind = "big win on a BUY";
      allSurprises.push({ ticker: r.ticker, recommendation: r.rec ?? "UNKNOWN", predictedReturnPct: exp, actualReturnPct: act, surprisePct: Math.round(Math.abs(act - exp) * 100) / 100, kind, outcomeDate: r.od });
    }
    const surprises = allSurprises.sort((a, b) => b.surprisePct - a.surprisePct).slice(0, 15);

    const lanes = await this.laneMaturity(graded);

    const headline =
      graded === 0
        ? "No prediction has matured yet — there is no track record to review."
        : calibration.reliability === "OVERCONFIDENT"
          ? `Lane A: ${graded} matured. ${calibration.headline}`
          : `Lane A: ${graded} matured, ${overallHit}% directional hit rate (Wilson LB ${overallWilson != null ? (overallWilson * 100).toFixed(0) : "n/a"}%). ${calibration.headline}`;

    return {
      version: OUTCOME_REVIEW_VERSION,
      generatedAt: new Date().toISOString(),
      laneA: {
        graded,
        overallHitRatePct: overallHit,
        overallHitWilsonLb95Pct: overallWilson != null ? Math.round(overallWilson * 1000) / 10 : null,
        meanPredictedReturnPct: meanPred,
        meanActualReturnPct: meanAct,
        band80CoveragePct: band80Coverage,
        calibration,
        byRecommendation,
        byHorizon,
        surprises,
      },
      lanes,
      headline,
      caveat:
        "This is Lane A (the legacy quant engine) — the only lane with a matured, probability-bearing track record. Lane C, the sub-₹100 lane and the triple-barrier labels are still accruing (see lanes below). A good hit rate with poor calibration still means the probabilities cannot be trusted for sizing.",
    };
  }

  private cohorts(rows: GradedRow[], keyOf: (r: GradedRow) => string): CohortRate[] {
    const groups = new Map<string, GradedRow[]>();
    for (const r of rows) {
      const k = keyOf(r);
      const g = groups.get(k) ?? [];
      g.push(r);
      groups.set(k, g);
    }
    const out: CohortRate[] = [];
    for (const [key, g] of groups) {
      if (g.length < 10) continue; // withhold tiny cohorts
      const hits = g.filter((r) => r.correct === true).length;
      const acts = g.map((r) => num(r.act)).filter((v): v is number => v != null);
      const wlb = wilsonLb95(hits, g.length) ?? 0;
      out.push({
        key,
        n: g.length,
        hitRatePct: Math.round((hits / g.length) * 1000) / 10,
        wilsonLb95Pct: Math.round(wlb * 1000) / 10,
        meanActualReturnPct: acts.length ? Math.round((acts.reduce((a, b) => a + b, 0) / acts.length) * 1000) / 1000 : null,
      });
    }
    return out.sort((a, b) => b.n - a.n);
  }

  private async laneMaturity(laneAGraded: number): Promise<LaneMaturity[]> {
    const q = async (sql: string): Promise<number> => {
      try {
        const [r] = await AppDataSource.query(sql);
        return Number(Object.values(r ?? {})[0] ?? 0);
      } catch {
        return 0;
      }
    };
    const laneALogged = await q(`SELECT COUNT(*) FROM prediction_logs`);
    const laneCLogged = await q(`SELECT COUNT(*) FROM decision_outcome_ledger`);
    const laneCGraded = await q(`SELECT COUNT(*) FROM decision_outcome_ledger WHERE outcome_status IN ('GRADED','TRUNCATED')`);
    const wideLogged = await q(`SELECT COUNT(*) FROM wide_shadow_predictions`);
    const wideGraded = await q(`SELECT COUNT(*) FROM wide_shadow_predictions WHERE outcome IS NOT NULL`);
    const stLogged = await q(`SELECT COUNT(*) FROM short_term_shadow_predictions`);
    const stGraded = await q(`SELECT COUNT(*) FROM short_term_shadow_predictions WHERE outcome IS NOT NULL`);
    const labels = await q(`SELECT COUNT(*) FROM trade_labels`);

    return [
      { lane: "Lane A — quant engine", logged: laneALogged, graded: laneAGraded, note: "matured directional predictions with probabilities" },
      { lane: "Lane C — TradeGate v6", logged: laneCLogged, graded: laneCGraded, note: laneCGraded === 0 ? "published, none matured through the grader yet" : "graded decision snapshots" },
      { lane: "Sub-₹100 lane", logged: wideLogged, graded: wideGraded, note: wideGraded === 0 ? "picks logged, none matured yet" : "graded sub-₹100 picks" },
      { lane: "Short-Term radar", logged: stLogged, graded: stGraded, note: "shadow predictions" },
      { lane: "Triple-barrier labels", logged: labels, graded: labels, note: "training labels accruing for the meta-label model" },
    ];
  }
}

export const outcomeReviewService = new OutcomeReviewService();
