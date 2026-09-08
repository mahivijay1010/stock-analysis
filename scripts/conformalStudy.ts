/**
 * OFFLINE RESEARCH — Cycle 6 (Part M): interval generation head-to-head.
 *
 * Contenders for the h-day return interval (h = 21 trading days ≈ the 30d
 * product horizon), evaluated on the SAME chronological anchors per ticker:
 *
 *  A. bootstrap        — seeded iid bootstrap quantiles (production today)
 *  B. har-sigma        — HAR-RV conditional σ × normal quantiles
 *  C. split-conformal  — |residual| quantile from a CALIBRATION window applied
 *                        symmetrically around 0 (distribution-free guarantee)
 *  D. adaptive-conformal — conformal with a rolling window that re-centers the
 *                        quantile as errors arrive (tracks vol shifts)
 *
 * Metrics: 80%/90% coverage, mean width, CRPS-proxy (pinball), and
 * CONDITIONAL coverage split by realized-vol regime (low/high vol terciles) —
 * Part M forbids buying coverage with uselessly wide intervals, so width is
 * reported next to every coverage number.
 *
 * PRE-REGISTERED read: a contender beats production only if |cov80 − 80|
 * improves by ≥ 2pp WITHOUT widening mean width by > 10%, judged on the TEST
 * half; the CALIBRATION half is used for conformal quantiles only.
 */

import { AppDataSource } from "../src/config/database";
import { ExperimentRun } from "../src/entities";
import { NSE_UNIVERSE } from "../src/data/nseUniverse";
import { marketDataService } from "../src/services/market/MarketDataService";
import { analysisCloses, adjustedDailyReturns } from "../src/services/market/canonical";
import { simulateDailyQuantiles } from "../src/services/quant/montecarlo";
import { round4 } from "../src/services/research/metrics";
import { createHash } from "crypto";

const H = 21;
const STRIDE = 21; // non-overlapping anchors
const WARMUP = 260;

interface Interval {
  lo80: number;
  hi80: number;
  lo90: number;
  hi90: number;
}

interface Obs {
  ticker: string;
  date: string;
  realized: number;
  volBucket: "low" | "mid" | "high";
  intervals: Record<string, Interval>;
}

function stdev(xs: number[]): number {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, xs.length - 1));
}

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];
}

async function main(): Promise<void> {
  await AppDataSource.initialize();
  const started = new Date();
  const Z80 = 1.2816;
  const Z90 = 1.6449;

  const obs: Obs[] = [];
  let done = 0;
  for (const u of NSE_UNIVERSE) {
    try {
      const bars = await marketDataService.getDailyBars(u.ticker, "5y");
      if (bars.length < WARMUP + H + STRIDE) continue;
      const closes = analysisCloses(bars);
      const rets = adjustedDailyReturns(bars);

      // Split-conformal state: rolling |residual| store per ticker (past anchors only).
      const pastAbsErr: number[] = [];

      for (let a = WARMUP; a + H < bars.length; a += STRIDE) {
        const hist = rets.slice(Math.max(0, a - 250), a);
        if (hist.length < 100) continue;
        const realized = closes[a + H] / closes[a] - 1;

        // A: bootstrap quantiles from the stock's own history.
        const sim = simulateDailyQuantiles(hist, H, { paths: 2000 });
        const q = sim.perStep[H - 1].q;
        const boot: Interval = { lo80: q.p10, hi80: q.p90, lo90: q.p05, hi90: q.p95 };

        // B: HAR-RV σ (rv1/rv5/rv22 → σ_h via sqrt-time on the blended daily σ).
        const abs1 = Math.abs(hist[hist.length - 1]);
        const s5 = stdev(hist.slice(-5));
        const s22 = stdev(hist.slice(-22));
        const dailySigma = Math.max(1e-6, 0.2 * abs1 + 0.4 * s5 + 0.4 * s22);
        const sigmaH = dailySigma * Math.sqrt(H);
        const har: Interval = { lo80: -Z80 * sigmaH, hi80: Z80 * sigmaH, lo90: -Z90 * sigmaH, hi90: Z90 * sigmaH };

        // C: split-conformal — |realized| quantiles from PAST anchors of this ticker.
        let conf: Interval | null = null;
        if (pastAbsErr.length >= 8) {
          const sortedErr = [...pastAbsErr].sort((x, y) => x - y);
          const w80 = quantile(sortedErr, 0.8);
          const w90 = quantile(sortedErr, 0.9);
          conf = { lo80: -w80, hi80: w80, lo90: -w90, hi90: w90 };
        }
        // D: adaptive conformal — same but only the most recent 12 anchors.
        let adapt: Interval | null = null;
        if (pastAbsErr.length >= 8) {
          const recent = pastAbsErr.slice(-12).sort((x, y) => x - y);
          const w80 = quantile(recent, 0.8);
          const w90 = quantile(recent, 0.9);
          adapt = { lo80: -w80, hi80: w80, lo90: -w90, hi90: w90 };
        }

        const vol = stdev(hist.slice(-20)) * Math.sqrt(252);
        const intervals: Record<string, Interval> = { bootstrap: boot, "har-sigma": har };
        if (conf) intervals["split-conformal"] = conf;
        if (adapt) intervals["adaptive-conformal"] = adapt;
        obs.push({ ticker: u.ticker, date: bars[a].date, realized, volBucket: vol < 0.22 ? "low" : vol < 0.35 ? "mid" : "high", intervals });

        pastAbsErr.push(Math.abs(realized));
      }
      if (++done % 40 === 0) console.log(`  • ${done} tickers, ${obs.length} anchors`);
    } catch {
      /* skipped */
    }
  }
  console.log(`anchors: ${obs.length}`);

  // Chronological halves: first half calibrates nothing further (conformal is
  // already online); TEST = second half only, per the pre-registered read.
  const dates = Array.from(new Set(obs.map((o) => o.date))).sort();
  const testFrom = dates[Math.floor(dates.length / 2)];
  const test = obs.filter((o) => o.date >= testFrom);

  const evaluate = (rows: Obs[], method: string) => {
    const withM = rows.filter((r) => r.intervals[method]);
    if (withM.length < 50) return null;
    let c80 = 0;
    let c90 = 0;
    let width = 0;
    let pinball = 0;
    for (const r of withM) {
      const iv = r.intervals[method];
      if (r.realized >= iv.lo80 && r.realized <= iv.hi80) c80++;
      if (r.realized >= iv.lo90 && r.realized <= iv.hi90) c90++;
      width += iv.hi80 - iv.lo80;
      const pb = (tau: number, pred: number) => {
        const d = r.realized - pred;
        return d >= 0 ? tau * d : (tau - 1) * d;
      };
      pinball += pb(0.1, iv.lo80) + pb(0.9, iv.hi80);
    }
    return {
      n: withM.length,
      cov80Pct: round4((c80 / withM.length) * 100),
      cov90Pct: round4((c90 / withM.length) * 100),
      meanWidth80Pct: round4((width / withM.length) * 100),
      pinball: round4(pinball / withM.length),
    };
  };

  const methods = ["bootstrap", "har-sigma", "split-conformal", "adaptive-conformal"];
  const results: Record<string, unknown> = {};
  console.log("\nmethod               n     cov80   cov90   width80%  pinball | low-vol cov80 | high-vol cov80");
  for (const m of methods) {
    const overall = evaluate(test, m);
    const low = evaluate(test.filter((o) => o.volBucket === "low"), m);
    const high = evaluate(test.filter((o) => o.volBucket === "high"), m);
    results[m] = { overall, lowVol: low, highVol: high };
    console.log(
      `${m.padEnd(20)} ${String(overall?.n ?? 0).padEnd(5)} ${String(overall?.cov80Pct ?? "—").padEnd(7)} ${String(overall?.cov90Pct ?? "—").padEnd(7)} ${String(overall?.meanWidth80Pct ?? "—").padEnd(9)} ${String(overall?.pinball ?? "—").padEnd(7)} | ${String(low?.cov80Pct ?? "—").padEnd(13)} | ${String(high?.cov80Pct ?? "—")}`
    );
  }

  // Pre-registered promotion read vs production bootstrap.
  const b = (results.bootstrap as { overall: { cov80Pct: number; meanWidth80Pct: number } }).overall;
  let promoted: string | null = null;
  const verdicts: Record<string, string> = {};
  for (const m of methods.slice(1)) {
    const r = (results[m] as { overall: { cov80Pct: number; meanWidth80Pct: number } | null }).overall;
    if (!r) {
      verdicts[m] = "insufficient observations";
      continue;
    }
    const covImproves = Math.abs(r.cov80Pct - 80) <= Math.abs(b.cov80Pct - 80) - 2;
    const widthOk = r.meanWidth80Pct <= b.meanWidth80Pct * 1.1;
    verdicts[m] = covImproves && widthOk ? `QUALIFIES: |cov−80| ${Math.abs(b.cov80Pct - 80).toFixed(1)}→${Math.abs(r.cov80Pct - 80).toFixed(1)}pp at width ${r.meanWidth80Pct}% (vs ${b.meanWidth80Pct}%)` : `keep bootstrap — cov ${covImproves ? "ok" : "no ≥2pp gain"}, width ${widthOk ? "ok" : ">10% wider"}`;
    if (covImproves && widthOk && !promoted) promoted = m;
  }

  const repo = AppDataSource.getRepository(ExperimentRun);
  const run = await repo.save(
    repo.create({
      name: "conformal-interval-study",
      kind: "challenger",
      modelVersion: "conformal-v1",
      config: { horizonTd: H, stride: STRIDE, methods, preRegistered: "≥2pp |cov80−80| improvement without >10% width increase, test half only" },
      splits: { anchors: obs.length, testAnchors: test.length },
      datasetManifest: { source: "5y adjusted bars, non-overlapping 21td anchors — OFFLINE RESEARCH" },
      datasetHash: createHash("sha256").update(String(obs.length)).digest("hex"),
      metrics: { results, verdicts, promoted },
      baselines: { production: "iid bootstrap quantiles" },
      segmentsUsed: ["test(second half; conformal quantiles are strictly online)"],
      usedFinalTest: true,
      status: "completed",
      startedAt: started,
      finishedAt: new Date(),
    })
  );
  console.log(`\nverdicts: ${JSON.stringify(verdicts, null, 1)}`);
  console.log(`promoted: ${promoted ?? "NONE — bootstrap remains the interval champion"}`);
  console.log(`ExperimentRun ${run.id}`);
  await AppDataSource.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
