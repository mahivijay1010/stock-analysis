/**
 * OFFLINE RESEARCH: panel excess-return + ranking study (upgrade Parts 5/6/7).
 *
 * Builds the stock×date panel (point-in-time features, excess-vs-NIFTY
 * targets), splits chronologically BY DATE (purged + embargoed), trains the
 * GBM/linear challengers in the Python worker, and evaluates EVERYTHING —
 * challengers and deterministic baselines — on the identical validation and
 * test date sets:
 *
 *   Rank IC (per-date Spearman, mean + t-stat) · Pearson IC · precision@5/@10
 *   · top-decile mean excess · top-minus-bottom quintile spread · top-10
 *   turnover · after-cost top-decile · Brier/hit for the classifier.
 *
 * Baselines: momentum (r20), sector-neutral momentum (r20 − sectorR20),
 * random (seeded), and rank_snapshots' stored composite where dates overlap.
 * VERDICT DISCIPLINE: selection happens on VALIDATION; TEST is reported once.
 *
 * Usage: npx ts-node --transpile-only scripts/panelRun.ts
 */

import { createHash } from "crypto";
import { AppDataSource } from "../src/config/database";
import { ExperimentRun } from "../src/entities";
import { buildPanelDataset, splitPanelByDate, PanelRow, PANEL_VERSION } from "../src/services/research/panel";
import { panelFitPredict, pythonWorkerAvailable, PanelTrainRow, PanelPredictRow } from "../src/services/research/pythonProvider";
import { mulberry32 } from "../src/services/quant/montecarlo";
import { round4 } from "../src/services/research/metrics";

const HORIZONS_TD = [5, 10, 21] as const;
const MODELS = ["lgbm-reg", "lgbm-cls", "lgbm-rank", "xgb-reg", "cat-reg", "enet-reg"] as const;
const COST_PER_SIDE = 0.002; // 0.2%/side conservative all-in for delivery

interface Scored {
  ticker: string;
  date: string;
  score: number;
  prob: number | null;
  target: number; // realized excess vs NIFTY
}

function spearmanPerDate(rows: Scored[], strideTd = 1): { meanIc: number | null; tStat: number | null; nDates: number; strideIc: number | null; strideT: number | null; strideDates: number } {
  const byDate = new Map<string, Scored[]>();
  for (const r of rows) {
    const list = byDate.get(r.date) ?? [];
    list.push(r);
    byDate.set(r.date, list);
  }
  const ics: number[] = [];
  for (const list of byDate.values()) {
    if (list.length < 10) continue;
    const rank = (xs: number[]): number[] => {
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
    if (d1 > 0 && d2 > 0) ics.push(num / Math.sqrt(d1 * d2));
  }
  // NAIVE stats (daily anchors — ICs at overlapping horizons are serially
  // correlated, so this t OVERSTATES significance; kept for reference only).
  const naive = (xs: number[]) => {
    if (xs.length < 5) return { mean: null as number | null, t: null as number | null, n: xs.length };
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
    return { mean: round4(m), t: sd > 0 ? round4((m / sd) * Math.sqrt(xs.length)) : null, n: xs.length };
  };
  const all = naive(ics);
  // HONEST stats: only every strideTd-th date ⇒ non-overlapping forward
  // windows ⇒ independent ICs. This is the promotion-decision metric.
  const sortedDates = Array.from(byDate.keys()).sort();
  const strideDates = new Set(sortedDates.filter((_, i) => i % Math.max(1, strideTd) === 0));
  const icByDate = new Map<string, number>();
  {
    let k = 0;
    for (const d of sortedDates) {
      const list = byDate.get(d)!;
      if (list.length < 10) continue;
      if (k < ics.length) icByDate.set(d, ics[k]);
      k++;
    }
  }
  const strideIcs = sortedDates.filter((d) => strideDates.has(d) && icByDate.has(d)).map((d) => icByDate.get(d)!);
  const strided = naive(strideIcs);
  return { meanIc: all.mean, tStat: all.t, nDates: all.n, strideIc: strided.mean, strideT: strided.t, strideDates: strided.n };
}

function portfolioStats(rows: Scored[]): Record<string, number | null> {
  const byDate = new Map<string, Scored[]>();
  for (const r of rows) {
    const list = byDate.get(r.date) ?? [];
    list.push(r);
    byDate.set(r.date, list);
  }
  const dates = Array.from(byDate.keys()).sort();
  let p5Hits = 0;
  let p5N = 0;
  let p10Hits = 0;
  let p10N = 0;
  const topDecileRets: number[] = [];
  const spreadRets: number[] = [];
  let prevTop10: Set<string> | null = null;
  let turnoverSum = 0;
  let turnoverN = 0;
  for (const d of dates) {
    const list = byDate.get(d)!;
    if (list.length < 20) continue;
    const sorted = [...list].sort((a, b) => b.score - a.score);
    const top5 = sorted.slice(0, 5);
    const top10 = sorted.slice(0, 10);
    p5Hits += top5.filter((x) => x.target > 0).length;
    p5N += 5;
    p10Hits += top10.filter((x) => x.target > 0).length;
    p10N += 10;
    const dec = Math.max(2, Math.floor(sorted.length / 10));
    const topDec = sorted.slice(0, dec);
    const botDec = sorted.slice(-dec);
    topDecileRets.push(topDec.reduce((a, x) => a + x.target, 0) / topDec.length);
    spreadRets.push(
      topDec.reduce((a, x) => a + x.target, 0) / topDec.length - botDec.reduce((a, x) => a + x.target, 0) / botDec.length
    );
    const ids = new Set(top10.map((x) => x.ticker));
    if (prevTop10) {
      const stay = [...ids].filter((x) => prevTop10!.has(x)).length;
      turnoverSum += 1 - stay / 10;
      turnoverN++;
    }
    prevTop10 = ids;
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const topDecMean = mean(topDecileRets);
  const turnover = turnoverN > 0 ? turnoverSum / turnoverN : null;
  return {
    precisionAt5: p5N ? round4(p5Hits / p5N) : null,
    precisionAt10: p10N ? round4(p10Hits / p10N) : null,
    topDecileMeanExcessPct: topDecMean != null ? round4(topDecMean * 100) : null,
    topMinusBottomSpreadPct: mean(spreadRets) != null ? round4((mean(spreadRets) as number) * 100) : null,
    top10TurnoverPct: turnover != null ? round4(turnover * 100) : null,
    // Per-rebalance cost = turnover × 2 sides × cost; expressed against the decile's mean excess.
    topDecileAfterCostPct:
      topDecMean != null && turnover != null ? round4((topDecMean - turnover * 2 * COST_PER_SIDE) * 100) : null,
    evaluatedDates: dates.length,
  };
}

function brierStats(rows: Scored[]): { brier: number | null; hitRatePct: number | null } {
  const withProb = rows.filter((r) => r.prob != null);
  if (withProb.length === 0) return { brier: null, hitRatePct: null };
  let b = 0;
  let hits = 0;
  for (const r of withProb) {
    const y = r.target > 0 ? 1 : 0;
    b += (r.prob! - y) ** 2;
    if (r.prob! > 0.5 === r.target > 0) hits++;
  }
  return { brier: round4(b / withProb.length), hitRatePct: round4((hits / withProb.length) * 100) };
}

async function main(): Promise<void> {
  await AppDataSource.initialize();
  const started = new Date();
  if (!(await pythonWorkerAvailable())) throw new Error("python worker not reachable on :5102");

  const panel = await buildPanelDataset({ log: (m) => console.log("  •", m) });
  const split = splitPanelByDate(panel.dates);
  console.log(
    `dates: train ${split.train.size} · val ${split.val.size} · test ${split.test.size} (purged+embargoed)`
  );

  // Stored composite ranking (the CURRENT StockSense ranking) where available.
  const rankRows: Array<{ ticker: string; as_of: string; composite: string }> = await AppDataSource.query(
    `SELECT ticker, to_char(date, 'YYYY-MM-DD') AS as_of, composite::text AS composite FROM rank_snapshots`
  ).catch(() => []);
  const storedRank = new Map<string, number>();
  for (const r of rankRows) storedRank.set(`${r.ticker}|${r.as_of}`, Number(r.composite));

  const results: Array<Record<string, unknown>> = [];
  const rand = mulberry32(7);
  const randScore = new Map<string, number>();

  for (const h of HORIZONS_TD) {
    const usable = panel.rows.filter((r) => r.targets[h]?.excessVsMarket != null);
    const trainRows: PanelTrainRow[] = [];
    const valRows: Array<PanelRow & { id: string }> = [];
    const testRows: Array<PanelRow & { id: string }> = [];
    for (const r of usable) {
      const id = `${r.ticker}|${r.date}`;
      if (split.train.has(r.date)) {
        trainRows.push({ id, date: r.date, features: r.features, target: r.targets[h].excessVsMarket as number });
      } else if (split.val.has(r.date)) valRows.push({ ...r, id });
      else if (split.test.has(r.date)) testRows.push({ ...r, id });
    }
    console.log(`h=${h}td rows: train ${trainRows.length} · val ${valRows.length} · test ${testRows.length}`);

    const evalPayload = (rows: Array<PanelRow & { id: string }>): PanelPredictRow[] =>
      rows.map((r) => ({ id: r.id, date: r.date, features: r.features }));
    const toScored = (rows: Array<PanelRow & { id: string }>, scores: Map<string, { score: number; prob: number | null }>): Scored[] =>
      rows
        .filter((r) => scores.has(r.id))
        .map((r) => ({
          ticker: r.ticker,
          date: r.date,
          score: scores.get(r.id)!.score,
          prob: scores.get(r.id)!.prob,
          target: r.targets[h].excessVsMarket as number,
        }));

    if (valRows.length === 0 || testRows.length === 0) {
      results.push({ model: "ALL", horizonTd: h, error: `empty segment (val ${valRows.length}, test ${testRows.length}) — insufficient history` });
      continue;
    }

    // ── challengers (worker) ────────────────────────────────────────────────
    for (const model of MODELS) {
      try {
        const [val, test] = [valRows, testRows];
        const fitVal = await panelFitPredict({ model, featureNames: panel.featureNames, train: trainRows, eval: evalPayload(val) });
        const fitTest = await panelFitPredict({ model, featureNames: panel.featureNames, train: trainRows, eval: evalPayload(test) });
        const vScores = new Map(fitVal.predictions.map((p) => [p.id, { score: p.score, prob: p.prob }]));
        const tScores = new Map(fitTest.predictions.map((p) => [p.id, { score: p.score, prob: p.prob }]));
        const vScored = toScored(val, vScores);
        const tScored = toScored(test, tScores);
        results.push({
          model,
          horizonTd: h,
          val: { ic: spearmanPerDate(vScored, h), ...portfolioStats(vScored), ...brierStats(vScored) },
          test: { ic: spearmanPerDate(tScored, h), ...portfolioStats(tScored), ...brierStats(tScored) },
        });
        console.log(`  ${model} h=${h} done`);
      } catch (e) {
        results.push({ model, horizonTd: h, error: e instanceof Error ? e.message : String(e) });
        console.log(`  ${model} h=${h} FAILED: ${e instanceof Error ? e.message : e}`);
      }
    }

    // ── deterministic baselines on the SAME rows ────────────────────────────
    const baseline = (name: string, scoreOf: (r: PanelRow & { id: string }) => number | null) => {
      const make = (rows: Array<PanelRow & { id: string }>): Scored[] =>
        rows
          .map((r) => ({ r, s: scoreOf(r) }))
          .filter((x): x is { r: PanelRow & { id: string }; s: number } => x.s != null)
          .map(({ r, s }) => ({ ticker: r.ticker, date: r.date, score: s, prob: null, target: r.targets[h].excessVsMarket as number }));
      const v = make(valRows);
      const t = make(testRows);
      results.push({
        model: name,
        horizonTd: h,
        val: { ic: spearmanPerDate(v, h), ...portfolioStats(v) },
        test: { ic: spearmanPerDate(t, h), ...portfolioStats(t) },
      });
    };
    baseline("baseline-momentum-r20", (r) => r.features.r20);
    baseline("baseline-sector-neutral-momentum", (r) =>
      r.features.r20 != null && r.features.sectorR20 != null ? (r.features.r20 as number) - (r.features.sectorR20 as number) : null
    );
    baseline("baseline-random", (r) => {
      const key = `${r.ticker}|${r.date}`;
      if (!randScore.has(key)) randScore.set(key, rand());
      return randScore.get(key)!;
    });
    baseline("baseline-current-ranking", (r) => storedRank.get(`${r.ticker}|${r.date}`) ?? null);
  }

  const runRepo = AppDataSource.getRepository(ExperimentRun);
  const run = await runRepo.save(
    runRepo.create({
      name: "panel-excess-rank-study",
      kind: "challenger",
      modelVersion: PANEL_VERSION,
      config: {
        horizonsTd: HORIZONS_TD,
        models: MODELS,
        target: "excess return vs NIFTY (forward, per trading days)",
        costPerSide: COST_PER_SIDE,
        discipline: "select on validation, report test once; splits by DATE with purge+embargo",
      },
      splits: { trainDates: split.train.size, valDates: split.val.size, testDates: split.test.size, skipped: panel.skipped },
      datasetManifest: { rows: panel.rows.length, features: panel.featureNames, dates: panel.dates.length, source: "stock_history adjusted — OFFLINE RESEARCH" },
      datasetHash: createHash("sha256").update(String(panel.rows.length)).update(panel.dates[0] ?? "").update(panel.dates.at(-1) ?? "").digest("hex"),
      metrics: { results },
      baselines: { list: ["momentum-r20", "sector-neutral-momentum", "random", "current-ranking(stored)"] },
      segmentsUsed: ["validation(select)", "test(report-once)"],
      usedFinalTest: true,
      status: "completed",
      startedAt: started,
      finishedAt: new Date(),
    })
  );

  console.log(`\nExperimentRun ${run.id} persisted.`);
  console.log("\nmodel                              h   VAL IC(strideT)   TEST IC(strideT)   TEST strideIC  p@10   topDec%  spread%  afterCost%");
  for (const r of results) {
    if (r.error) {
      console.log(`${String(r.model).padEnd(34)} ${String(r.horizonTd).padEnd(3)} ERROR: ${String(r.error).slice(0, 60)}`);
      continue;
    }
    const v = r.val as Record<string, any>;
    const t = r.test as Record<string, any>;
    console.log(
      `${String(r.model).padEnd(34)} ${String(r.horizonTd).padEnd(3)} ` +
        `${String(v.ic?.meanIc ?? "—").padEnd(7)}(${String(v.ic?.strideT ?? "—").padEnd(5)}) ` +
        `${String(t.ic?.meanIc ?? "—").padEnd(7)}(${String(t.ic?.strideT ?? "—").padEnd(5)}) ` +
        `${String(t.ic?.strideIc ?? "—").padEnd(13)} ${String(t.precisionAt10 ?? "—").padEnd(6)} ` +
        `${String(t.topDecileMeanExcessPct ?? "—").padEnd(8)} ` +
        `${String(t.topMinusBottomSpreadPct ?? "—").padEnd(8)} ${String(t.topDecileAfterCostPct ?? "—")}`
    );
  }
  await AppDataSource.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
