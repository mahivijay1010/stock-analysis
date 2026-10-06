/**
 * Batch-2 study (docs/delivery-signals-preregistration.md): delivery / trade-
 * size signals scored exactly like batch 1, judged at t ≥ 2.64 (Bonferroni
 * over the 6 signals that have now used the sealed year).
 */
import { createHash } from "crypto";
import { AppDataSource } from "../../config/database";
import { DateScore, Panel, PeriodStats, buildContext, periodStats } from "./selectionSignals";
import { LONG_SHORT_ROUND_TRIP_PCT, PERIODS, loadPanel } from "./selectionStudy";
import { DELIVERY_SIGNALS, DeliveryPanel, DeliverySignalKey, scoreDeliveryDate } from "./deliverySignals";

export const DELIVERY_STUDY_VERSION = "delivery-study-v1";
export const DELIVERY_RULE = { minNonOverlappingDates: 10, minIcT: 2.64, minCrossSectionalHitPct: 52.0 } as const;

export interface DeliveryResult {
  key: DeliverySignalKey;
  describe: string;
  horizon: number;
  development: PeriodStats;
  sealed: PeriodStats;
  prospective: PeriodStats;
  pass: boolean;
  why: string;
  clearsCost: boolean | null;
  confidentTier: string | null;
}

/** Pre-registered rule. PURE. */
export function judgeDelivery(dev: PeriodStats, sealed: PeriodStats): { pass: boolean; why: string } {
  const R = DELIVERY_RULE;
  const r: string[] = [];
  if (sealed.nonOverlappingDates < R.minNonOverlappingDates) r.push(`sealed non-overlapping dates ${sealed.nonOverlappingDates} < ${R.minNonOverlappingDates}`);
  if (sealed.meanIc == null || sealed.meanIc <= 0) r.push(`sealed mean IC ${sealed.meanIc?.toFixed(4) ?? "n/a"} ≤ 0`);
  if (sealed.icT == null || sealed.icT < R.minIcT) r.push(`sealed IC t ${sealed.icT?.toFixed(2) ?? "n/a"} < ${R.minIcT}`);
  if (sealed.crossSectionalHitPct == null || sealed.crossSectionalHitPct <= R.minCrossSectionalHitPct)
    r.push(`sealed cross-sectional hit ${sealed.crossSectionalHitPct?.toFixed(2) ?? "n/a"}% ≤ ${R.minCrossSectionalHitPct}%`);
  if (dev.meanIc == null || dev.meanIc <= 0) r.push(`development mean IC ${dev.meanIc?.toFixed(4) ?? "n/a"} ≤ 0`);
  return { pass: r.length === 0, why: r.length ? r.join("; ") : "passes every pre-registered criterion on the sealed year" };
}

export function evaluateDelivery(p: Panel, d: DeliveryPanel): DeliveryResult[] {
  const ctx = buildContext(p);
  return DELIVERY_SIGNALS.map((spec) => {
    const scores: DateScore[] = [];
    for (let t = 0; t < p.dates.length; t++) {
      if (p.dates[t] < PERIODS.developmentFrom) continue;
      const s = scoreDeliveryDate(p, d, spec, t, ctx);
      if (s) scores.push(s);
    }
    const end = (x: DateScore) => p.dates[x.t + spec.horizon];
    const development = periodStats(scores.filter((x) => x.date < PERIODS.sealedFrom && end(x) < PERIODS.sealedFrom), spec.horizon);
    const sealed = periodStats(scores.filter((x) => x.date >= PERIODS.sealedFrom && end(x) <= PERIODS.sealedTo), spec.horizon);
    const prospective = periodStats(scores.filter((x) => x.date >= PERIODS.prospectiveFrom), spec.horizon);
    const { pass, why } = judgeDelivery(development, sealed);
    return {
      key: spec.key,
      describe: spec.describe,
      horizon: spec.horizon,
      development,
      sealed,
      prospective,
      pass,
      why,
      clearsCost: sealed.meanSpreadPct == null ? null : sealed.meanSpreadPct > LONG_SHORT_ROUND_TRIP_PCT,
      confidentTier: pass ? [...sealed.tiers].reverse().find((t) => t.lb95Pct != null && t.lb95Pct > 50)?.key ?? null : null,
    };
  });
}

export async function loadDeliveryPanel(p: Panel): Promise<{ panel: DeliveryPanel; coverage: { stocks: number; firstDate: string | null; lastDate: string | null } }> {
  const rows: Array<{ symbol: string; d: string; dp: string | null; tv: string | null; tr: string | null }> = await AppDataSource.query(
    `SELECT symbol, to_char(trade_date,'YYYY-MM-DD') d, deliv_pct dp, turnover_lacs tv, no_of_trades tr FROM nse_delivery WHERE series = 'EQ'`
  );
  const tIdx = new Map(p.tickers.map((t, i) => [t.replace(/\.NS$/, ""), i]));
  const dIdx = new Map(p.dates.map((d, i) => [d, i]));
  const delivPct = p.dates.map(() => new Array<number>(p.tickers.length).fill(NaN));
  const tradeValue = p.dates.map(() => new Array<number>(p.tickers.length).fill(NaN));
  const seen = new Set<number>();
  let first: string | null = null;
  let last: string | null = null;
  for (const r of rows) {
    const i = tIdx.get(r.symbol);
    const t = dIdx.get(r.d);
    if (i == null || t == null) continue;
    seen.add(i);
    if (!first || r.d < first) first = r.d;
    if (!last || r.d > last) last = r.d;
    if (r.dp != null) delivPct[t][i] = Number(r.dp);
    const tv = r.tv == null ? NaN : Number(r.tv);
    const tr = r.tr == null ? NaN : Number(r.tr);
    if (tv > 0 && tr > 0) tradeValue[t][i] = tv / tr;
  }
  return { panel: { delivPct, tradeValue }, coverage: { stocks: seen.size, firstDate: first, lastDate: last } };
}

export function deliveryHeadline(results: DeliveryResult[]): string {
  const passed = results.filter((r) => r.pass);
  if (passed.length === 0)
    return `None of the ${results.length} pre-registered delivery/trade-size signals passed on the sealed year (t ≥ ${DELIVERY_RULE.minIcT}). No confidence tier unlocked.`;
  return `${passed.map((r) => r.key).join(", ")} passed on the sealed year at t ≥ ${DELIVERY_RULE.minIcT}${passed.some((r) => r.clearsCost === false) ? " — spread does not clear a long-short round trip" : ""}. Survivorship-biased universe; re-judged prospectively nightly.`;
}

export async function runDeliveryStudy(opts: { dryRun?: boolean; note?: string } = {}): Promise<{ experimentRunId: string | null; results: DeliveryResult[]; headline: string; coverage: unknown }> {
  const startedAt = new Date();
  const p = await loadPanel();
  const { panel: d, coverage } = await loadDeliveryPanel(p);
  const results = evaluateDelivery(p, d);
  const headline = deliveryHeadline(results);
  if (opts.dryRun) return { experimentRunId: null, results, headline, coverage };

  const hash = createHash("sha256").update(`${DELIVERY_STUDY_VERSION}|${JSON.stringify(coverage)}|${p.dates.length}`).digest("hex");
  const [run]: Array<{ id: string }> = await AppDataSource.query(
    `INSERT INTO experiment_runs
       (name, kind, model_version, config, splits, dataset_manifest, dataset_hash, metrics, baselines, segments_used, used_final_test, status, notes, started_at, finished_at)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10::jsonb,true,'completed',$11,$12,now()) RETURNING id`,
    [
      "delivery-study",
      "study",
      DELIVERY_STUDY_VERSION,
      JSON.stringify({ signals: DELIVERY_SIGNALS, rule: DELIVERY_RULE, doc: "docs/delivery-signals-preregistration.md" }),
      JSON.stringify(PERIODS),
      JSON.stringify({ source: "nse_delivery (sec_bhavdata_full EQ) + stock_history.adjusted_close", coverage }),
      hash,
      JSON.stringify({ version: DELIVERY_STUDY_VERSION, results }),
      JSON.stringify({ crossSectional: "constant = 50%", cost: `${LONG_SHORT_ROUND_TRIP_PCT}% long-short round trip (reported only)` }),
      JSON.stringify(["development", "sealed", "prospective"]),
      `${opts.note ? opts.note + " — " : ""}${headline} ` + results.map((r) => `${r.key}: ${r.pass ? "PASS" : "FAIL"} (${r.why})`).join(" | "),
      startedAt,
    ]
  );
  const id = run?.id ?? null;

  for (const r of results) {
    const open: Array<{ id: string }> = await AppDataSource.query(
      `SELECT id FROM learning_expectations WHERE scope = 'selection-signal' AND subject = $1 AND status = 'OPEN' AND model_version = $2`,
      [r.key, DELIVERY_STUDY_VERSION]
    );
    for (const e of open) {
      await AppDataSource.query(
        `UPDATE learning_expectations SET status = $2, actual_value = $3, resolution_note = $4, resolved_at = now() WHERE id = $1`,
        [e.id, r.pass ? "WRONG" : "CORRECT", r.pass ? 1 : 0, `${r.pass ? "PASSED" : "FAILED"} on the sealed year — ${r.why}. Run ${id}.`]
      );
    }
  }

  const f = (x: number | null, k = 2) => (x == null ? "n/a" : x.toFixed(k));
  await AppDataSource.query(
    `INSERT INTO learning_lessons (experiment_run_id, model_key, category, observation, lesson, action_taken, action_detail)
     VALUES ($1, 'selection-signals', 'CALIBRATION', $2, $3, $4, $5)`,
    [
      id,
      results.map((r) => `${r.key} (${r.horizon}d): sealed IC ${f(r.sealed.meanIc, 4)} (t ${f(r.sealed.icT)}, ${r.sealed.nonOverlappingDates} dates), xs ${f(r.sealed.crossSectionalHitPct)}%, spread ${f(r.sealed.meanSpreadPct)}%; dev IC ${f(r.development.meanIc, 4)} (t ${f(r.development.icT)})`).join(" | "),
      headline,
      results.some((r) => r.pass) ? "THRESHOLD" : "NONE",
      results.some((r) => r.pass) ? `Unlocked: ${results.filter((r) => r.pass).map((r) => r.key).join(", ")}.` : "Nothing unlocked. Re-scored on prospective dates nightly.",
    ]
  );
  return { experimentRunId: id, results, headline, coverage };
}
