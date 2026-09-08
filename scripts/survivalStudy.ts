/**
 * OFFLINE RESEARCH — Cycle 5 (Part K): time-to-event / competing risks on the
 * short-term bracket dataset.
 *
 * Regenerates the gap-aware bracket simulation WITH per-day timing:
 * (t, event) where event ∈ {TARGET, STOP, TIMEOUT(censored at maxHold)}.
 *
 * BASELINE: empirical competing-risk hazard tables per setup×day — the
 * cumulative incidence of target/stop by session k. These are descriptive,
 * deterministic and always shippable (they refine expectedHoldingDays).
 *
 * CHALLENGER: LGBM regression predicting resolution day (censor-capped) and
 * LGBM classifier predicting resolution-by-day-3. PRE-REGISTERED promotion:
 * the classifier must beat the per-setup base-rate Brier on the date-split
 * test AND the regressor must beat the per-setup median-day MAE, both on
 * ≥40 independent test dates. Otherwise: NO_VALIDATED_EDGE and only the
 * empirical tables ship.
 */

import { AppDataSource } from "../src/config/database";
import { ShortTermModelPerformance } from "../src/entities";
import { NSE_UNIVERSE } from "../src/data/nseUniverse";
import { marketDataService } from "../src/services/market/MarketDataService";
import { analysisCloses } from "../src/services/market/canonical";
import { computeShortTermFeatures } from "../src/services/shortterm/features";
import { classifySetup } from "../src/services/shortterm/setups";
import { buildTradePlan } from "../src/services/shortterm/entryExit";
import { panelFitPredict, pythonWorkerAvailable, PanelTrainRow } from "../src/services/research/pythonProvider";
import { round4 } from "../src/services/research/metrics";

const MAX_HOLD = 7;
const STRIDE = 3;

interface Obs {
  id: string;
  date: string;
  setupType: string;
  features: Record<string, number | null>;
  event: "TARGET" | "STOP" | "TIMEOUT";
  day: number; // 1..MAX_HOLD (TIMEOUT ⇒ MAX_HOLD, censored)
}

async function main(): Promise<void> {
  await AppDataSource.initialize();
  if (!(await pythonWorkerAvailable())) throw new Error("worker not reachable");
  const nifty = await marketDataService.getNiftyBars("5y");
  const niftyCloses = new Map(nifty.map((b) => [b.date, b.close]));

  const obs: Obs[] = [];
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
        const setup = classifySetup(f, { marketRegime: null, stockRegime: null, upcomingEventRisk: false });
        if (["NO_SETUP", "LATE_TREND", "FAILED_BREAKOUT", "HIGH_EVENT_RISK"].includes(setup.setupType)) continue;
        const plan = buildTradePlan(f, setup, "5-10d");
        const entry = plan.entryZoneHigh ?? plan.entryTriggerPrice ?? f.price;
        const stop = plan.initialStop;
        const target = plan.target1;
        if (stop == null || target == null || !(entry > stop) || !(target > entry)) continue;
        let event: Obs["event"] = "TIMEOUT";
        let day = MAX_HOLD;
        for (let k = i + 1; k <= i + MAX_HOLD; k++) {
          if (bars[k].open <= stop || bars[k].low <= stop) { event = "STOP"; day = k - i; break; }
          if (bars[k].open >= target || bars[k].high >= target) { event = "TARGET"; day = k - i; break; }
        }
        const { asOfDate, price, ...feat } = f;
        void asOfDate;
        void price;
        obs.push({ id: `${u.ticker}|${bars[i].date}`, date: bars[i].date, setupType: setup.setupType, features: feat as Record<string, number | null>, event, day });
      }
      if (++done % 40 === 0) console.log(`  • ${done} tickers, ${obs.length} observations`);
    } catch {
      /* skipped */
    }
  }
  console.log(`observations: ${obs.length}`);

  // ── BASELINE: empirical competing-risk cumulative incidence per setup ─────
  const hazardTables: Record<string, Array<{ day: number; cumTargetPct: number; cumStopPct: number; survivingPct: number }>> = {};
  const bySetup = new Map<string, Obs[]>();
  for (const o of obs) bySetup.set(o.setupType, [...(bySetup.get(o.setupType) ?? []), o]);
  for (const [setup, list] of bySetup) {
    const n = list.length;
    const table: Array<{ day: number; cumTargetPct: number; cumStopPct: number; survivingPct: number }> = [];
    for (let d = 1; d <= MAX_HOLD; d++) {
      const cumT = list.filter((o) => o.event === "TARGET" && o.day <= d).length / n;
      const cumS = list.filter((o) => o.event === "STOP" && o.day <= d).length / n;
      table.push({ day: d, cumTargetPct: round4(cumT * 100), cumStopPct: round4(cumS * 100), survivingPct: round4((1 - cumT - cumS) * 100) });
    }
    hazardTables[setup] = table;
    const resolved = list.filter((o) => o.event !== "TIMEOUT");
    const medDay = resolved.length ? [...resolved].sort((a, b) => a.day - b.day)[Math.floor(resolved.length / 2)].day : null;
    console.log(`${setup.padEnd(24)} n=${n} medianResolutionDay=${medDay} day3: T ${table[2].cumTargetPct}% S ${table[2].cumStopPct}% alive ${table[2].survivingPct}%`);
  }

  // ── CHALLENGER: LGBM time regression + by-day-3 classifier ────────────────
  const dates = Array.from(new Set(obs.map((o) => o.date))).sort();
  const trainEnd = Math.floor(dates.length * 0.65);
  const testStart = trainEnd + MAX_HOLD + 3;
  const trainDates = new Set(dates.slice(0, trainEnd));
  const testDates = new Set(dates.slice(testStart));
  const featureNames = Object.keys(obs[0].features);
  const train = obs.filter((o) => trainDates.has(o.date));
  const test = obs.filter((o) => testDates.has(o.date));
  const independentTestDates = Math.floor(new Set(test.map((o) => o.date)).size / MAX_HOLD);
  console.log(`train ${train.length} / test ${test.length} (≈${independentTestDates} independent test windows)`);

  // (a) resolution-day regression (TIMEOUT censored at MAX_HOLD — stated).
  const regTrain: PanelTrainRow[] = train.map((o) => ({ id: o.id, date: o.date, features: o.features, target: o.day }));
  const regFit = await panelFitPredict({ model: "lgbm-reg", featureNames, train: regTrain, eval: test.map((o) => ({ id: o.id, date: o.date, features: o.features })) });
  const regPred = new Map(regFit.predictions.map((p) => [p.id, p.score]));
  // Baseline for MAE: per-setup TRAIN median day.
  const medianBySetup = new Map<string, number>();
  for (const [setup, list] of bySetup) {
    const tr = list.filter((o) => trainDates.has(o.date)).map((o) => o.day).sort((a, b) => a - b);
    medianBySetup.set(setup, tr.length ? tr[Math.floor(tr.length / 2)] : MAX_HOLD);
  }
  let maeModel = 0;
  let maeBase = 0;
  let nReg = 0;
  for (const o of test) {
    const p = regPred.get(o.id);
    if (p == null) continue;
    maeModel += Math.abs(p - o.day);
    maeBase += Math.abs((medianBySetup.get(o.setupType) ?? MAX_HOLD) - o.day);
    nReg++;
  }
  maeModel /= Math.max(1, nReg);
  maeBase /= Math.max(1, nReg);

  // (b) resolved-by-day-3 classifier vs per-setup base rate.
  const clsTrain: PanelTrainRow[] = train.map((o) => ({ id: o.id, date: o.date, features: o.features, target: o.event !== "TIMEOUT" && o.day <= 3 ? 1 : -1 }));
  const clsFit = await panelFitPredict({ model: "lgbm-cls", featureNames, train: clsTrain, eval: test.map((o) => ({ id: o.id, date: o.date, features: o.features })) });
  const clsPred = new Map(clsFit.predictions.map((p) => [p.id, p.prob]));
  const baseRateBySetup = new Map<string, number>();
  for (const [setup, list] of bySetup) {
    const tr = list.filter((o) => trainDates.has(o.date));
    baseRateBySetup.set(setup, tr.length ? tr.filter((o) => o.event !== "TIMEOUT" && o.day <= 3).length / tr.length : 0.3);
  }
  let brierModel = 0;
  let brierBase = 0;
  let nCls = 0;
  for (const o of test) {
    const p = clsPred.get(o.id);
    if (p == null) continue;
    const y = o.event !== "TIMEOUT" && o.day <= 3 ? 1 : 0;
    brierModel += ((p as number) - y) ** 2;
    brierBase += ((baseRateBySetup.get(o.setupType) ?? 0.3) - y) ** 2;
    nCls++;
  }
  brierModel /= Math.max(1, nCls);
  brierBase /= Math.max(1, nCls);

  const regWins = maeModel < maeBase;
  const clsWins = brierModel < brierBase;
  const enough = independentTestDates >= 40;
  const promoted = regWins && clsWins && enough;
  const verdict = promoted
    ? `PROMISING pending shadow: time-MAE ${round4(maeModel)} < base ${round4(maeBase)}; day3 Brier ${round4(brierModel)} < base ${round4(brierBase)} on ~${independentTestDates} windows`
    : `NO_VALIDATED_EDGE — hazard TABLES ship (descriptive), model does not: time-MAE ${round4(maeModel)} vs base ${round4(maeBase)} (${regWins ? "ok" : "FAIL"}); day3 Brier ${round4(brierModel)} vs base ${round4(brierBase)} (${clsWins ? "ok" : "FAIL"}); windows ${independentTestDates} (${enough ? "ok" : "FAIL"})`;

  const repo = AppDataSource.getRepository(ShortTermModelPerformance);
  await repo.save(
    repo.create({
      modelName: "st-survival-competing-risks",
      modelVersion: "survival-v1",
      state: "SHADOW",
      metrics: { observations: obs.length, hazardTables, timeMaeModel: round4(maeModel), timeMaeBase: round4(maeBase), day3BrierModel: round4(brierModel), day3BrierBase: round4(brierBase), independentTestDates },
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
