/**
 * DecisionOutcomeService — Lane C's grader and its Evidence-tab report.
 *
 * gradeMatured(): nightly. Finds published DecisionSnapshots with no ledger row
 * under the current grader version, replays their claims against subsequent
 * adjusted bars via the PURE gradeDecisionOutcome(), and appends one immutable
 * row per graded snapshot. PENDING snapshots (horizon not reached, feed
 * current) are simply left for a later night — no row, no guess.
 *
 * laneCReport(): cohort aggregates for the Evidence tab. Honesty rules:
 *  - one vote per (ticker, anchor date): the LATEST snapshot that day. A
 *    ticker analyzed five times in a day must not weigh 5× in the cohort.
 *  - rates carry sample size and a Wilson 95% lower bound, and are WITHHELD
 *    below MIN_GRADED_FOR_RATE outcomes — a mean over 4 trades is noise.
 *  - TRUNCATED rows are counted and shown, never silently merged into GRADED.
 */

import { AppDataSource } from "../../config/database";
import { DecisionOutcomeLedger } from "../../entities";
import { marketDataService } from "../market/MarketDataService";
import { istDateString } from "../forecast/dates";
import {
  gradeDecisionOutcome,
  DECISION_GRADER_VERSION,
  DEFAULT_HORIZON_DAYS,
  SnapshotClaim,
  DecisionStance,
  GraderBar,
} from "../decision/outcomeGrader";
import { wilsonLb95 } from "./selectivity";

export const LANE_C_REPORT_VERSION = "lane-c-report-v1";
/** Same bar as the rest of the evidence ledger: no rate below 10 outcomes. */
export const MIN_GRADED_FOR_LANE_C_RATE = 10;
/** Tickers fetched per nightly run — the remainder is REPORTED, never hidden. */
const MAX_TICKERS_PER_RUN = 60;

export interface GradeRunSummary {
  written: number;
  graded: number;
  truncated: number;
  entryUnavailable: number;
  dataInvalid: number;
  pending: number;
  tickersExamined: number;
  tickersRemaining: number;
}

export interface LaneCohort {
  decisionStatus: DecisionStance;
  observations: number; // deduped: latest snapshot per ticker-day
  meanNetReturnPct: number | null; // tradeable net (BUY frame) — null if withheld
  medianNetReturnPct: number | null;
  meanClaimGrossPct: number | null;
  hitRate: { hits: number; n: number; pct: number; wilsonLb95Pct: number } | null;
  hitRateWithheldReason: string | null;
  band80: { inside: number; n: number; pct: number } | null;
  meanEvErrorPct: number | null;
  truncated: number;
  note: string;
}

export interface LaneCReport {
  version: string;
  graderVersion: string;
  generatedAt: string;
  totals: {
    snapshotsPublished: number;
    ledgerRows: number;
    gradedObservations: number; // deduped, GRADED+TRUNCATED
    ungradedMatured: number; // matured (approx) but not yet graded
    pendingMaturity: number;
    entryUnavailable: number;
    dataInvalid: number;
  };
  cohorts: LaneCohort[];
  method: string[];
  headline: string;
}

interface SnapshotRow {
  id: string;
  instrument_id: string;
  ticker: string;
  decision_status: DecisionStance;
  as_of: Date;
  expected_value: Record<string, unknown> | null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/** One deduped graded observation (latest snapshot per ticker-day). */
export interface CohortInputRow {
  decision_status: DecisionStance;
  outcome_status: string;
  tradeable_net_return_pct: unknown;
  claim_gross_return_pct: unknown;
  direction_hit: boolean | null;
  within_band80: boolean | null;
  ev_error_pct: unknown;
}

/** PURE cohort aggregation — every rate carries n and a Wilson lower bound,
 *  and is withheld (null + reason) below the minimum sample. */
export function aggregateCohorts(rows: CohortInputRow[]): LaneCohort[] {
  const order: DecisionStance[] = ["BUY_CANDIDATE", "WAIT", "AVOID_NEW_ENTRY", "INSUFFICIENT_EVIDENCE"];
  const mean = (xs: number[]): number | null => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);
  const median = (xs: number[]): number | null => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
    return Math.round(m * 100) / 100;
  };

  const cohorts: LaneCohort[] = [];
  for (const status of order) {
    const cohort = rows.filter((r) => r.decision_status === status);
    const nets = cohort.map((r) => num(r.tradeable_net_return_pct)).filter((v): v is number => v != null);
    const claims = cohort.map((r) => num(r.claim_gross_return_pct)).filter((v): v is number => v != null);
    const evErrs = cohort.map((r) => num(r.ev_error_pct)).filter((v): v is number => v != null);
    const hitRows = cohort.filter((r) => r.direction_hit !== null && r.direction_hit !== undefined);
    const hits = hitRows.filter((r) => r.direction_hit === true).length;
    const bandRows = cohort.filter((r) => r.within_band80 !== null && r.within_band80 !== undefined);
    const inside = bandRows.filter((r) => r.within_band80 === true).length;
    const truncated = cohort.filter((r) => r.outcome_status === "TRUNCATED").length;

    const enough = cohort.length >= MIN_GRADED_FOR_LANE_C_RATE;
    const hasHitDef = status === "BUY_CANDIDATE" || status === "AVOID_NEW_ENTRY";
    const wilson = enough && hitRows.length >= MIN_GRADED_FOR_LANE_C_RATE ? wilsonLb95(hits, hitRows.length) : null;
    cohorts.push({
      decisionStatus: status,
      observations: cohort.length,
      meanNetReturnPct: enough ? mean(nets) : null,
      medianNetReturnPct: enough ? median(nets) : null,
      meanClaimGrossPct: enough ? mean(claims) : null,
      hitRate:
        hasHitDef && wilson != null && hitRows.length > 0
          ? { hits, n: hitRows.length, pct: Math.round((hits / hitRows.length) * 1000) / 10, wilsonLb95Pct: Math.round(wilson * 1000) / 10 }
          : null,
      hitRateWithheldReason: hasHitDef
        ? wilson == null
          ? `withheld — ${hitRows.length} graded outcome${hitRows.length === 1 ? "" : "s"} < ${MIN_GRADED_FOR_LANE_C_RATE} minimum`
          : null
        : "abstention cohort — no hit definition; distribution shown for context only",
      band80: enough && bandRows.length >= MIN_GRADED_FOR_LANE_C_RATE ? { inside, n: bandRows.length, pct: Math.round((inside / bandRows.length) * 1000) / 10 } : null,
      meanEvErrorPct: enough ? mean(evErrs) : null,
      truncated,
      note:
        status === "BUY_CANDIDATE"
          ? "acted cohort: next-open entry, net of the claim's own cost model"
          : status === "AVOID_NEW_ENTRY"
            ? "hit = the stock did NOT rise over the horizon (gross, no trade ⇒ no costs)"
            : "counterfactual only — no trade was recommended",
    });
  }
  return cohorts;
}

export class DecisionOutcomeService {
  /** Extract the claim fields the grader needs from a snapshot row. */
  private toClaim(row: SnapshotRow): SnapshotClaim {
    const ev = row.expected_value ?? null;
    return {
      snapshotId: row.id,
      ticker: row.ticker,
      decisionStatus: row.decision_status,
      asOfDate: istDateString(new Date(row.as_of)),
      horizonDays: num(ev?.["horizonDays"]) ?? DEFAULT_HORIZON_DAYS,
      evAfterCostsPct: num(ev?.["evAfterCostsPct"]),
      p10RetPct: num(ev?.["expectedDownsidePct"]),
      p90RetPct: num(ev?.["expectedUpsidePct"]),
      transactionCostPct: num(ev?.["transactionCostPct"]),
    };
  }

  async gradeMatured(todayIst = istDateString(new Date())): Promise<GradeRunSummary> {
    // Oldest tickers first so the backlog drains deterministically. Only
    // snapshots old enough to possibly have a next-session bar are candidates.
    const rows: SnapshotRow[] = await AppDataSource.query(
      `SELECT s.id, s.instrument_id, s.ticker, s.decision_status, s.as_of, s.expected_value
         FROM decision_snapshots s
        WHERE s.as_of < now() - interval '1 day'
          AND NOT EXISTS (SELECT 1 FROM decision_outcome_ledger l
                           WHERE l.snapshot_id = s.id AND l.grader_version = $1)
        ORDER BY s.as_of ASC`,
      [DECISION_GRADER_VERSION]
    );

    const byTicker = new Map<string, SnapshotRow[]>();
    for (const r of rows) {
      const list = byTicker.get(r.ticker) ?? [];
      list.push(r);
      byTicker.set(r.ticker, list);
    }
    const tickers = [...byTicker.keys()];
    const examined = tickers.slice(0, MAX_TICKERS_PER_RUN);

    const summary: GradeRunSummary = {
      written: 0,
      graded: 0,
      truncated: 0,
      entryUnavailable: 0,
      dataInvalid: 0,
      pending: 0,
      tickersExamined: examined.length,
      tickersRemaining: tickers.length - examined.length,
    };

    const repo = AppDataSource.getRepository(DecisionOutcomeLedger);
    for (const ticker of examined) {
      let bars: GraderBar[];
      try {
        bars = (await marketDataService.getDailyBars(ticker, "2y")) as GraderBar[];
      } catch (err) {
        console.warn(`⚠️ lane-c grade skipped ${ticker}:`, (err as Error).message);
        continue;
      }
      for (const row of byTicker.get(ticker) ?? []) {
        const outcome = gradeDecisionOutcome(this.toClaim(row), bars, todayIst);
        if (outcome.outcomeStatus === "PENDING") {
          summary.pending++;
          continue;
        }
        await repo.save(
          repo.create({
            snapshotId: row.id,
            instrumentId: row.instrument_id,
            ticker: row.ticker,
            decisionStatus: row.decision_status,
            asOf: new Date(row.as_of),
            asOfDate: outcome.anchorDate ?? outcome.asOfDate,
            horizonDays: outcome.horizonDays,
            graderVersion: outcome.graderVersion,
            outcomeStatus: outcome.outcomeStatus,
            entryDate: outcome.entryDate,
            terminalDate: outcome.terminalDate,
            sessionsObserved: outcome.sessionsObserved,
            claimGrossReturnPct: outcome.claimGrossReturnPct != null ? String(outcome.claimGrossReturnPct) : null,
            tradeableGrossReturnPct: outcome.tradeableGrossReturnPct != null ? String(outcome.tradeableGrossReturnPct) : null,
            tradeableNetReturnPct: outcome.tradeableNetReturnPct != null ? String(outcome.tradeableNetReturnPct) : null,
            costPct: outcome.costPct != null ? String(outcome.costPct) : null,
            entryGapPct: outcome.entryGapPct != null ? String(outcome.entryGapPct) : null,
            directionHit: outcome.directionHit,
            withinBand80: outcome.withinBand80,
            evErrorPct: outcome.evErrorPct != null ? String(outcome.evErrorPct) : null,
            claims: {
              evAfterCostsPct: num(row.expected_value?.["evAfterCostsPct"]),
              p10RetPct: num(row.expected_value?.["expectedDownsidePct"]),
              p90RetPct: num(row.expected_value?.["expectedUpsidePct"]),
              transactionCostPct: num(row.expected_value?.["transactionCostPct"]),
            },
            flags: outcome.flags,
          })
        );
        summary.written++;
        if (outcome.outcomeStatus === "GRADED") summary.graded++;
        else if (outcome.outcomeStatus === "TRUNCATED") summary.truncated++;
        else if (outcome.outcomeStatus === "ENTRY_UNAVAILABLE") summary.entryUnavailable++;
        else summary.dataInvalid++;
      }
    }
    return summary;
  }

  async laneCReport(): Promise<LaneCReport> {
    const [tot]: Array<Record<string, unknown>> = await AppDataSource.query(
      `SELECT (SELECT COUNT(*) FROM decision_snapshots) AS published,
              (SELECT COUNT(*) FROM decision_outcome_ledger WHERE grader_version = $1) AS ledger_rows,
              (SELECT COUNT(*) FROM decision_snapshots s
                WHERE NOT EXISTS (SELECT 1 FROM decision_outcome_ledger l
                                   WHERE l.snapshot_id = s.id AND l.grader_version = $1)
                  AND s.as_of < now() - interval '31 days') AS ungraded_matured,
              (SELECT COUNT(*) FROM decision_snapshots s
                WHERE NOT EXISTS (SELECT 1 FROM decision_outcome_ledger l
                                   WHERE l.snapshot_id = s.id AND l.grader_version = $1)
                  AND s.as_of >= now() - interval '31 days') AS pending_maturity,
              (SELECT COUNT(*) FROM decision_outcome_ledger WHERE grader_version = $1 AND outcome_status = 'ENTRY_UNAVAILABLE') AS entry_unavailable,
              (SELECT COUNT(*) FROM decision_outcome_ledger WHERE grader_version = $1 AND outcome_status = 'DATA_INVALID') AS data_invalid`,
      [DECISION_GRADER_VERSION]
    );

    // One vote per (ticker, anchor date): the LATEST publication that day.
    const rows: Array<Record<string, unknown>> = await AppDataSource.query(
      `SELECT DISTINCT ON (ticker, as_of_date)
              decision_status, outcome_status, tradeable_net_return_pct,
              claim_gross_return_pct, direction_hit, within_band80, ev_error_pct
         FROM decision_outcome_ledger
        WHERE grader_version = $1 AND outcome_status IN ('GRADED', 'TRUNCATED')
        ORDER BY ticker, as_of_date, as_of DESC`,
      [DECISION_GRADER_VERSION]
    );

    const cohorts = aggregateCohorts(rows as unknown as CohortInputRow[]);

    const buy = cohorts[0];
    const gradedObs = rows.length;
    const headline =
      gradedObs === 0
        ? `TradeGate v6 has published ${Number(tot?.published ?? 0)} decisions but ZERO have matured through the grader yet — this lane still has no track record. Nothing here endorses acting on its BUYs.`
        : buy.hitRate
          ? `Over ${gradedObs} deduped graded decisions, BUY_CANDIDATE hit ${buy.hitRate.pct}% net of costs (Wilson 95% lower bound ${buy.hitRate.wilsonLb95Pct}%, n=${buy.hitRate.n}).`
          : `${gradedObs} graded decisions so far, but the BUY cohort is below the ${MIN_GRADED_FOR_LANE_C_RATE}-outcome minimum — its hit rate is withheld, not hidden: it does not exist yet.`;

    return {
      version: LANE_C_REPORT_VERSION,
      graderVersion: DECISION_GRADER_VERSION,
      generatedAt: new Date().toISOString(),
      totals: {
        snapshotsPublished: Number(tot?.published ?? 0),
        ledgerRows: Number(tot?.ledger_rows ?? 0),
        gradedObservations: gradedObs,
        ungradedMatured: Number(tot?.ungraded_matured ?? 0),
        pendingMaturity: Number(tot?.pending_maturity ?? 0),
        entryUnavailable: Number(tot?.entry_unavailable ?? 0),
        dataInvalid: Number(tot?.data_invalid ?? 0),
      },
      cohorts,
      method: [
        "Grades the published claim, never a retro-fitted bracket: direction/EV at the stored horizon (default 30 calendar days).",
        "ACTION frame enters at the NEXT session's OPEN — never the same close the decision was computed from.",
        "Net returns deduct the snapshot's own stored transaction-cost model (imputed + flagged when absent).",
        "Returns are computed on the adjusted basis; splits/dividends inside the window are flagged, not absorbed.",
        "One vote per (ticker, day): the latest snapshot that day — repeat analyses don't multiply weight.",
        `Rates require ≥${MIN_GRADED_FOR_LANE_C_RATE} outcomes and carry a Wilson 95% lower bound; TRUNCATED outcomes are counted separately.`,
        "AMBIGUOUS_INTRABAR cannot arise in whole-session grading; its analogues here are ENTRY_UNAVAILABLE and TRUNCATED.",
      ],
      headline,
    };
  }
}

export const decisionOutcomeService = new DecisionOutcomeService();
