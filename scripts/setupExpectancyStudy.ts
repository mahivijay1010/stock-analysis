/**
 * OFFLINE RESEARCH (V2-3/V2-10): setup-specific realized-R expectancy study.
 *
 * For every historical anchor where the LIVE setup classifier fires, build the
 * SAME trade plan the radar builds (entry ref / structural stop / ATR target)
 * and simulate the bracket forward on completed bars, GAP-AWARE (an open
 * through a level fills at the open). Record the realized R-multiple —
 * including TIMEOUT trades' actual P&L in R — then per setupType×horizon:
 *   targetFirst/stopFirst/timeout rates, mean/median R, win/loss R,
 *   after-cost expectancy R, profit factor, max drawdown R, a DATE-BLOCK
 *   bootstrap expectancy CI (a real contiguous-block bootstrap — see below),
 *   P(expectancy>0), a one-sided block-bootstrap p-value, a
 *   Benjamini–Hochberg FDR flag across ALL cells, and a Deflated Sharpe /
 *   PBO overfitting check across the cell search.
 *
 * ── Corrected methodology (fixes docs/system-trust-review.md §4.2) ─────────
 *
 * 1. TRAIN/TEST SPLIT. The setup rules and trade-plan geometry are fixed code
 *    (not fit to this data), so the leakage risk is not "the classifier
 *    memorized the training set" — it is that a rule chosen (during earlier
 *    development, by eye) to look good on all available history has no
 *    honest out-of-sample read. Every cell's PROMOTABLE tier is now derived
 *    ONLY from the TEST segment (the most recent ~30% of the shared entry
 *    calendar, after purge+embargo on the horizon's calendar-day length).
 *    The full-history (train+test) numbers are still computed and persisted,
 *    clearly labeled "in-sample — not evidentiary", for comparison only.
 *
 * 2. REAL BLOCK BOOTSTRAP. The expectancy CI used to resample PER-DATE MEANS
 *    with block length 1 — that removes cross-sectional (same-day) but not
 *    serial correlation, while anchors at STRIDE=3 with holds up to 21
 *    trading days overlap heavily. Now uses dateBlockBootstrap (a genuine
 *    contiguous-block bootstrap already used correctly elsewhere in the
 *    research pipeline — experiments/runner.ts, research/harness.ts) with
 *    block length = the horizon's own max holding period in calendar days,
 *    so each resampled block is long enough to contain a full non-overlapping
 *    trade window.
 *
 * 3. OVERLAP-ADJUSTED INDEPENDENT DATES. independentEntryDates used to be raw
 *    distinct calendar dates with NO division by holding period, then
 *    compared directly to SETUP_PROMOTION.minIndependentDates=60 — inflating
 *    the apparent evidence by roughly the horizon's trading-day length. Now
 *    divided by the horizon's max trading days first, matching the
 *    convention already used correctly in decision/policy.ts's
 *    effectiveSamples() and monitoring/ModelHealthService.ts's `effective`.
 *
 * 4. NO FABRICATED "AFTER COSTS" DISTINCTION. expectancyR and
 *    expectancyAfterCosts used to be assigned the identical value (costs are
 *    already subtracted per-trade via dragR before either field is computed)
 *    — the field pair implied two different measurements when there was only
 *    one. expectancyR is now the pre-cost figure (kept for transparency) and
 *    expectancyAfterCosts is the ONLY number gated on; they are no longer
 *    silently identical.
 *
 * 5. OVERFITTING CONTROLS ACTUALLY RUN. deflatedSharpeRatio and
 *    probabilityOfBacktestOverfitting (research/overfitting.ts) existed in
 *    the repo but were never called anywhere. nTrials for DSR is the number
 *    of setup×horizon cells tested here (a conservative floor — it does not
 *    additionally count the setup-threshold search that happened during
 *    earlier development, which is real degrees of freedom this cannot see).
 *    PBO splits the TEST segment into 8 time blocks and asks whether the
 *    best-looking cell in half the blocks stays best out-of-sample in the
 *    other half.
 *
 * Usage: npx ts-node --transpile-only scripts/setupExpectancyStudy.ts
 */

import { AppDataSource } from "../src/config/database";
import { ShortTermModelPerformance } from "../src/entities";
import { NSE_UNIVERSE } from "../src/data/nseUniverse";
import { marketDataService } from "../src/services/market/MarketDataService";
import { analysisCloses } from "../src/services/market/canonical";
import { computeShortTermFeatures } from "../src/services/shortterm/features";
import { classifySetup } from "../src/services/shortterm/setups";
import { buildTradePlan } from "../src/services/shortterm/entryExit";
import { roundTripCostPct, estimateSlippagePct } from "../src/services/shortterm/costs";
import { HORIZON_TD, ShortTermHorizon } from "../src/services/shortterm/types";
import { tierFromEvidence } from "../src/services/shortterm/setupEvidence";
import { benjaminiHochberg } from "../src/services/shortterm/shrinkage";
import { buildPurgedSplits, dateBlockBootstrap } from "../src/services/experiments/splits";
import { deflatedSharpeRatio, probabilityOfBacktestOverfitting } from "../src/services/research/overfitting";
import { mulberry32 } from "../src/services/quant/montecarlo";
import { round4 } from "../src/services/research/metrics";
import { addCalendarDays } from "../src/services/forecast/dates";

const HORIZONS: ShortTermHorizon[] = ["3-5d", "5-10d", "10-21d"];
const STRIDE = 3;
// Purge/embargo window: the LONGEST horizon's max trading-day hold, converted
// to a generous calendar-day estimate (trading days * 7/5, +buffer for
// holidays), so no train-segment trade's outcome can leak across the
// train/test boundary.
const MAX_HOLD_TD = Math.max(...HORIZONS.map((h) => HORIZON_TD[h].max));
const PURGE_CALENDAR_DAYS = Math.ceil((MAX_HOLD_TD * 7) / 5) + 3;
const EMBARGO_CALENDAR_DAYS = 5;

export interface Trade {
  date: string;
  setupType: string;
  horizon: string;
  rGross: number; // realized R-multiple, BEFORE costs
  rNet: number; // realized R-multiple, net of costs (dragR subtracted)
  outcome: "TARGET_FIRST" | "STOP_FIRST" | "TIMEOUT";
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/**
 * Builds a cell's evidence row from a set of trades restricted to ONE segment
 * (train or test). `rand` must be a fresh PRNG per segment for reproducible,
 * segment-independent bootstrap draws.
 */
export function buildCell(
  setupType: string,
  horizon: string,
  ts: Trade[],
  rand: () => number
): Record<string, unknown> & { pValue: number; rawTrades: number } {
  const rsNet = ts.map((t) => t.rNet);
  const rsGross = ts.map((t) => t.rGross);
  const wins = rsNet.filter((r) => r > 0);
  const losses = rsNet.filter((r) => r <= 0);
  const sorted = [...rsNet].sort((a, b) => a - b);
  const expectancyGross = mean(rsGross);
  const expectancyNet = mean(rsNet);

  const maxHoldTd = HORIZON_TD[horizon as ShortTermHorizon]?.max ?? 1;
  const rawIndependentDates = new Set(ts.map((t) => t.date)).size;
  // Overlap-adjusted: a trade with a 10-21 day hold overlaps ~maxHoldTd-1
  // neighbouring trades of the same ticker at STRIDE=3 spacing — dividing the
  // raw distinct-date count by the horizon's own holding period gives an
  // honest (if still approximate — it does not additionally account for
  // cross-ticker correlation) estimate of truly independent evidence.
  const independentDates = Math.max(1, Math.floor(rawIndependentDates / maxHoldTd));

  // Real date-block bootstrap: block length = the horizon's own calendar-day
  // hold, so each block is long enough to span one full non-overlapping
  // trade window (fixes docs/system-trust-review.md §4.2's block-length-1 bug).
  const distinctDates = [...new Set(ts.map((t) => t.date))].sort();
  const byDate = new Map<string, number[]>();
  for (const t of ts) byDate.set(t.date, [...(byDate.get(t.date) ?? []), t.rNet]);

  const blockCalendarDays = Math.max(1, Math.ceil((maxHoldTd * 7) / 5));
  const blockLen = Math.max(1, Math.min(distinctDates.length, blockCalendarDays));
  let ciLower = expectancyNet;
  let ciUpper = expectancyNet;
  let probPositive = expectancyNet > 0 ? 1 : 0;
  let pValue = 1;
  if (distinctDates.length >= blockLen && distinctDates.length >= 5) {
    const dateSamples = dateBlockBootstrap(distinctDates, blockLen, 1000, rand);
    const bootMeans = dateSamples.map((sampledDates) => {
      const vals = sampledDates.flatMap((d) => byDate.get(d) ?? []);
      return mean(vals);
    });
    bootMeans.sort((a, b) => a - b);
    ciLower = bootMeans[Math.floor(0.05 * bootMeans.length)];
    ciUpper = bootMeans[Math.floor(0.95 * bootMeans.length)];
    const nBelowOrAtZero = bootMeans.filter((m) => m <= 0).length;
    probPositive = 1 - nBelowOrAtZero / bootMeans.length;
    // One-sided p-value from the SAME block-bootstrap distribution used for
    // the CI (consistent methodology, rather than a separately-resampled,
    // block-length-1 p-value): the bootstrap distribution of the mean IS an
    // estimate of the sampling distribution of the true mean, so the
    // fraction of it at or below 0 is directly the one-sided p-value for
    // H0: true mean ≤ 0 (equivalently, 1 - probPositive). A +1/(B+1)
    // continuity correction avoids reporting an exact 0.
    pValue = Math.max(1 / (bootMeans.length + 1), nBelowOrAtZero / bootMeans.length);
  }

  // Max drawdown of the cumulative-net-R equity curve (chronological).
  const chrono = [...ts].sort((a, b) => a.date.localeCompare(b.date)).map((t) => t.rNet);
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  for (const r of chrono) {
    cum += r;
    peak = Math.max(peak, cum);
    maxDd = Math.min(maxDd, cum - peak);
  }

  return {
    setupType,
    horizon,
    regime: null,
    rawTrades: ts.length,
    independentEntryDates: independentDates,
    rawIndependentDates,
    targetFirstRate: ts.length ? round4(ts.filter((t) => t.outcome === "TARGET_FIRST").length / ts.length) : 0,
    stopFirstRate: ts.length ? round4(ts.filter((t) => t.outcome === "STOP_FIRST").length / ts.length) : 0,
    timeoutRate: ts.length ? round4(ts.filter((t) => t.outcome === "TIMEOUT").length / ts.length) : 0,
    averageR: round4(expectancyNet),
    medianR: ts.length ? round4(sorted[Math.floor(sorted.length / 2)]) : 0,
    averageWinR: round4(mean(wins)),
    averageLossR: round4(mean(losses)),
    // Two DISTINCT numbers now — gross (before the per-trade cost/slippage
    // drag) and net (after it). Previously identical by construction.
    expectancyR: round4(expectancyGross),
    expectancyAfterCosts: round4(expectancyNet),
    profitFactor: losses.length && wins.length ? round4(wins.reduce((a, b) => a + b, 0) / Math.abs(losses.reduce((a, b) => a + b, 0))) : null,
    maxDrawdownR: round4(maxDd),
    bootstrapExpectancyCI: [round4(ciLower), round4(ciUpper)],
    probabilityExpectancyPositive: round4(probPositive),
    pValue,
  };
}

async function main(): Promise<void> {
  await AppDataSource.initialize();
  const nifty = await marketDataService.getNiftyBars("5y");
  const niftyCloses = new Map(nifty.map((b) => [b.date, b.close]));
  const genRand = mulberry32(4242); // trade generation is deterministic but does not itself need randomness — kept for parity with the prior script's PRNG threading

  const trades: Trade[] = [];
  let tk = 0;
  for (const u of NSE_UNIVERSE) {
    try {
      const bars = await marketDataService.getDailyBars(u.ticker, "5y");
      if (bars.length < 300) continue;
      const closes = analysisCloses(bars);
      for (let i = 260; i < bars.length - 25; i += STRIDE) {
        const slice = bars.slice(0, i + 1);
        const f = computeShortTermFeatures(slice, niftyCloses, null);
        if (!f) continue;
        const setup = classifySetup(f, { marketRegime: null, stockRegime: null, upcomingEventRisk: false });
        if (["NO_SETUP", "LATE_TREND", "FAILED_BREAKOUT", "HIGH_EVENT_RISK"].includes(setup.setupType)) continue;
        for (const h of HORIZONS) {
          const plan = buildTradePlan(f, setup, h);
          const entry = plan.entryZoneHigh ?? plan.entryTriggerPrice ?? f.price;
          const stop = plan.initialStop;
          const target = plan.target1;
          if (stop == null || target == null || !(entry > stop) || !(target > entry)) continue;
          const risk = entry - stop;
          const maxHold = HORIZON_TD[h].max;
          const orderVal = 100_000;
          const dragR = ((roundTripCostPct(orderVal) + estimateSlippagePct({ atrPct: f.atrPct, relVolume: f.relVolume, orderValueInr: orderVal, advInr: f.advInr20 })) / 100) * (entry / risk);

          let outcome: Trade["outcome"] = "TIMEOUT";
          let exit = closes[Math.min(i + maxHold, bars.length - 1)];
          for (let k = i + 1; k <= i + maxHold && k < bars.length; k++) {
            if (bars[k].open <= stop) { outcome = "STOP_FIRST"; exit = Math.min(bars[k].open, stop); break; }
            if (bars[k].open >= target) { outcome = "TARGET_FIRST"; exit = Math.max(bars[k].open, target); break; }
            if (bars[k].low <= stop) { outcome = "STOP_FIRST"; exit = stop; break; }
            if (bars[k].high >= target) { outcome = "TARGET_FIRST"; exit = target; break; }
          }
          const grossR = (exit - entry) / risk;
          trades.push({ date: bars[i].date, setupType: setup.setupType, horizon: h, rGross: round4(grossR), rNet: round4(grossR - dragR), outcome });
        }
      }
      if (++tk % 25 === 0) console.log(`  • ${tk} tickers, ${trades.length} trades`);
    } catch {
      /* skipped */
    }
  }
  console.log(`total trades: ${trades.length}`);
  if (trades.length === 0) {
    console.log("no trades generated — nothing to persist.");
    await AppDataSource.destroy();
    return;
  }

  // ── Train/test split on the SHARED entry calendar (Correction 1) ─────────
  // Setup rules are fixed code, not fit here, so this protects against
  // "looked good on the only data we ever checked" rather than in-sample
  // overfitting of a trained model — but it is the honest standard the rest
  // of the research pipeline (experiments/splits.ts, research/harness.ts)
  // already applies, and this study should not be exempt from it.
  const allDates = [...new Set(trades.map((t) => t.date))].sort();
  let testStartDate: string | null = null;
  let trainDates = new Set<string>();
  let testDates = new Set<string>();
  try {
    const splits = buildPurgedSplits({
      dates: allDates,
      horizonDays: PURGE_CALENDAR_DAYS,
      embargoDays: EMBARGO_CALENDAR_DAYS,
      trainFrac: 0.55,
      valFrac: 0.15,
      calFrac: 0.1, // train+val+cal = 0.8 → test is the most recent ~20% after purge/embargo
    });
    trainDates = new Set([...splits.train, ...splits.validation, ...splits.calibration]);
    testDates = new Set(splits.test);
    testStartDate = splits.test[0] ?? null;
    console.log(`split: ${splits.train.length} train / ${splits.validation.length} val / ${splits.calibration.length} cal / ${splits.test.length} test dates` +
      ` (purged ${splits.purgedFromTrain.length + splits.purgedFromValidation.length + splits.purgedFromCalibration.length}, embargoed ${splits.embargoed.length})`);
  } catch (e) {
    console.log(`train/test split unavailable (${(e as Error).message}) — insufficient calendar span; ALL cells will be reported in-sample only, none promotable to tier A.`);
  }

  // Aggregate per setup×horizon, separately for the FULL history (in-sample,
  // reported for comparison only) and the TEST segment (the only segment a
  // tier can be earned from).
  const cellKey = (t: Trade) => `${t.setupType}|${t.horizon}`;
  const allGroups = new Map<string, Trade[]>();
  const testGroups = new Map<string, Trade[]>();
  for (const t of trades) {
    allGroups.set(cellKey(t), [...(allGroups.get(cellKey(t)) ?? []), t]);
    if (testStartDate != null && testDates.has(t.date)) {
      testGroups.set(cellKey(t), [...(testGroups.get(cellKey(t)) ?? []), t]);
    }
  }

  const inSampleRand = mulberry32(4242);
  const testRand = mulberry32(4243); // different stream than in-sample, so the test verdict cannot inherit any artifact of the in-sample draw sequence
  const inSampleCells = [...allGroups.entries()].map(([key, ts]) => {
    const [setupType, horizon] = key.split("|");
    return buildCell(setupType, horizon, ts, inSampleRand);
  });
  const testCells = [...testGroups.entries()].map(([key, ts]) => {
    const [setupType, horizon] = key.split("|");
    return buildCell(setupType, horizon, ts, testRand);
  });

  // BH-FDR across the TEST cells only — that is the family actually being
  // used for promotion, so it is the family that must be corrected.
  const bh = testCells.length > 0 ? benjaminiHochberg(testCells.map((c) => c.pValue), 0.1) : [];
  const finalTestCells = testCells.map((c, i) => {
    const sig = bh[i]?.significant ?? false;
    const base = { ...c, bhSignificant: sig, bhAdjustedP: bh[i]?.adjusted ?? 1 } as Record<string, unknown>;
    const tier = tierFromEvidence({
      ...(base as never),
      bootstrapExpectancyCI: c.bootstrapExpectancyCI as [number, number],
    });
    return { ...base, evidenceStrength: tier.tier, evidenceStage: tier.stage, usableForEntry: tier.usable, note: tier.note };
  });

  // ── Overfitting controls (Correction 5): DSR + PBO, now actually run ─────
  // Sharpe per cell = mean(R)/sd(R) over the TEST segment's per-trade R
  // series — a per-trade, not per-period, Sharpe (nPeriods = trade count).
  // nTrials is a floor: it counts the setup×horizon cells examined HERE, not
  // the additional degrees of freedom spent choosing the setup-detection
  // thresholds during earlier development, which this script cannot see.
  const stdev = (xs: number[]): number => {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
  };
  const nTrials = Math.max(1, finalTestCells.length);
  let bestDsr: ReturnType<typeof deflatedSharpeRatio> | null = null;
  let bestCellKey: string | null = null;
  for (const [key, ts] of testGroups) {
    const rs = ts.map((t) => t.rNet);
    const sd = stdev(rs);
    if (sd <= 0 || rs.length < 5) continue;
    const sharpe = mean(rs) / sd;
    const dsr = deflatedSharpeRatio(sharpe, rs.length, nTrials);
    if (bestDsr == null || dsr.observedSharpe > bestDsr.observedSharpe) {
      bestDsr = dsr;
      bestCellKey = key;
    }
  }

  // PBO: strategies = test cells with enough trades to bin; periods = 8
  // roughly-equal-width time blocks across the test segment's date range.
  let pbo: ReturnType<typeof probabilityOfBacktestOverfitting> = null;
  {
    const S = 8;
    const eligible = [...testGroups.entries()].filter(([, ts]) => new Set(ts.map((t) => t.date)).size >= S * 2);
    if (eligible.length >= 2) {
      const testDateList = [...testDates].sort();
      const T = testDateList.length;
      if (T >= S * 2) {
        const blockLen = Math.floor(T / S);
        const periodOf = (d: string): number => Math.min(S - 1, Math.floor(testDateList.indexOf(d) / blockLen));
        const perf: number[][] = eligible.map(([, ts]) => {
          const byPeriod: number[][] = Array.from({ length: S }, () => []);
          for (const t of ts) {
            const idx = testDateList.indexOf(t.date);
            if (idx < 0) continue;
            byPeriod[periodOf(t.date)].push(t.rNet);
          }
          return byPeriod.map((xs) => mean(xs));
        });
        pbo = probabilityOfBacktestOverfitting(perf, S);
      }
    }
  }

  const repo = AppDataSource.getRepository(ShortTermModelPerformance);
  const promotedCount = finalTestCells.filter((c) => c.usableForEntry).length;
  await repo.save(
    repo.create({
      modelName: "st-setup-expectancy",
      modelVersion: "st-setup-expectancy-v2", // v2: train/test split + real block bootstrap + overlap-adjusted dates + DSR/PBO (docs/system-trust-review.md §4.2)
      state: "SHADOW",
      metrics: {
        cells: finalTestCells, // OUT-OF-SAMPLE — the only cells a tier/promotion may be read from
        inSampleCells, // full-history, IN-SAMPLE — comparison only, never gates anything
        tradeCount: trades.length,
        stride: STRIDE,
        horizons: HORIZONS,
        split: testStartDate != null ? { testStartDate, testDateCount: testDates.size, trainDateCount: trainDates.size } : null,
        overfitting: {
          nTrials,
          bestCell: bestCellKey,
          deflatedSharpe: bestDsr,
          probabilityOfBacktestOverfitting: pbo,
        },
      },
      verdict: `${promotedCount}/${finalTestCells.length} setup×horizon cells qualify for TIER A entry on the OUT-OF-SAMPLE test segment (positive after-cost expectancy, block-bootstrap CI lower > 0, ≥60 overlap-adjusted independent dates, BH-significant)` +
        (bestDsr ? `; best cell (${bestCellKey}) DSR=${bestDsr.deflatedSharpeProbability} (passes ${bestDsr.passes ? "≥0.95" : "< 0.95 — NOT distinguishable from selection luck"})` : "") +
        (pbo ? `; PBO=${pbo.pbo} across ${pbo.combinations} in/out combinations` : "") +
        `. Methodology v2 supersedes the v1 in-sample, block-length-1-bootstrap study — numbers are not comparable to prior runs.`,
    })
  );

  console.log("\nOUT-OF-SAMPLE (test segment) setup × horizon expectancy (R, net of costs):");
  console.log("setup                   hz     n    indDates  targetR/stopR/timeout   E[R]    CIlow  P(>0)  BH   tier  usable");
  for (const c of finalTestCells.sort((a, b) => (b.expectancyAfterCosts as number) - (a.expectancyAfterCosts as number))) {
    console.log(
      `${String(c.setupType).padEnd(23)} ${String(c.horizon).padEnd(6)} ${String(c.rawTrades).padEnd(5)} ${String(c.independentEntryDates).padEnd(8)} ` +
        `${String(c.targetFirstRate)}/${String(c.stopFirstRate)}/${String(c.timeoutRate)}`.padEnd(23) +
        ` ${String(c.expectancyAfterCosts).padStart(6)} ${String((c.bootstrapExpectancyCI as number[])[0]).padStart(6)} ${String(c.probabilityExpectancyPositive).padStart(5)}  ${c.bhSignificant ? "Y" : "n"}    ${c.evidenceStrength}     ${c.usableForEntry ? "YES" : "no"}`
    );
  }
  console.log(`\nverdict: ${promotedCount}/${finalTestCells.length} cells TIER A (out-of-sample).`);
  if (bestDsr) console.log(`Deflated Sharpe (best cell ${bestCellKey}): ${bestDsr.deflatedSharpeProbability} (${bestDsr.passes ? "PASSES" : "FAILS"} the ≥0.95 selection-luck bar, nTrials=${nTrials})`);
  if (pbo) console.log(`Probability of backtest overfitting: ${pbo.pbo} (${pbo.combinations} combinations)`);
  console.log("\n[in-sample, full-history numbers — NOT evidentiary, comparison only]");
  for (const c of inSampleCells.sort((a, b) => (b.expectancyAfterCosts as number) - (a.expectancyAfterCosts as number))) {
    console.log(`  ${String(c.setupType).padEnd(23)} ${String(c.horizon).padEnd(6)} n=${c.rawTrades} E[R]=${c.expectancyAfterCosts}`);
  }
  await AppDataSource.destroy();
}

// Guarded so this file can be imported by tests (for buildCell's pure logic)
// without running the full DB-backed, network-fetching study.
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
