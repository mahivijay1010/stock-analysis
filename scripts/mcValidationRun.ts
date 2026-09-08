/**
 * OFFLINE RESEARCH: Monte Carlo v2 validation (completion Phase 11 / Rule 10).
 *
 * i.i.d. bootstrap (champion, product-wired) vs stationary BLOCK bootstrap
 * (challenger, mean block 5d and 10d) on REAL history, leakage-free:
 * for anchors strided 21 sessions apart (non-overlapping at the longest
 * horizon), each simulator sees only bars BEFORE the anchor; realized forward
 * returns come from bars AFTER it.
 *
 * PRE-REGISTERED PROMOTION RULE (decided before looking at results):
 *   Promote block-bootstrap ONLY if, at the 30d horizon,
 *     (a) |80% band coverage − 80pp| improves by ≥ 2pp, AND
 *     (b) mean CRPS does not worsen by more than 2% relative, AND
 *     (c) both tail exceedance rates (below p05 / above p95) do not get worse
 *         by more than 1pp.
 *   Otherwise KEEP the i.i.d. simulator. Keeping the champion is a result.
 *
 * Usage: npx ts-node --transpile-only scripts/mcValidationRun.ts
 */

import { createHash } from "crypto";
import { AppDataSource } from "../src/config/database";
import { ExperimentRun } from "../src/entities";
import { NSE_UNIVERSE } from "../src/data/nseUniverse";
import { marketDataService } from "../src/services/market/MarketDataService";
import { analysisCloses } from "../src/services/market/canonical";
import {
  simulateDailyQuantiles,
  simulateDailyQuantilesBlock,
  DailyQuantileForecast,
} from "../src/services/quant/montecarlo";
import { crpsFromQuantiles, round4 } from "../src/services/research/metrics";

const WARMUP = 250; // bars each simulator needs before an anchor
const STRIDE = 21; // anchors non-overlapping at the longest horizon
const OFFSETS = [1, 5, 21] as const; // trading-day horizons ≈ 1d/7d/30d calendar

interface Cell {
  n: number;
  cov80: number; // realized inside p10–p90
  cov90: number; // realized inside p05–p95
  belowP05: number;
  aboveP95: number;
  widthSum: number; // p90 − p10 (fractions)
  crpsSum: number;
}

type Grid = Record<string, Record<number, Cell>>; // method -> offset -> cell

function cell(): Cell {
  return { n: 0, cov80: 0, cov90: 0, belowP05: 0, aboveP95: 0, widthSum: 0, crpsSum: 0 };
}

function score(grid: Grid, method: string, offset: number, fc: DailyQuantileForecast, realized: number): void {
  const step = fc.perStep[offset - 1];
  if (!step) return;
  const c = grid[method][offset];
  c.n++;
  if (realized >= step.q.p10 && realized <= step.q.p90) c.cov80++;
  if (realized >= step.q.p05 && realized <= step.q.p95) c.cov90++;
  if (realized < step.q.p05) c.belowP05++;
  if (realized > step.q.p95) c.aboveP95++;
  c.widthSum += step.q.p90 - step.q.p10;
  c.crpsSum += crpsFromQuantiles({ p10: step.q.p10, p50: step.q.p50, p90: step.q.p90 }, realized);
}

async function main(): Promise<void> {
  await AppDataSource.initialize();
  const started = new Date();
  const tickers = NSE_UNIVERSE.slice(0, 40).map((u) => u.ticker);

  const METHODS = ["iid", "block5", "block10"] as const;
  const grid: Grid = {};
  for (const m of METHODS) {
    grid[m] = {};
    for (const o of OFFSETS) grid[m][o] = cell();
  }

  let anchors = 0;
  const skipped: Array<{ ticker: string; reason: string }> = [];
  for (const ticker of tickers) {
    let closes: number[];
    try {
      const bars = await marketDataService.getDailyBars(ticker, "2y");
      closes = analysisCloses(bars);
    } catch (e) {
      skipped.push({ ticker, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (closes.length < WARMUP + STRIDE + 1) {
      skipped.push({ ticker, reason: `only ${closes.length} bars (< ${WARMUP + STRIDE + 1})` });
      continue;
    }
    for (let a = WARMUP; a + STRIDE < closes.length; a += STRIDE) {
      // History strictly BEFORE the anchor close is the resample pool.
      const rets: number[] = [];
      for (let i = 1; i <= a; i++) {
        if (closes[i - 1] > 0) rets.push(closes[i] / closes[i - 1] - 1);
      }
      let sims: Record<string, DailyQuantileForecast>;
      try {
        sims = {
          iid: simulateDailyQuantiles(rets, STRIDE, { paths: 4000 }),
          block5: simulateDailyQuantilesBlock(rets, STRIDE, { paths: 4000, meanBlockLen: 5 }),
          block10: simulateDailyQuantilesBlock(rets, STRIDE, { paths: 4000, meanBlockLen: 10 }),
        };
      } catch (e) {
        skipped.push({ ticker, reason: `anchor ${a}: ${e instanceof Error ? e.message : String(e)}` });
        continue;
      }
      anchors++;
      for (const o of OFFSETS) {
        const realized = closes[a + o] / closes[a] - 1;
        for (const m of METHODS) score(grid, m, o, sims[m], realized);
      }
    }
    console.log(`  • ${ticker} done (${anchors} anchors so far)`);
  }

  const table: Array<Record<string, unknown>> = [];
  for (const m of METHODS) {
    for (const o of OFFSETS) {
      const c = grid[m][o];
      if (c.n === 0) continue;
      table.push({
        method: m,
        offsetTd: o,
        n: c.n,
        cov80Pct: round4((c.cov80 / c.n) * 100),
        cov90Pct: round4((c.cov90 / c.n) * 100),
        belowP05Pct: round4((c.belowP05 / c.n) * 100),
        aboveP95Pct: round4((c.aboveP95 / c.n) * 100),
        meanWidth80Pct: round4((c.widthSum / c.n) * 100),
        meanCrps: round4(c.crpsSum / c.n),
      });
    }
  }

  // Pre-registered promotion rule, evaluated at the 30d (21td) horizon.
  const at = (m: string) => table.find((r) => r.method === m && r.offsetTd === 21) as Record<string, number> | undefined;
  const iid = at("iid");
  const verdicts: Record<string, string> = {};
  let promoted: string | null = null;
  for (const m of ["block5", "block10"]) {
    const ch = at(m);
    if (!iid || !ch) {
      verdicts[m] = "insufficient data — KEEP iid";
      continue;
    }
    const covImproves = Math.abs(ch.cov80Pct - 80) <= Math.abs(iid.cov80Pct - 80) - 2;
    const crpsOk = ch.meanCrps <= iid.meanCrps * 1.02;
    const tailsOk = ch.belowP05Pct <= iid.belowP05Pct + 1 && ch.aboveP95Pct <= iid.aboveP95Pct + 1;
    if (covImproves && crpsOk && tailsOk) {
      verdicts[m] = `qualifies: |cov80−80| ${Math.abs(iid.cov80Pct - 80).toFixed(1)}→${Math.abs(ch.cov80Pct - 80).toFixed(1)}pp, CRPS ${iid.meanCrps}→${ch.meanCrps}`;
      if (!promoted) promoted = m;
    } else {
      verdicts[m] =
        `KEEP iid — coverage ${covImproves ? "improves" : `does not improve ≥2pp (|${ch.cov80Pct}−80| vs |${iid.cov80Pct}−80|)`}` +
        `${crpsOk ? "" : `; CRPS worsens >2% (${iid.meanCrps}→${ch.meanCrps})`}` +
        `${tailsOk ? "" : `; tails worsen (${iid.belowP05Pct}/${iid.aboveP95Pct} → ${ch.belowP05Pct}/${ch.aboveP95Pct})`}`;
    }
  }

  const runRepo = AppDataSource.getRepository(ExperimentRun);
  const run = await runRepo.save(
    runRepo.create({
      name: "mc-block-vs-iid",
      kind: "challenger",
      modelVersion: "mc-v2-study",
      config: {
        methods: METHODS,
        warmup: WARMUP,
        strideTd: STRIDE,
        offsetsTd: OFFSETS,
        paths: 4000,
        promotionRule:
          "pre-registered: promote only if 30d |cov80−80| improves ≥2pp AND CRPS not >2% worse AND tails not >1pp worse",
      },
      splits: { anchors, skipped },
      datasetManifest: { tickers, source: "stock_history adjusted — OFFLINE RESEARCH" },
      datasetHash: createHash("sha256").update(JSON.stringify({ tickers, anchors })).digest("hex"),
      metrics: { table, verdicts, promoted },
      baselines: { champion: "iid bootstrap (product-wired)" },
      segmentsUsed: ["rolling non-overlapping anchors, pool strictly pre-anchor"],
      usedFinalTest: false,
      status: "completed",
      startedAt: started,
      finishedAt: new Date(),
    })
  );

  console.log(`\nExperimentRun ${run.id} persisted. anchors=${anchors}`);
  console.log("\nmethod   td   n    cov80%  cov90%  <p05%  >p95%  width80%  CRPS");
  for (const r of table) {
    console.log(
      `${String(r.method).padEnd(8)} ${String(r.offsetTd).padEnd(4)} ${String(r.n).padEnd(4)} ` +
        `${String(r.cov80Pct).padEnd(7)} ${String(r.cov90Pct).padEnd(7)} ${String(r.belowP05Pct).padEnd(6)} ` +
        `${String(r.aboveP95Pct).padEnd(6)} ${String(r.meanWidth80Pct).padEnd(9)} ${r.meanCrps}`
    );
  }
  console.log("\nverdicts:", JSON.stringify(verdicts, null, 2));
  console.log("promoted:", promoted ?? "NONE — iid bootstrap remains the champion");
  await AppDataSource.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
