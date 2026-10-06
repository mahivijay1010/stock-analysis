/**
 * Stock-selection study — runs the signals in selectionSignals.ts over the
 * daily panel and applies the rule pre-registered in
 * docs/stock-selection-preregistration.md (2026-10-01).
 *
 * The SEALED year (2025-10-01 → last complete window) decides pass/fail; the
 * development period only has to agree in sign. Formation dates on/after
 * 2026-10-01 are PROSPECTIVE and re-scored nightly as bars arrive — the
 * definitions are frozen, so recomputing from bars is equivalent to having
 * logged the ranks, as long as bars are not revised.
 *
 * Cost is reported beside the rule, never inside it.
 */
import { createHash } from "crypto";
import { AppDataSource } from "../../config/database";
import { DateScore, Panel, PeriodStats, SIGNALS, SignalKey, buildContext, periodStats, scoreDate } from "./selectionSignals";

export const SELECTION_STUDY_VERSION = "selection-study-v1";
export const PERIODS = {
  developmentFrom: "2022-10-01",
  sealedFrom: "2025-10-01",
  sealedTo: "2026-09-30",
  prospectiveFrom: "2026-10-01",
} as const;

export const SELECTION_RULE = {
  minNonOverlappingDates: 10,
  minIcT: 2.4,
  minCrossSectionalHitPct: 52.0,
} as const;

/** Long-short book: 0.42% round trip per leg (charges + slippage, project cost model), two legs per rebalance. */
export const LONG_SHORT_ROUND_TRIP_PCT = 0.84;

export interface SignalResult {
  key: SignalKey;
  describe: string;
  horizon: number;
  development: PeriodStats;
  sealed: PeriodStats;
  prospective: PeriodStats;
  pass: boolean;
  why: string;
  /** Sealed-year mean top-minus-bottom spread vs the long-short round trip — reported, not ruled on. */
  clearsCost: boolean | null;
  /** The most selective tier with a sealed-year date-clustered 95% LB > 50% — only for passing signals. */
  confidentTier: string | null;
}

/** The pre-registered rule. PURE. */
export function judge(dev: PeriodStats, sealed: PeriodStats): { pass: boolean; why: string } {
  const R = SELECTION_RULE;
  const reasons: string[] = [];
  if (sealed.nonOverlappingDates < R.minNonOverlappingDates) reasons.push(`sealed non-overlapping dates ${sealed.nonOverlappingDates} < ${R.minNonOverlappingDates}`);
  if (sealed.meanIc == null || sealed.meanIc <= 0) reasons.push(`sealed mean IC ${sealed.meanIc?.toFixed(4) ?? "n/a"} ≤ 0`);
  if (sealed.icT == null || sealed.icT < R.minIcT) reasons.push(`sealed IC t ${sealed.icT?.toFixed(2) ?? "n/a"} < ${R.minIcT}`);
  if (sealed.crossSectionalHitPct == null || sealed.crossSectionalHitPct <= R.minCrossSectionalHitPct)
    reasons.push(`sealed cross-sectional hit ${sealed.crossSectionalHitPct?.toFixed(2) ?? "n/a"}% ≤ ${R.minCrossSectionalHitPct}%`);
  if (dev.meanIc == null || dev.meanIc <= 0) reasons.push(`development mean IC ${dev.meanIc?.toFixed(4) ?? "n/a"} ≤ 0 (sign disagrees)`);
  return { pass: reasons.length === 0, why: reasons.length ? reasons.join("; ") : "passes every pre-registered criterion on the sealed year" };
}

/** Evaluate every signal on a panel. PURE (given the panel). */
export function evaluatePanel(p: Panel): SignalResult[] {
  const ctx = buildContext(p);
  return SIGNALS.map((spec) => {
    const scores: DateScore[] = [];
    for (let t = 0; t < p.dates.length; t++) {
      if (p.dates[t] < PERIODS.developmentFrom) continue;
      const s = scoreDate(p, spec, t, ctx);
      if (s) scores.push(s);
    }
    // A sealed-year date counts only if its forward window closes by sealedTo.
    const endIdx = (d: DateScore) => p.dates[d.t + spec.horizon];
    const dev = scores.filter((d) => d.date < PERIODS.sealedFrom && endIdx(d) < PERIODS.sealedFrom);
    const sealed = scores.filter((d) => d.date >= PERIODS.sealedFrom && endIdx(d) <= PERIODS.sealedTo);
    const prosp = scores.filter((d) => d.date >= PERIODS.prospectiveFrom);
    const development = periodStats(dev, spec.horizon);
    const sealedStats = periodStats(sealed, spec.horizon);
    const { pass, why } = judge(development, sealedStats);
    const tier = pass
      ? [...sealedStats.tiers].reverse().find((t) => t.lb95Pct != null && t.lb95Pct > 50)?.key ?? null
      : null;
    return {
      key: spec.key,
      describe: spec.describe,
      horizon: spec.horizon,
      development,
      sealed: sealedStats,
      prospective: periodStats(prosp, spec.horizon),
      pass,
      why,
      clearsCost: sealedStats.meanSpreadPct == null ? null : sealedStats.meanSpreadPct > LONG_SHORT_ROUND_TRIP_PCT,
      confidentTier: tier,
    };
  });
}

/** Load the daily panel from stock_history + stocks + earnings filings. */
export async function loadPanel(): Promise<Panel> {
  const stocks: Array<{ id: string; ticker: string; sector: string | null }> = await AppDataSource.query(
    `SELECT id, ticker, sector FROM stocks ORDER BY ticker`
  );
  const bars: Array<{ stock_id: string; d: string; c: string }> = await AppDataSource.query(
    `SELECT stock_id, to_char(trading_date,'YYYY-MM-DD') d, adjusted_close c FROM stock_history
      WHERE adjusted_close IS NOT NULL AND adjusted_close > 0 ORDER BY trading_date`
  );
  const filings: Array<{ ticker: string; at: Date }> = await AppDataSource.query(
    `SELECT ticker, published_at at FROM intelligence_sources
      WHERE document_type IN ('INTEGRATED_FINANCIAL_XBRL','FINANCIAL_RESULTS_XBRL') AND ticker IS NOT NULL AND published_at IS NOT NULL
      ORDER BY ticker, published_at`
  );

  const dates = [...new Set(bars.map((b) => b.d))].sort();
  const dIdx = new Map(dates.map((d, i) => [d, i]));
  const sIdx = new Map(stocks.map((s, i) => [s.id, i]));
  const close = dates.map(() => new Array<number>(stocks.length).fill(NaN));
  for (const b of bars) {
    const i = sIdx.get(b.stock_id);
    const t = dIdx.get(b.d);
    if (i != null && t != null) close[t][i] = Number(b.c);
  }

  const tIdx = new Map(stocks.map((s, i) => [s.ticker.replace(/\.NS$/, ""), i]));
  const events: number[][] = stocks.map(() => []);
  const TEN_DAYS = 10 * 86_400_000;
  for (const f of filings) {
    const i = tIdx.get(f.ticker.replace(/\.NS$/, ""));
    if (i == null) continue;
    const at = new Date(f.at).getTime();
    const prev = events[i][events[i].length - 1];
    if (prev != null && at - prev < TEN_DAYS) continue; // consolidated/standalone of the same result
    events[i].push(at);
  }

  return { dates, tickers: stocks.map((s) => s.ticker), sectors: stocks.map((s) => s.sector), close, events };
}

export interface SelectionStudySummary {
  experimentRunId: string | null;
  results: SignalResult[];
  headline: string;
}

export function studyHeadline(results: SignalResult[]): string {
  const passed = results.filter((r) => r.pass);
  if (passed.length === 0) {
    return `None of the ${results.length} pre-registered stock-selection signals passed on the sealed year (${PERIODS.sealedFrom} → ${PERIODS.sealedTo}). No confidence tier is unlocked; the model keeps withholding a "confident" label.`;
  }
  return `${passed.map((r) => r.key).join(", ")} passed on the sealed year${passed.some((r) => r.clearsCost === false) ? " — but its spread does not clear a long-short round trip" : ""}. One sealed year on today's constituents (survivorship-biased) is not proof; it is re-judged prospectively every night.`;
}

/**
 * The job. Records one experiment run; on its FIRST completed run, resolves
 * the three registered expectations (write-once). Later runs only add
 * prospective dates.
 */
export async function runSelectionStudy(opts: { dryRun?: boolean; note?: string } = {}): Promise<SelectionStudySummary> {
  const startedAt = new Date();
  const panel = await loadPanel();
  const results = evaluatePanel(panel);
  const headline = studyHeadline(results);

  const hash = createHash("sha256")
    .update(`${SELECTION_STUDY_VERSION}|${panel.dates[0]}|${panel.dates[panel.dates.length - 1]}|${panel.tickers.length}|${panel.events.reduce((a, e) => a + e.length, 0)}`)
    .digest("hex");

  let experimentRunId: string | null = null;
  if (opts.dryRun) return { experimentRunId, results, headline };

  const [run]: Array<{ id: string }> = await AppDataSource.query(
    `INSERT INTO experiment_runs
       (name, kind, model_version, config, splits, dataset_manifest, dataset_hash, metrics, baselines, segments_used, used_final_test, status, notes, started_at, finished_at)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10::jsonb,true,'completed',$11,$12,now())
     RETURNING id`,
    [
      "selection-study",
      "study",
      SELECTION_STUDY_VERSION,
      JSON.stringify({ signals: SIGNALS, rule: SELECTION_RULE, doc: "docs/stock-selection-preregistration.md" }),
      JSON.stringify(PERIODS),
      JSON.stringify({ source: "stock_history.adjusted_close + stocks.sector + intelligence_sources results filings", from: panel.dates[0], to: panel.dates[panel.dates.length - 1], stocks: panel.tickers.length, events: panel.events.reduce((a, e) => a + e.length, 0) }),
      hash,
      JSON.stringify({ version: SELECTION_STUDY_VERSION, results }),
      JSON.stringify({ crossSectional: "any constant = 50% by construction", ic: "0 = no ranking skill", cost: `${LONG_SHORT_ROUND_TRIP_PCT}% long-short round trip (reported only)` }),
      JSON.stringify(["development", "sealed", "prospective"]),
      `${opts.note ? opts.note + " — " : ""}${headline} ` + results.map((r) => `${r.key}: ${r.pass ? "PASS" : "FAIL"} (${r.why})`).join(" | "),
      startedAt,
    ]
  );
  experimentRunId = run?.id ?? null;

  // Resolve the registered priors exactly once (resolution is write-once by trigger).
  for (const r of results) {
    const open: Array<{ id: string }> = await AppDataSource.query(
      `SELECT id FROM learning_expectations WHERE scope = 'selection-signal' AND subject = $1 AND status = 'OPEN' AND model_version = $2`,
      [r.key, SELECTION_STUDY_VERSION]
    );
    for (const e of open) {
      // Each claim predicted FAILURE: CORRECT if it failed, WRONG if it passed.
      await AppDataSource.query(
        `UPDATE learning_expectations SET status = $2, actual_value = $3, resolution_note = $4, resolved_at = now() WHERE id = $1`,
        [e.id, r.pass ? "WRONG" : "CORRECT", r.pass ? 1 : 0, `${r.pass ? "PASSED" : "FAILED"} on the sealed year — ${r.why}. Run ${experimentRunId}.`]
      );
    }
  }

  const f = (x: number | null, d = 2) => (x == null ? "n/a" : x.toFixed(d));
  await AppDataSource.query(
    `INSERT INTO learning_lessons (experiment_run_id, model_key, category, observation, lesson, action_taken, action_detail)
     VALUES ($1, 'selection-signals', 'CALIBRATION', $2, $3, $4, $5)`,
    [
      experimentRunId,
      results
        .map((r) => `${r.key} (${r.horizon}d): sealed IC ${f(r.sealed.meanIc, 4)} (t ${f(r.sealed.icT)}, ${r.sealed.nonOverlappingDates} dates), xs hit ${f(r.sealed.crossSectionalHitPct)}%, spread ${f(r.sealed.meanSpreadPct)}%; dev IC ${f(r.development.meanIc, 4)} (t ${f(r.development.icT)})`)
        .join(" | "),
      headline,
      results.some((r) => r.pass) ? "THRESHOLD" : "NONE",
      results.some((r) => r.pass)
        ? `Unlocked: ${results.filter((r) => r.pass).map((r) => `${r.key}${r.confidentTier ? ` (confident tier: ${r.confidentTier})` : ""}`).join(", ")}.`
        : "Nothing unlocked. Signals keep being re-scored on prospective dates.",
    ]
  );

  return { experimentRunId, results, headline };
}
