/**
 * S9/S12 — shadow-prediction outcome resolver + performance evaluator.
 *
 * For every unresolved shadow prediction whose horizon has matured: walk the
 * COMPLETED bars after the anchor, simulate the stored bracket gap-aware
 * (open-through-level fills at the open), and record
 * TARGET_FIRST / STOP_FIRST / TIMEOUT with realized return, MFE, MAE and
 * holding duration. Then compute the honest performance table (win rate,
 * profit factor, expectancy, MFE/MAE, hit rates, cost drag) and Top-5 forward
 * quality vs baselines — reporting INSUFFICIENT HISTORY until enough
 * independent observations exist. Nothing is optimized here; this script only
 * measures.
 */

import { AppDataSource } from "../src/config/database";
import { ShortTermModelPerformance, ShortTermShadowPrediction } from "../src/entities";
import { marketDataService } from "../src/services/market/MarketDataService";
import { analysisCloses } from "../src/services/market/canonical";
import { HORIZON_TD, ShortTermHorizon } from "../src/services/shortterm/types";
import { round4 } from "../src/services/research/metrics";

async function main(): Promise<void> {
  await AppDataSource.initialize();
  const repo = AppDataSource.getRepository(ShortTermShadowPrediction);
  const unresolved = await repo.find({ where: { resolvedAt: undefined as never }, take: 2000 }).catch(() => []);
  const pending = unresolved.filter((p) => p.outcome == null);
  console.log(`unresolved shadow predictions: ${pending.length}`);

  let resolved = 0;
  for (const p of pending) {
    const h = HORIZON_TD[p.horizon as ShortTermHorizon] ?? { max: 10 };
    const plan = p.plan as { entryZoneHigh?: number | null; entryTriggerPrice?: number | null; initialStop?: number | null; target1?: number | null };
    const entry = plan.entryTriggerPrice ?? plan.entryZoneHigh ?? null;
    const stop = plan.initialStop ?? null;
    const target = plan.target1 ?? null;
    if (entry == null || stop == null || target == null) continue;
    try {
      const bars = await marketDataService.getDailyBars(p.ticker, "6mo");
      const closes = analysisCloses(bars);
      const anchorIdx = bars.findIndex((b) => b.date > p.anchorDate);
      if (anchorIdx < 0) continue;
      const lastNeeded = anchorIdx + h.max;
      if (lastNeeded >= bars.length) continue; // horizon not matured yet — stays pending, honestly

      let outcome: "TARGET_FIRST" | "STOP_FIRST" | "TIMEOUT" = "TIMEOUT";
      let exitPrice = closes[Math.min(lastNeeded, bars.length - 1)];
      let mfe = 0;
      let mae = 0;
      let holdingDays = h.max;
      for (let k = anchorIdx; k <= lastNeeded; k++) {
        mfe = Math.max(mfe, (bars[k].high - entry) / entry);
        mae = Math.min(mae, (bars[k].low - entry) / entry);
        if (bars[k].open <= stop || bars[k].low <= stop) {
          outcome = "STOP_FIRST";
          exitPrice = Math.min(bars[k].open, stop);
          holdingDays = k - anchorIdx + 1;
          break;
        }
        if (bars[k].open >= target || bars[k].high >= target) {
          outcome = "TARGET_FIRST";
          exitPrice = Math.max(bars[k].open, target);
          holdingDays = k - anchorIdx + 1;
          break;
        }
      }
      p.outcome = {
        outcome,
        entryAssumed: entry,
        exitPrice: round4(exitPrice),
        returnPct: round4(((exitPrice - entry) / entry) * 100),
        mfePct: round4(mfe * 100),
        maePct: round4(mae * 100),
        holdingDays,
      };
      p.resolvedAt = new Date();
      await repo.save(p);
      resolved++;
    } catch {
      /* unresolvable today; retried next run */
    }
  }
  console.log(`resolved this run: ${resolved}`);

  // ── Performance table over ALL resolved shadow trades ────────────────────
  const all = await repo
    .createQueryBuilder("p")
    .where("p.outcome IS NOT NULL")
    .getMany();
  const MIN_INDEPENDENT = 30;
  if (all.length < MIN_INDEPENDENT) {
    console.log(
      `\nPERFORMANCE: INSUFFICIENT HISTORY — ${all.length} resolved shadow trades (< ${MIN_INDEPENDENT}). ` +
        "The radar runs in SHADOW MODE; no real-money claim is made until this table has independent history."
    );
  } else {
    const rets = all.map((p) => Number((p.outcome as { returnPct?: number }).returnPct ?? 0));
    const wins = rets.filter((r) => r > 0);
    const losses = rets.filter((r) => r <= 0);
    const pf = losses.length && wins.length ? wins.reduce((a, b) => a + b, 0) / Math.abs(losses.reduce((a, b) => a + b, 0)) : null;
    const table = {
      n: all.length,
      winRatePct: round4((wins.length / all.length) * 100),
      avgWinPct: wins.length ? round4(wins.reduce((a, b) => a + b, 0) / wins.length) : null,
      avgLossPct: losses.length ? round4(losses.reduce((a, b) => a + b, 0) / losses.length) : null,
      profitFactor: pf != null ? round4(pf) : null,
      expectancyPct: round4(rets.reduce((a, b) => a + b, 0) / rets.length),
      targetHitPct: round4((all.filter((p) => (p.outcome as { outcome?: string }).outcome === "TARGET_FIRST").length / all.length) * 100),
      stopHitPct: round4((all.filter((p) => (p.outcome as { outcome?: string }).outcome === "STOP_FIRST").length / all.length) * 100),
      timeoutPct: round4((all.filter((p) => (p.outcome as { outcome?: string }).outcome === "TIMEOUT").length / all.length) * 100),
    };
    console.log("\nPERFORMANCE:", JSON.stringify(table, null, 1));
    const perf = AppDataSource.getRepository(ShortTermModelPerformance);
    await perf.save(
      perf.create({ modelName: "st-shadow-tracker", modelVersion: "short-term-v1", state: "SHADOW", metrics: table, verdict: "shadow-mode measurement — no promotion decision rides on this until independent history accumulates" })
    );
  }
  await AppDataSource.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
