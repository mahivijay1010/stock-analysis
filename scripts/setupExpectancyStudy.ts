/**
 * OFFLINE RESEARCH (V2-3/V2-10): setup-specific realized-R expectancy study.
 *
 * For every historical anchor where the LIVE setup classifier fires, build the
 * SAME trade plan the radar builds (entry ref / structural stop / ATR target)
 * and simulate the bracket forward on completed bars, GAP-AWARE (an open
 * through a level fills at the open). Record the realized R-multiple —
 * including TIMEOUT trades' actual P&L in R — then per setupType×horizon:
 *   targetFirst/stopFirst/timeout rates, mean/median R, win/loss R,
 *   after-cost expectancy R, profit factor, max drawdown R, a block-bootstrap
 *   expectancy CI, P(expectancy>0), a one-sided bootstrap p-value, and a
 *   Benjamini–Hochberg FDR flag across ALL cells (many are tested).
 *
 * Independence: entries on the same calendar date are correlated, so
 * `independentEntryDates` (distinct anchor dates) — not raw trade count — is
 * the sample size that must clear the promotion floor.
 *
 * Pre-registered promotion (SETUP_PROMOTION in setupEvidence.ts) is applied to
 * derive each cell's tier + usableForEntry. Persisted to
 * short_term_model_performance (model_name 'st-setup-expectancy'); nothing is
 * hardcoded per setup.
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
import { benjaminiHochberg, bootstrapPValueMeanPositive } from "../src/services/shortterm/shrinkage";
import { mulberry32 } from "../src/services/quant/montecarlo";
import { round4 } from "../src/services/research/metrics";

const HORIZONS: ShortTermHorizon[] = ["3-5d", "5-10d", "10-21d"];
const STRIDE = 3;

interface Trade {
  date: string;
  setupType: string;
  horizon: string;
  r: number; // realized R-multiple, net of costs
  outcome: "TARGET_FIRST" | "STOP_FIRST" | "TIMEOUT";
}

async function main(): Promise<void> {
  await AppDataSource.initialize();
  const nifty = await marketDataService.getNiftyBars("5y");
  const niftyCloses = new Map(nifty.map((b) => [b.date, b.close]));
  const rand = mulberry32(4242);

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
          trades.push({ date: bars[i].date, setupType: setup.setupType, horizon: h, r: round4(grossR - dragR), outcome });
        }
      }
      if (++tk % 25 === 0) console.log(`  • ${tk} tickers, ${trades.length} trades`);
    } catch {
      /* skipped */
    }
  }
  console.log(`total trades: ${trades.length}`);

  // Aggregate per setup×horizon.
  const cellKey = (t: Trade) => `${t.setupType}|${t.horizon}`;
  const groups = new Map<string, Trade[]>();
  for (const t of trades) groups.set(cellKey(t), [...(groups.get(cellKey(t)) ?? []), t]);

  const cells: Array<Record<string, unknown> & { pValue: number }> = [];
  for (const [key, ts] of groups) {
    const [setupType, horizon] = key.split("|");
    const rs = ts.map((t) => t.r);
    const wins = rs.filter((r) => r > 0);
    const losses = rs.filter((r) => r <= 0);
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const sorted = [...rs].sort((a, b) => a - b);
    const expectancy = mean(rs);
    const independentDates = new Set(ts.map((t) => t.date)).size;

    // Block bootstrap by date for the expectancy CI (independence-aware).
    const byDate = new Map<string, number[]>();
    for (const t of ts) byDate.set(t.date, [...(byDate.get(t.date) ?? []), t.r]);
    const dateMeans = Array.from(byDate.values()).map((v) => mean(v));
    const boot: number[] = [];
    for (let b = 0; b < 1000; b++) {
      let s = 0;
      for (let k = 0; k < dateMeans.length; k++) s += dateMeans[Math.floor(rand() * dateMeans.length)];
      boot.push(s / dateMeans.length);
    }
    boot.sort((a, b) => a - b);
    const ciLower = boot[Math.floor(0.05 * boot.length)];
    const ciUpper = boot[Math.floor(0.95 * boot.length)];
    const pValue = bootstrapPValueMeanPositive(dateMeans, 2000, rand);

    // Max drawdown of the cumulative-R equity curve (chronological).
    const chrono = [...ts].sort((a, b) => a.date.localeCompare(b.date)).map((t) => t.r);
    let cum = 0;
    let peak = 0;
    let maxDd = 0;
    for (const r of chrono) {
      cum += r;
      peak = Math.max(peak, cum);
      maxDd = Math.min(maxDd, cum - peak);
    }

    cells.push({
      setupType,
      horizon,
      regime: null,
      rawTrades: ts.length,
      independentEntryDates: independentDates,
      targetFirstRate: round4(ts.filter((t) => t.outcome === "TARGET_FIRST").length / ts.length),
      stopFirstRate: round4(ts.filter((t) => t.outcome === "STOP_FIRST").length / ts.length),
      timeoutRate: round4(ts.filter((t) => t.outcome === "TIMEOUT").length / ts.length),
      averageR: round4(expectancy),
      medianR: round4(sorted[Math.floor(sorted.length / 2)]),
      averageWinR: round4(mean(wins)),
      averageLossR: round4(mean(losses)),
      expectancyR: round4(expectancy),
      expectancyAfterCosts: round4(expectancy), // already net of costs per-trade
      profitFactor: losses.length && wins.length ? round4(wins.reduce((a, b) => a + b, 0) / Math.abs(losses.reduce((a, b) => a + b, 0))) : null,
      maxDrawdownR: round4(maxDd),
      bootstrapExpectancyCI: [round4(ciLower), round4(ciUpper)],
      probabilityExpectancyPositive: round4(boot.filter((m) => m > 0).length / boot.length),
      pValue,
    });
  }

  // Benjamini–Hochberg across ALL cells (multiple testing, Part 8).
  const bh = benjaminiHochberg(cells.map((c) => c.pValue), 0.1);
  const finalCells = cells.map((c, i) => {
    const sig = bh[i].significant;
    const base = { ...c, bhSignificant: sig, bhAdjustedP: bh[i].adjusted } as Record<string, unknown>;
    const tier = tierFromEvidence({
      ...(base as never),
      bootstrapExpectancyCI: c.bootstrapExpectancyCI as [number, number],
    });
    return { ...base, evidenceStrength: tier.tier, usableForEntry: tier.usable, note: tier.note };
  });

  const repo = AppDataSource.getRepository(ShortTermModelPerformance);
  const promotedCount = finalCells.filter((c) => c.usableForEntry).length;
  await repo.save(
    repo.create({
      modelName: "st-setup-expectancy",
      modelVersion: "st-setup-expectancy-v1",
      state: "SHADOW",
      metrics: { cells: finalCells, tradeCount: trades.length, stride: STRIDE, horizons: HORIZONS },
      verdict: `${promotedCount}/${finalCells.length} setup×horizon cells qualify for TIER A entry (positive after-cost expectancy, CI lower > 0, ≥60 independent dates, BH-significant).`,
    })
  );

  console.log("\nsetup × horizon expectancy (R, net of costs):");
  console.log("setup                   hz     n    indDates  targetR/stopR/timeout   E[R]    CIlow  P(>0)  BH   tier  usable");
  for (const c of finalCells.sort((a, b) => (b.expectancyR as number) - (a.expectancyR as number))) {
    console.log(
      `${String(c.setupType).padEnd(23)} ${String(c.horizon).padEnd(6)} ${String(c.rawTrades).padEnd(5)} ${String(c.independentEntryDates).padEnd(8)} ` +
        `${String(c.targetFirstRate)}/${String(c.stopFirstRate)}/${String(c.timeoutRate)}`.padEnd(23) +
        ` ${String(c.expectancyR).padStart(6)} ${String((c.bootstrapExpectancyCI as number[])[0]).padStart(6)} ${String(c.probabilityExpectancyPositive).padStart(5)}  ${c.bhSignificant ? "Y" : "n"}    ${c.evidenceStrength}     ${c.usableForEntry ? "YES" : "no"}`
    );
  }
  console.log(`\nverdict: ${promotedCount}/${finalCells.length} cells TIER A.`);
  await AppDataSource.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
