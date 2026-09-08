/**
 * OFFLINE RESEARCH (S4/S12): short-term meta-label study.
 *
 * For every stock×anchor (5y adjusted bars, anchors strided 2 sessions):
 * simulate the RADAR's bracket (entry = close, stop = close − 1.5·ATR14,
 * target = close + 2.25·ATR14, max hold 7 sessions, gap-aware: fills at the
 * OPEN when a gap jumps the level) → label TARGET_FIRST / STOP_FIRST /
 * TIMEOUT. Train LightGBM (worker) on point-in-time features to predict
 * TARGET_FIRST; evaluate discrimination AND calibration on date-split
 * held-out data with overlap-honest effective samples.
 *
 * PROMOTION RULE (pre-registered): probabilityTargetBeforeStop may only ship
 * if held-out ECE ≤ 0.05 AND Brier beats the base-rate baseline on ≥30
 * independent (non-overlapping) date windows AND stable across both halves of
 * the test segment. Otherwise the product keeps showing the mandated
 * "unavailable" text. The verdict is persisted to short_term_model_performance
 * (state SHADOW) either way.
 */

import { AppDataSource } from "../src/config/database";
import { ShortTermModelPerformance } from "../src/entities";
import { NSE_UNIVERSE } from "../src/data/nseUniverse";
import { marketDataService } from "../src/services/market/MarketDataService";
import { analysisCloses } from "../src/services/market/canonical";
import { computeShortTermFeatures } from "../src/services/shortterm/features";
import { classifySetup } from "../src/services/shortterm/setups";
import { panelFitPredict, pythonWorkerAvailable, PanelTrainRow } from "../src/services/research/pythonProvider";
import { round4 } from "../src/services/research/metrics";

const MAX_HOLD = 7;
const STRIDE = 2;

interface Row {
  id: string;
  ticker: string;
  date: string;
  setupType: string;
  features: Record<string, number | null>;
  label: "TARGET_FIRST" | "STOP_FIRST" | "TIMEOUT";
}

async function main(): Promise<void> {
  await AppDataSource.initialize();
  if (!(await pythonWorkerAvailable())) throw new Error("worker not reachable");
  const nifty = await marketDataService.getNiftyBars("5y");
  const niftyCloses = new Map(nifty.map((b) => [b.date, b.close]));

  const rows: Row[] = [];
  let done = 0;
  for (const u of NSE_UNIVERSE) {
    try {
      const bars = await marketDataService.getDailyBars(u.ticker, "5y");
      if (bars.length < 300) continue;
      const closes = analysisCloses(bars);
      for (let i = 260; i < bars.length - MAX_HOLD - 1; i += STRIDE) {
        const slice = bars.slice(0, i + 1);
        const f = computeShortTermFeatures(slice, niftyCloses, null);
        if (!f || f.atr14 == null || !(f.atr14 > 0)) continue;
        const entry = closes[i];
        const stop = entry - 1.5 * f.atr14;
        const target = entry + 2.25 * f.atr14;
        let label: Row["label"] = "TIMEOUT";
        for (let k = i + 1; k <= i + MAX_HOLD; k++) {
          const open = bars[k].open;
          // Gap-aware: a gap through the level fills at the open, not the level.
          if (open <= stop) { label = "STOP_FIRST"; break; }
          if (open >= target) { label = "TARGET_FIRST"; break; }
          if (bars[k].low <= stop) { label = "STOP_FIRST"; break; }
          if (bars[k].high >= target) { label = "TARGET_FIRST"; break; }
        }
        const setup = classifySetup(f, { marketRegime: null, stockRegime: null, upcomingEventRisk: false });
        const { asOfDate, price, ...feat } = f;
        void asOfDate;
        void price;
        rows.push({
          id: `${u.ticker}|${bars[i].date}`,
          ticker: u.ticker,
          date: bars[i].date,
          setupType: setup.setupType,
          features: feat as Record<string, number | null>,
          label,
        });
      }
      done++;
      if (done % 25 === 0) console.log(`  • ${done} tickers, ${rows.length} rows`);
    } catch {
      /* skipped ticker visible via row counts */
    }
  }
  console.log(`labeled rows: ${rows.length}`);

  // Per-setup outcome base rates (honest descriptive table).
  const bySetup = new Map<string, { t: number; s: number; o: number }>();
  for (const r of rows) {
    const c = bySetup.get(r.setupType) ?? { t: 0, s: 0, o: 0 };
    if (r.label === "TARGET_FIRST") c.t++;
    else if (r.label === "STOP_FIRST") c.s++;
    else c.o++;
    bySetup.set(r.setupType, c);
  }
  console.log("\nsetup outcome base rates (target/stop/timeout):");
  for (const [k, c] of bySetup) {
    const n = c.t + c.s + c.o;
    console.log(`  ${k.padEnd(24)} n=${String(n).padEnd(6)} T ${(100 * c.t / n).toFixed(1)}% | S ${(100 * c.s / n).toFixed(1)}% | TO ${(100 * c.o / n).toFixed(1)}%`);
  }

  // Date split with purge.
  const dates = Array.from(new Set(rows.map((r) => r.date))).sort();
  const trainEnd = Math.floor(dates.length * 0.6);
  const testStart = trainEnd + MAX_HOLD + 3;
  const trainDates = new Set(dates.slice(0, trainEnd));
  const testDates = new Set(dates.slice(testStart));
  const featureNames = Object.keys(rows[0].features);
  const train: PanelTrainRow[] = rows.filter((r) => trainDates.has(r.date)).map((r) => ({ id: r.id, date: r.date, features: r.features, target: r.label === "TARGET_FIRST" ? 1 : 0 }));
  const test = rows.filter((r) => testDates.has(r.date));
  console.log(`train ${train.length} rows / test ${test.length} rows (purged date split)`);

  const fit = await panelFitPredict({ model: "lgbm-cls", featureNames, train, eval: test.map((r) => ({ id: r.id, date: r.date, features: r.features })) });
  const probs = new Map(fit.predictions.map((p) => [p.id, p.prob]));

  // Calibration on the test segment: Brier vs base rate + 10-bin ECE + overlap honesty.
  const baseRate = train.reduce((a, r) => a + r.target, 0) / train.length;
  let brier = 0;
  let brierBase = 0;
  let n = 0;
  const bins = Array.from({ length: 10 }, () => ({ p: 0, y: 0, n: 0 }));
  for (const r of test) {
    const p = probs.get(r.id)?.valueOf() ?? null;
    if (p == null) continue;
    const y = r.label === "TARGET_FIRST" ? 1 : 0;
    brier += (p - y) ** 2;
    brierBase += (baseRate - y) ** 2;
    const b = Math.min(9, Math.floor(p * 10));
    bins[b].p += p;
    bins[b].y += y;
    bins[b].n++;
    n++;
  }
  brier /= Math.max(1, n);
  brierBase /= Math.max(1, n);
  let ece = 0;
  for (const b of bins) if (b.n > 0) ece += (b.n / n) * Math.abs(b.y / b.n - b.p / b.n);
  const independentWindows = Math.floor(new Set(test.map((r) => r.date)).size / MAX_HOLD);

  const passEce = ece <= 0.05;
  const passBrier = brier < brierBase;
  const passSamples = independentWindows >= 30;
  const promoted = passEce && passBrier && passSamples;
  const verdict = promoted
    ? `PROMOTABLE pending stability review: Brier ${round4(brier)} < base ${round4(brierBase)}, ECE ${round4(ece)}, ~${independentWindows} independent windows`
    : `NOT promoted — probability stays hidden. Brier ${round4(brier)} vs base ${round4(brierBase)} (${passBrier ? "ok" : "FAIL"}), ECE ${round4(ece)} (${passEce ? "ok" : "FAIL — needs ≤0.05"}), independent windows ${independentWindows} (${passSamples ? "ok" : "FAIL — needs ≥30"})`;

  const repo = AppDataSource.getRepository(ShortTermModelPerformance);
  await repo.save(
    repo.create({
      modelName: "st-meta-label-lgbm",
      modelVersion: fit.version,
      state: "SHADOW",
      metrics: {
        rows: rows.length,
        testRows: n,
        baseRate: round4(baseRate),
        brier: round4(brier),
        brierBase: round4(brierBase),
        ece: round4(ece),
        independentWindows,
        bracket: "entry=close, stop=1.5*ATR14, target=2.25*ATR14, maxHold=7 sessions, gap-aware fills",
        setupBaseRates: Object.fromEntries(Array.from(bySetup, ([k, c]) => [k, { n: c.t + c.s + c.o, targetPct: round4((100 * c.t) / (c.t + c.s + c.o)) }])),
      },
      verdict,
    })
  );
  console.log(`\nVERDICT: ${verdict}`);
  await AppDataSource.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
