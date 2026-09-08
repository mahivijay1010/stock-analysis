/**
 * OFFLINE RESEARCH — Cycles 2/3/4 of the autonomous loop (Parts P, I, A/D).
 *
 * ONE panel-v2 build (breadth features included), then:
 *  C2  FEATURE ABLATION: lgbm-reg on excess-vs-NIFTY with ALL features vs
 *      minus-{MARKET, SECTOR, STOCK_PRICE, TECHNICAL, VOLUME, RELATIVE,
 *      EVENTS}. Selection metric: VALIDATION stride IC; TEST reported once.
 *  C3  REGIME INTERACTIONS: global model vs global+regime-flag feature vs
 *      regime-SPLIT models (bull/bear by NIFTY-vs-SMA200 per date, PIT).
 *  C4  TARGET FORMULATION: direct raw return vs excess-vs-NIFTY on identical
 *      rows (Part D: does decomposition beat direct prediction?).
 *
 * All statistics are overlap-honest (stride = horizon). Every variant is
 * persisted to the experiment registry. Pre-registered read: a variant "wins"
 * only if its VALIDATION stride IC beats ALL-features AND the direction is
 * confirmed on TEST; otherwise the finding is descriptive.
 */

import { createHash } from "crypto";
import { AppDataSource } from "../src/config/database";
import { ExperimentRun } from "../src/entities";
import { marketDataService } from "../src/services/market/MarketDataService";
import { analysisCloses } from "../src/services/market/canonical";
import { buildPanelDataset, splitPanelByDate, PanelRow, PANEL_VERSION } from "../src/services/research/panel";
import { panelFitPredict, pythonWorkerAvailable, PanelTrainRow, PanelPredictRow } from "../src/services/research/pythonProvider";
import { ABLATION_GROUPS } from "../src/services/research/featureRegistry";
import { round4 } from "../src/services/research/metrics";

const HORIZONS = [10, 21] as const;
const MODEL = "lgbm-reg";

interface Scored {
  ticker: string;
  date: string;
  score: number;
  target: number;
}

/** Per-date Spearman IC with overlap-honest stride statistics. */
function strideIc(rows: Scored[], strideTd: number): { meanIc: number | null; strideIc: number | null; strideT: number | null; nDates: number } {
  const byDate = new Map<string, Scored[]>();
  for (const r of rows) byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);
  const dates = Array.from(byDate.keys()).sort();
  const ics: Array<{ date: string; ic: number }> = [];
  for (const d of dates) {
    const list = byDate.get(d)!;
    if (list.length < 10) continue;
    const rank = (xs: number[]) => {
      const idx = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
      const out = new Array(xs.length).fill(0);
      idx.forEach(([, orig], pos) => (out[orig] = pos));
      return out;
    };
    const rs = rank(list.map((x) => x.score));
    const rt = rank(list.map((x) => x.target));
    const n = list.length;
    const mean = (n - 1) / 2;
    let num = 0;
    let d1 = 0;
    let d2 = 0;
    for (let i = 0; i < n; i++) {
      num += (rs[i] - mean) * (rt[i] - mean);
      d1 += (rs[i] - mean) ** 2;
      d2 += (rt[i] - mean) ** 2;
    }
    if (d1 > 0 && d2 > 0) ics.push({ date: d, ic: num / Math.sqrt(d1 * d2) });
  }
  const stat = (xs: number[]) => {
    if (xs.length < 5) return { mean: null as number | null, t: null as number | null };
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
    return { mean: round4(m), t: sd > 0 ? round4((m / sd) * Math.sqrt(xs.length)) : null };
  };
  const all = stat(ics.map((x) => x.ic));
  const strided = stat(ics.filter((_, i) => i % Math.max(1, strideTd) === 0).map((x) => x.ic));
  return { meanIc: all.mean, strideIc: strided.mean, strideT: strided.t, nDates: ics.length };
}

async function main(): Promise<void> {
  await AppDataSource.initialize();
  const started = new Date();
  if (!(await pythonWorkerAvailable())) throw new Error("worker not reachable");

  const panel = await buildPanelDataset({ log: (m) => console.log("  •", m) });
  const split = splitPanelByDate(panel.dates);
  console.log(`panel ${PANEL_VERSION}: ${panel.rows.length} rows, ${panel.featureNames.length} features; dates train ${split.train.size} val ${split.val.size} test ${split.test.size}`);

  // Market regime per DATE (PIT): NIFTY close vs its own SMA200 that day.
  const nifty = await marketDataService.getNiftyBars("5y");
  const nCloses = analysisCloses(nifty);
  const regimeByDate = new Map<string, "bull" | "bear">();
  let roll = 0;
  for (let i = 0; i < nifty.length; i++) {
    roll += nCloses[i];
    if (i >= 200) roll -= nCloses[i - 200];
    if (i >= 199) regimeByDate.set(nifty[i].date, nCloses[i] > roll / 200 ? "bull" : "bear");
  }

  const results: Array<Record<string, unknown>> = [];

  const evalVariant = async (opts: {
    label: string;
    horizon: number;
    features: string[];
    target: "excessVsMarket" | "rawStock";
    trainFilter?: (r: PanelRow) => boolean;
    valTestFilter?: (r: PanelRow) => boolean;
    extraFeature?: (r: PanelRow) => Record<string, number | null>;
  }): Promise<void> => {
    const h = opts.horizon;
    const usable = panel.rows.filter((r) => r.targets[h]?.[opts.target] != null);
    const mk = (r: PanelRow): Record<string, number | null> => {
      const base: Record<string, number | null> = {};
      for (const k of opts.features) base[k] = r.features[k] ?? null;
      return opts.extraFeature ? { ...base, ...opts.extraFeature(r) } : base;
    };
    const featureNames = opts.extraFeature ? [...opts.features, ...Object.keys(opts.extraFeature(usable[0]))] : opts.features;
    const train: PanelTrainRow[] = usable
      .filter((r) => split.train.has(r.date) && (opts.trainFilter?.(r) ?? true))
      .map((r) => ({ id: `${r.ticker}|${r.date}`, date: r.date, features: mk(r), target: r.targets[h][opts.target] as number }));
    const valRows = usable.filter((r) => split.val.has(r.date) && (opts.valTestFilter?.(r) ?? true));
    const testRows = usable.filter((r) => split.test.has(r.date) && (opts.valTestFilter?.(r) ?? true));
    if (train.length < 1000 || valRows.length < 200 || testRows.length < 200) {
      results.push({ label: opts.label, horizon: h, error: `insufficient rows (train ${train.length}, val ${valRows.length}, test ${testRows.length})` });
      return;
    }
    const toPred = (rows: PanelRow[]): PanelPredictRow[] => rows.map((r) => ({ id: `${r.ticker}|${r.date}`, date: r.date, features: mk(r) }));
    const toScored = (rows: PanelRow[], preds: Map<string, number>): Scored[] =>
      rows
        .filter((r) => preds.has(`${r.ticker}|${r.date}`))
        .map((r) => ({ ticker: r.ticker, date: r.date, score: preds.get(`${r.ticker}|${r.date}`)!, target: r.targets[h][opts.target] as number }));
    try {
      const fitVal = await panelFitPredict({ model: MODEL, featureNames, train, eval: toPred(valRows) });
      const fitTest = await panelFitPredict({ model: MODEL, featureNames, train, eval: toPred(testRows) });
      const v = strideIc(toScored(valRows, new Map(fitVal.predictions.map((p) => [p.id, p.score]))), h);
      const t = strideIc(toScored(testRows, new Map(fitTest.predictions.map((p) => [p.id, p.score]))), h);
      results.push({ label: opts.label, horizon: h, nFeatures: featureNames.length, trainRows: train.length, val: v, test: t });
      console.log(`  ${opts.label.padEnd(28)} h=${h} valIC=${v.meanIc} (strideT ${v.strideT}) testIC=${t.meanIc} (strideT ${t.strideT})`);
    } catch (e) {
      results.push({ label: opts.label, horizon: h, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const ALL = panel.featureNames;

  // ── C2: ablation (ALL at both horizons; minus-groups at 10td selection horizon) ──
  for (const h of HORIZONS) await evalVariant({ label: "ALL", horizon: h, features: ALL, target: "excessVsMarket" });
  for (const [group, members] of Object.entries(ABLATION_GROUPS)) {
    const feats = ALL.filter((k) => !members.includes(k));
    if (feats.length === ALL.length) continue; // group has no panel members
    await evalVariant({ label: `minus-${group}`, horizon: 10, features: feats, target: "excessVsMarket" });
  }

  // ── C3: regime interactions ──────────────────────────────────────────────
  for (const h of HORIZONS) {
    await evalVariant({
      label: "regime-feature",
      horizon: h,
      features: ALL,
      target: "excessVsMarket",
      extraFeature: (r) => ({ marketBull: regimeByDate.get(r.date) === "bull" ? 1 : regimeByDate.get(r.date) === "bear" ? 0 : null }),
    });
    for (const regime of ["bull", "bear"] as const) {
      await evalVariant({
        label: `regime-split-${regime}`,
        horizon: h,
        features: ALL,
        target: "excessVsMarket",
        trainFilter: (r) => regimeByDate.get(r.date) === regime,
        valTestFilter: (r) => regimeByDate.get(r.date) === regime,
      });
    }
  }

  // ── C4: target formulation — direct raw return vs excess ─────────────────
  for (const h of HORIZONS) await evalVariant({ label: "target-rawStock", horizon: h, features: ALL, target: "rawStock" });

  const repo = AppDataSource.getRepository(ExperimentRun);
  const run = await repo.save(
    repo.create({
      name: "ablation-regime-target-study",
      kind: "challenger",
      modelVersion: PANEL_VERSION,
      config: { model: MODEL, horizons: HORIZONS, groups: Object.keys(ABLATION_GROUPS), preRegisteredRead: "variant wins only if val stride IC beats ALL and test confirms direction" },
      splits: { trainDates: split.train.size, valDates: split.val.size, testDates: split.test.size },
      datasetManifest: { rows: panel.rows.length, features: panel.featureNames, source: "panel-v2 adjusted bars — OFFLINE RESEARCH" },
      datasetHash: createHash("sha256").update(String(panel.rows.length)).update(panel.dates[0] ?? "").digest("hex"),
      metrics: { results },
      baselines: { reference: "ALL-features lgbm-reg" },
      segmentsUsed: ["validation(select)", "test(report-once)"],
      usedFinalTest: true,
      status: "completed",
      startedAt: started,
      finishedAt: new Date(),
    })
  );
  console.log(`\nExperimentRun ${run.id} persisted (${results.length} variants).`);
  await AppDataSource.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
