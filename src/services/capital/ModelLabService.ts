/**
 * ModelLabService — a READ-ONLY view over the experiment registry that already
 * exists (experiment_runs, model_governance + transitions, calibrators,
 * short_term_model_performance, learning_lessons, daily_direction_policy) plus
 * the desk's own track record. It evaluates the promotion gates against the
 * measured sample sizes and says, explicitly, when there is not enough
 * evidence. It cannot promote anything: promotions happen only through
 * modelGovernanceService.transition() with an evidence run id.
 */

import { AppDataSource } from "../../config/database";
import { LIVE_AUTHORITY } from "../shortterm/shortTermHealth";
import { SETUP_PROMOTION } from "../shortterm/setupEvidence";
import { capitalOutcomeService } from "./CapitalOutcomeService";
import { CapitalTrackRecord, MIN_GRADED_FOR_CAPITAL_RATE } from "./capitalTrackRecord";

export interface PromotionGate {
  id: string;
  rule: string;
  required: string;
  measured: string;
  passed: boolean | null; // null = cannot be evaluated yet
}

export interface ModelLabView {
  version: string;
  generatedAt: string;
  pipeline: Array<{ stage: string; status: string; note: string }>;
  currentModels: Array<{ key: string; scope: string; state: string; updatedAt: string | null; reasons: string[] }>;
  experiments: Array<{ id: string; name: string; kind: string; modelVersion: string | null; status: string; startedAt: string | null; finishedAt: string | null; metrics: Record<string, unknown> | null; notes: string | null }>;
  promotions: Array<{ modelKey: string; from: string; to: string; reason: string; evidenceRunId: string | null; at: string }>;
  calibrators: Array<{ modelName: string; horizonDays: number; promoted: boolean; verdict: string | null; effectiveSamples: number | null; brierBefore: number | null; brierAfter: number | null }>;
  setupEvidence: { asOf: string | null; cells: Array<Record<string, unknown>>; verdict: string | null };
  shadowModels: Array<{ modelName: string; state: string; verdict: string | null; metrics: Record<string, unknown> }>;
  lessons: Array<{ category: string; observation: string; lesson: string; actionTaken: string; createdAt: string }>;
  capitalTrackRecord: CapitalTrackRecord;
  promotionGates: PromotionGate[];
  evidenceVerdict: string;
  policy: string[];
}

export class ModelLabService {
  async view(): Promise<ModelLabView> {
    const [gov, trans, exps, cals, perf, lessons, record] = await Promise.all([
      this.q(`SELECT model_key, scope, state, reasons, updated_at FROM model_governance ORDER BY updated_at DESC`),
      this.q(`SELECT model_key, from_state, to_state, reason, evidence_run_id, created_at FROM model_governance_transitions ORDER BY created_at DESC LIMIT 30`),
      this.q(`SELECT id, name, kind, model_version, status, started_at, finished_at, metrics, notes FROM experiment_runs ORDER BY started_at DESC LIMIT 25`),
      this.q(`SELECT model_name, horizon_days, promoted, verdict, effective_samples, brier_before, brier_after FROM calibrators ORDER BY created_at DESC LIMIT 20`),
      this.q(`SELECT model_name, model_version, state, metrics, verdict, created_at FROM short_term_model_performance ORDER BY created_at DESC LIMIT 12`),
      this.q(`SELECT category, observation, lesson, action_taken, created_at FROM learning_lessons ORDER BY created_at DESC LIMIT 20`),
      capitalOutcomeService.trackRecord().catch(() => null),
    ]);
    const setupRow = perf.find((p) => p.model_name === "st-setup-expectancy");
    const cells = (setupRow?.metrics as Record<string, unknown> | undefined)?.cells;
    const shadow = perf.filter((p) => p.model_name !== "st-setup-expectancy");
    const rec = record ?? emptyRecord();
    const resolved = rec.overall.observed;
    const tierACells = Array.isArray(cells) ? (cells as Array<Record<string, unknown>>).filter((c) => c.evidenceStrength === "A").length : 0;
    const gates: PromotionGate[] = [
      {
        id: "desk-sample",
        rule: "Money Desk outcomes before any desk-policy change",
        required: `≥ ${MIN_GRADED_FOR_CAPITAL_RATE} observed outcomes`,
        measured: `${resolved} observed`,
        passed: resolved >= MIN_GRADED_FOR_CAPITAL_RATE ? true : null,
      },
      {
        id: "desk-excess",
        rule: "Mean excess return over NIFTY, 95% CI lower bound > 0",
        required: "> 0",
        measured: rec.overall.benchmarkExcessPct.ci95 ? `CI [${rec.overall.benchmarkExcessPct.ci95[0]}, ${rec.overall.benchmarkExcessPct.ci95[1]}]` : "not evaluable",
        passed: rec.overall.benchmarkExcessPct.ci95 ? rec.overall.benchmarkExcessPct.ci95[0] > 0 : null,
      },
      {
        id: "setup-tier-a",
        rule: "Setup evidence tier A (expectancy after costs, CI, independent dates, BH significance)",
        required: `≥ ${SETUP_PROMOTION.minIndependentDates} independent dates, expectancy ≥ ${SETUP_PROMOTION.minExpectancyAfterCostsR}R, CI lower > ${SETUP_PROMOTION.ciLowerMustExceed}, P(>0) ≥ ${SETUP_PROMOTION.minProbExpectancyPositive}`,
        measured: Array.isArray(cells) ? `${tierACells} of ${(cells as unknown[]).length} setup×horizon cells at tier A` : "no setup-evidence run on file",
        passed: Array.isArray(cells) ? tierACells > 0 : null,
      },
      {
        id: "live-authority",
        rule: "Live authority per setup (prospective shadow confirmation)",
        required: `≥ ${LIVE_AUTHORITY.minEffectiveShadowTrades} independent resolved shadow trades with conservative expectancy > ${LIVE_AUTHORITY.degradedExpectancyR}R`,
        measured: shadow.length ? shadow.map((s) => `${s.model_name}: ${s.state}`).join("; ") : "no shadow tracker rows",
        passed: shadow.some((s) => s.state === "HEALTHY") ? true : shadow.length ? false : null,
      },
      {
        id: "forecast-brier",
        rule: "Forecast challenger: better OOS Brier than champion with bootstrap 80% CI excluding zero, BSS vs constant-50 > 0, ECE not worse, ≥ 10 effective samples, no leakage, registered run",
        required: "all seven promotion-policy rules",
        measured: trans.length ? `last transition: ${trans[0].model_key} ${trans[0].from_state}→${trans[0].to_state}` : "no transitions recorded",
        passed: gov.some((g) => g.state === "CHAMPION" && String(g.model_key).includes("challenger")) ? true : trans.length ? false : null,
      },
    ];
    const unevaluable = gates.filter((g) => g.passed === null).length;
    const evidenceVerdict =
      resolved < MIN_GRADED_FOR_CAPITAL_RATE
        ? `Only ${resolved} resolved desk outcomes. No model update recommended — the gates cannot be evaluated below ${MIN_GRADED_FOR_CAPITAL_RATE}.`
        : gates.every((g) => g.passed === true)
          ? "All evaluable gates pass. A promotion review may be opened; promotion still requires a registered experiment run and a governance transition with a reason."
          : `${gates.filter((g) => g.passed === false).length} gate(s) fail, ${unevaluable} cannot be evaluated yet. Incumbent stays — that is the process working, not failing.`;
    return {
      version: "model-lab-v1",
      generatedAt: new Date().toISOString(),
      pipeline: [
        { stage: "CURRENT MODEL", status: gov.find((g) => g.state === "CHAMPION")?.model_key ? "quant-v1 + st-setup-expectancy (champion)" : "quant-v1 (incumbent)", note: "Deterministic engine; probability display withheld (no calibrated model promoted)." },
        { stage: "CHALLENGER", status: `${exps.filter((e) => e.kind === "challenger").length} challenger runs on file`, note: "Nightly daily-challenger (pre-registered 2026-10-01) and calibration refresh." },
        { stage: "BACKTEST", status: Array.isArray(cells) ? `${(cells as unknown[]).length} setup cells` : "none", note: "Setup expectancy study on sealed data; BACKTEST_PROVISIONAL stage (no PIT universe)." },
        { stage: "PURGED / WALK-FORWARD", status: exps.some((e) => e.kind === "champion-eval") ? "walk-forward harness runs recorded" : "none", note: "Purged + embargoed chronological splits; test segment reported once." },
        { stage: "OUT-OF-SAMPLE", status: exps.length ? "see experiments" : "none", note: "Select on validation, report test once." },
        { stage: "SHADOW TRADING", status: shadow.length ? shadow.map((s) => s.state).join("/") : "no shadow rows", note: "Prospective ledgers: radar, sub-₹100 lane, paper pilot, Money Desk." },
        { stage: "PROMOTION REVIEW", status: evidenceVerdict.startsWith("All") ? "may open" : "closed", note: "Only modelGovernanceService.transition() with an evidence run id can promote. The LLM cannot." },
      ],
      currentModels: gov.map((g) => ({ key: String(g.model_key), scope: String(g.scope), state: String(g.state), updatedAt: g.updated_at ? new Date(String(g.updated_at)).toISOString() : null, reasons: Array.isArray(g.reasons) ? (g.reasons as string[]) : [] })),
      experiments: exps.map((e) => ({ id: String(e.id), name: String(e.name), kind: String(e.kind), modelVersion: e.model_version ? String(e.model_version) : null, status: String(e.status), startedAt: e.started_at ? new Date(String(e.started_at)).toISOString() : null, finishedAt: e.finished_at ? new Date(String(e.finished_at)).toISOString() : null, metrics: (e.metrics as Record<string, unknown>) ?? null, notes: e.notes ? String(e.notes) : null })),
      promotions: trans.map((t) => ({ modelKey: String(t.model_key), from: String(t.from_state), to: String(t.to_state), reason: String(t.reason), evidenceRunId: t.evidence_run_id ? String(t.evidence_run_id) : null, at: new Date(String(t.created_at)).toISOString() })),
      calibrators: cals.map((c) => ({ modelName: String(c.model_name), horizonDays: Number(c.horizon_days), promoted: c.promoted === true, verdict: c.verdict ? String(c.verdict) : null, effectiveSamples: c.effective_samples != null ? Number(c.effective_samples) : null, brierBefore: c.brier_before != null ? Number(c.brier_before) : null, brierAfter: c.brier_after != null ? Number(c.brier_after) : null })),
      setupEvidence: { asOf: setupRow?.created_at ? new Date(String(setupRow.created_at)).toISOString() : null, cells: Array.isArray(cells) ? (cells as Array<Record<string, unknown>>) : [], verdict: setupRow?.verdict ? String(setupRow.verdict) : null },
      shadowModels: shadow.map((s) => ({ modelName: String(s.model_name), state: String(s.state), verdict: s.verdict ? String(s.verdict) : null, metrics: (s.metrics as Record<string, unknown>) ?? {} })),
      lessons: lessons.map((l) => ({ category: String(l.category), observation: String(l.observation), lesson: String(l.lesson), actionTaken: String(l.action_taken), createdAt: new Date(String(l.created_at)).toISOString() })),
      capitalTrackRecord: rec,
      promotionGates: gates,
      evidenceVerdict,
      policy: [
        "No automatic live model replacement. A challenger is promoted only through a governance transition that references a registered experiment run.",
        "Thresholds may tighten freely; loosening requires a validated study in the registry.",
        "The LLM may analyse failures, propose hypotheses and summarise evidence. It cannot promote, change thresholds, modify weights or create labels.",
        "Rates are withheld below 10 observed outcomes; raw counts are never quoted as evidence.",
      ],
    };
  }

  private async q(sql: string): Promise<Array<Record<string, unknown>>> {
    try {
      return await AppDataSource.query(sql);
    } catch {
      return [];
    }
  }
}

function emptyRecord(): CapitalTrackRecord {
  return {
    version: "capital-track-record-v1",
    generatedAt: new Date().toISOString(),
    overall: { totalRecommendations: 0, resolved: 0, observed: 0, notFilled: 0, ambiguous: 0, winRate: { n: 0, pct: null, wilsonLb95Pct: null }, avgReturnPct: { n: 0, mean: null, ci95: null, median: null }, medianReturnPct: null, profitFactor: null, expectancyR: null, maxDrawdownPct: null, mfeR: null, maeR: null, benchmarkExcessPct: { n: 0, mean: null, ci95: null, median: null }, withheld: true, withheldReason: "no outcomes" },
    precision: [],
    bySetupType: [], byHorizon: [], byRegime: [], byRiskProfile: [], bySector: [], byLiquidityBucket: [], byModelVersion: [],
    headline: "No desk outcomes yet.",
    caveat: "",
  };
}

export const modelLabService = new ModelLabService();
