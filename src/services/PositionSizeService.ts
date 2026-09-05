/**
 * V8 R4 + V9 E2 + V10 B3 — PositionSizeService: measured inputs for the PURE
 * Kelly math (quant/kelly.ts), with every fallback STATED in the response.
 *
 * V8 block (unchanged — these are the "model"-labeled sources):
 *  - winRate p: this ticker's 7d direction hit rate from its walk-forward
 *    backtest (ModelPerformance) when it has ≥30 samples; else the
 *    sample-weighted universe aggregate 7d hit rate; else a neutral 0.5.
 *  - payoff b: |avg win / avg loss| measured from the desk's closed paper
 *    trades when ≥10 have closed (with at least one win AND one loss).
 *
 * V10 B3 payoff precedence — measured > dcf-implied > structural:
 *  - when measured b is NOT usable AND the ticker has a STORED Intelligence
 *    DCF, the payoff prior is (base-or-bull upside)/(|bear downside|) from the
 *    stored scenario intrinsic values, clamped to [0.5, 3.0] and labeled
 *    "DCF-implied (assumption-sensitive — bear/base/bull scenarios, not
 *    measured)"; else the structural 1.5 stands, unchanged. Measured b ALWAYS
 *    wins once usable. payoff.kind = measured | dcf-implied | structural.
 *
 * V9 adaptive layer (SPEC_V9 E2 — log → measure → adapt):
 *  - measured block: the desk's OWN last-30-window win rate and payoff from
 *    ExecutionAnalyticsService (the PaperTrade ledger is the execution log).
 *  - selection rule: p := measuredP when usable (≥30 closed) else model p;
 *    b := measuredB when usable (≥10 in-window, both sides) else the V10
 *    fallback (dcf prior when stored, structural 1.5 otherwise). The applied
 *    LABEL vocabulary is unchanged — the b source detail is payoff.kind/source.
 *
 * The HEADLINE is HALF-Kelly: full Kelly maximizes log growth only when p and
 * b are exactly right, and ours are noisy estimates.
 */

import { AppDataSource } from "../config/database";
import { ModelPerformance } from "../entities/ModelPerformance";
import { PaperTrade } from "../entities/PaperTrade";
import { marketDataService } from "./market/MarketDataService";
import { computeKelly, KELLY_CAP } from "./quant/kelly";
import {
  dcfImpliedPayoff,
  DcfImpliedPayoff,
  DCF_PRIOR_MAX,
  DCF_PRIOR_MIN,
  DCF_PRIOR_SOURCE_LABEL,
} from "./quant/dcfPrior";
import { IntelligenceRepository } from "./intelligence/IntelligenceRepository";
import { executionAnalyticsService } from "./admin/ExecutionAnalyticsService";
import {
  selectAppliedPair,
  ExecutionWindowStats,
  MIN_TRADES_FOR_MEASURED_P,
  STRUCTURAL_PAYOFF_B,
} from "./admin/executionStats";
import {
  HttpError,
  KellyInputStat,
  KellyAppliedPairLabel,
  PositionSizeMeasuredBlock,
  PositionSizeResponse,
} from "../types";

const MODEL_VERSION = "quant-v1"; // same rows /api/accuracy reads
const MIN_PER_STOCK_SAMPLES = 30;
const MIN_CLOSED_TRADES = 10;
const STRUCTURAL_B = 1.5;

const round2 = (x: number): number => Math.round(x * 100) / 100;
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
const pct = (fraction: number): string => `${round2(fraction * 100)}%`;

export class PositionSizeService {
  private readonly intelligenceRepository = new IntelligenceRepository();

  async getPositionSize(
    tickerOrName: string,
    capital: number
  ): Promise<PositionSizeResponse> {
    const resolved = await marketDataService.resolve(tickerOrName);
    if (!resolved) {
      throw new HttpError(
        404,
        `Could not resolve "${tickerOrName}" to an Indian (NSE/BSE) listing.`
      );
    }
    const ticker = resolved.ticker;
    const warnings: string[] = [];

    // Live quote first (V10: the DCF prior compares intrinsic values against
    // the CURRENT price) — still used for the share count at the end.
    let livePrice: number | null = null;
    try {
      livePrice = (await marketDataService.getQuote(ticker)).price;
    } catch {
      warnings.push(
        "Live quote unavailable right now — share count omitted (amounts still computed)."
      );
    }

    // V8 sources — the "model" side of the comparison (V10: payoff now walks
    // the measured > dcf-implied > structural precedence).
    const winRate = await this.measureWinRate(ticker, warnings);
    const { payoff, dcfPrior } = await this.measurePayoff(ticker, livePrice, warnings);

    // V9 E2: the desk's own measured history + the applied-pair selection.
    // V10 B3: when the window b is unusable the fallback is the DCF prior (if
    // stored) instead of the bare structural 1.5 — measured b always wins.
    const execStats = await executionAnalyticsService.getMeasuredStats();
    const fallbackB = payoff.kind === "dcf-implied" ? payoff.value : STRUCTURAL_PAYOFF_B;
    const selection = selectAppliedPair(execStats, winRate.value, fallbackB);
    const kelly = computeKelly(selection.p, selection.b); // HEADLINE = applied pair
    const modelKelly = computeKelly(winRate.value, payoff.value); // what V8 would say

    if (kelly.noEdge) {
      warnings.push(
        `No edge measured (raw Kelly f* = ${round4(kelly.rawKelly)} ≤ 0 with p=${round4(
          selection.p
        )}, b=${round4(selection.b)}) — do not size up; minimum position or skip.`
      );
    }
    if (kelly.capped) {
      warnings.push(
        `Raw Kelly ${round4(kelly.rawKelly)} exceeded the ${KELLY_CAP} safety cap and was clamped — ` +
          `an estimate that high usually means the inputs are too good to be true.`
      );
    }

    const measured = this.buildMeasuredBlock(execStats);
    const comparison = this.buildComparison(
      execStats,
      selection.applied,
      modelKelly.halfKelly,
      kelly.halfKelly,
      kelly.noEdge,
      payoff.kind === "dcf-implied" ? dcfPrior : null
    );

    const recommendedAmount = round2(kelly.halfKelly * capital);
    const sharesAtLivePrice =
      livePrice !== null && livePrice > 0
        ? Math.floor(recommendedAmount / livePrice)
        : null;
    if (
      sharesAtLivePrice !== null &&
      sharesAtLivePrice === 0 &&
      recommendedAmount > 0
    ) {
      warnings.push(
        `Half-Kelly amount ₹${recommendedAmount.toLocaleString("en-IN")} buys 0 shares at the live ` +
          `price ₹${livePrice!.toLocaleString("en-IN")} — capital is too small for this stock at this sizing.`
      );
    }

    return {
      ticker,
      capital,
      winRate,
      payoff,
      kellyFraction: round4(kelly.kellyFraction),
      halfKelly: round4(kelly.halfKelly),
      recommendedAmount,
      sharesAtLivePrice,
      livePrice,
      warnings,
      measured,
      applied: selection.applied,
      comparison,
      note:
        "f* = p − (1−p)/b, clamped to [0, 0.25]. The headline is HALF-Kelly (f*/2): Kelly maximizes " +
        "log growth ONLY if the p and b estimates are right, and these are noisy measurements — " +
        "half-Kelly roughly halves drawdowns while keeping ~75% of the growth rate. " +
        (kelly.noEdge
          ? "Current measured inputs show NO edge — the honest size is minimum or zero."
          : "Sources and sample counts above say exactly how measured (vs assumed) each input is."),
    };
  }

  /** V9 E2 — the desk's own last-30-window measurements, usable flags stated. */
  private buildMeasuredBlock(stats: ExecutionWindowStats): PositionSizeMeasuredBlock {
    const fullyMeasured =
      stats.usableP && stats.usableB && stats.measuredP !== null && stats.measuredB !== null
        ? computeKelly(stats.measuredP, stats.measuredB)
        : null;
    return {
      closedTrades: stats.closedTrades,
      winRate: {
        value: stats.measuredP !== null ? round4(stats.measuredP) : null,
        samples: stats.window.used,
        usable: stats.usableP,
      },
      payoff: {
        value: stats.measuredB !== null ? round4(stats.measuredB) : null,
        samples: stats.window.used,
        usable: stats.usableB,
      },
      kellyFraction: fullyMeasured ? round4(fullyMeasured.kellyFraction) : null,
      halfKelly: fullyMeasured ? round4(fullyMeasured.halfKelly) : null,
    };
  }

  /** Honest one-liner: model inputs vs the desk's own measured history. */
  private buildComparison(
    stats: ExecutionWindowStats,
    applied: KellyAppliedPairLabel,
    modelHalfKelly: number,
    appliedHalfKelly: number,
    noEdge: boolean,
    dcfPrior: DcfImpliedPayoff | null
  ): string {
    const n = stats.closedTrades;
    const trades = `${n} closed trade${n === 1 ? "" : "s"}`;
    let base: string;
    switch (applied) {
      case "measured-p+measured-b":
        base =
          `Model inputs say ${pct(modelHalfKelly)} (half-Kelly); your ${trades} say ` +
          `${pct(appliedHalfKelly)} — using YOUR measured history.`;
        break;
      case "model-p+measured-b":
        base =
          `Only ${trades} — model win rate applies until ${MIN_TRADES_FOR_MEASURED_P}, but the payoff is ` +
          `YOURS (measured from the last ${stats.window.used}): half-Kelly ${pct(appliedHalfKelly)} ` +
          `vs ${pct(modelHalfKelly)} on model inputs alone.`;
        break;
      case "measured-p+structural-b":
        base =
          `Your ${trades} set the win rate, but the payoff is unmeasurable ` +
          `(no losing trades in the last ${stats.window.used}) — ` +
          `${dcfPrior ? `the DCF-implied prior b=${dcfPrior.b}` : `structural ${STRUCTURAL_PAYOFF_B}`} applies: ` +
          `half-Kelly ${pct(appliedHalfKelly)} vs ${pct(modelHalfKelly)} on model inputs.`;
        break;
      default:
        base =
          n === 0
            ? `No closed trades yet — model inputs apply until ${MIN_TRADES_FOR_MEASURED_P}.`
            : `Only ${trades} — model inputs apply until ${MIN_TRADES_FOR_MEASURED_P}.`;
        break;
    }
    // V10 B3 — when the payoff b is a DCF-implied prior, say so explicitly.
    if (dcfPrior && (applied === "model-p+structural-b" || applied === "measured-p+structural-b")) {
      base +=
        ` Payoff prior: DCF-implied b=${dcfPrior.b}` +
        (dcfPrior.clamped ? ` (raw ${dcfPrior.raw}, clamped to [${DCF_PRIOR_MIN}, ${DCF_PRIOR_MAX}])` : "") +
        ` from stored ${dcfPrior.upsideScenario}-scenario upside ${dcfPrior.upsidePct}% vs bear ` +
        `${dcfPrior.bearPct}% at ₹${dcfPrior.price.toLocaleString("en-IN")} — assumption-sensitive, ` +
        `NOT measured; your measured payoff replaces it after ${MIN_CLOSED_TRADES} closed trades ` +
        `with both wins and losses.`;
    }
    return noEdge ? `${base} No measured edge (f* ≤ 0) — do not size up.` : base;
  }

  /** p — per-stock 7d hit rate (≥30 samples) → universe aggregate → neutral 0.5. */
  private async measureWinRate(
    ticker: string,
    warnings: string[]
  ): Promise<KellyInputStat> {
    const repo = AppDataSource.getRepository(ModelPerformance);

    const row = await repo.findOne({
      where: { ticker, modelVersion: MODEL_VERSION },
      order: { ranAt: "DESC" },
    });
    const h7 = row?.horizons?.find((h) => h.horizonDays === 7);
    if (h7 && h7.samples >= MIN_PER_STOCK_SAMPLES) {
      return {
        value: round4(h7.directionHitRatePct / 100),
        source: `per-stock 7d walk-forward backtest (${ticker})`,
        samples: h7.samples,
      };
    }

    // Universe aggregate: sample-weighted 7d hit rate over each ticker's
    // latest backtest row (same aggregation as /api/accuracy).
    const rows = await repo
      .createQueryBuilder("mp")
      .where("mp.model_version = :mv", { mv: MODEL_VERSION })
      .andWhere("mp.ticker IS NOT NULL")
      .andWhere("mp.horizons IS NOT NULL")
      .orderBy("mp.ran_at", "DESC")
      .getMany();
    const latestByTicker = new Map<string, ModelPerformance>();
    for (const r of rows) {
      if (r.ticker && !latestByTicker.has(r.ticker)) latestByTicker.set(r.ticker, r);
    }
    let samples = 0;
    let hits = 0;
    for (const r of latestByTicker.values()) {
      const h = r.horizons?.find((x) => x.horizonDays === 7);
      if (h && h.samples > 0) {
        samples += h.samples;
        hits += (h.directionHitRatePct / 100) * h.samples;
      }
    }
    if (samples > 0) {
      warnings.push(
        `This stock has ${h7?.samples ?? 0} 7d backtest samples (<${MIN_PER_STOCK_SAMPLES}) — ` +
          `win rate falls back to the universe aggregate.`
      );
      return {
        value: round4(hits / samples),
        source: "universe aggregate 7d walk-forward backtest",
        samples,
      };
    }

    warnings.push(
      "No walk-forward backtest data exists yet (run scripts/refreshBacktests.ts) — " +
        "win rate falls back to a neutral 0.5, which by construction shows no edge."
    );
    return { value: 0.5, source: "neutral fallback (no measured data)", samples: 0 };
  }

  /**
   * b — V10 B3 precedence, every step stated:
   *  1. MEASURED: |avg win / avg loss| from ≥10 closed desk trades with both
   *     wins and losses (V8, unchanged — always wins once usable).
   *  2. DCF-IMPLIED prior: stored Intelligence DCF scenarios → (base-or-bull
   *     upside)/(|bear downside|) vs the current price, clamped [0.5, 3.0].
   *  3. STRUCTURAL 1.5 (the trade-plan's 3:1 geometry), unchanged.
   */
  private async measurePayoff(
    ticker: string,
    livePrice: number | null,
    warnings: string[]
  ): Promise<{ payoff: KellyInputStat; dcfPrior: DcfImpliedPayoff | null }> {
    const closed = await AppDataSource.getRepository(PaperTrade).find({
      where: { status: "CLOSED" },
      order: { exitAt: "DESC" },
      take: 200,
    });
    const pnls = closed
      .map((t) => (t.realizedPnl != null ? Number(t.realizedPnl) : null))
      .filter((p): p is number => p !== null && Number.isFinite(p));
    const wins = pnls.filter((p) => p > 0);
    const losses = pnls.filter((p) => p <= 0);

    if (pnls.length >= MIN_CLOSED_TRADES && wins.length > 0 && losses.length > 0) {
      const avgWin = wins.reduce((s, p) => s + p, 0) / wins.length;
      const avgLoss = Math.abs(losses.reduce((s, p) => s + p, 0) / losses.length);
      if (avgLoss > 0) {
        return {
          payoff: {
            value: round4(avgWin / avgLoss),
            source: `measured from ${pnls.length} closed desk paper trades (avg win / avg loss)`,
            samples: pnls.length,
            kind: "measured",
          },
          dcfPrior: null,
        };
      }
    }

    // V10 B3 — measured b not usable: try the stored-DCF prior before the
    // structural assumption. A repository failure degrades to structural.
    const dcfPrior = await this.dcfPriorFor(ticker, livePrice);
    if (dcfPrior) {
      warnings.push(
        `Payoff b is a DCF-IMPLIED PRIOR (${dcfPrior.b}), not a measurement: stored bear/base/bull ` +
          `intrinsic values are assumption-sensitive estimates. It replaces the structural 1.5 only ` +
          `until ${MIN_CLOSED_TRADES} closed trades (with both wins and losses) make b measurable.`
      );
      return {
        payoff: {
          value: dcfPrior.b,
          source: DCF_PRIOR_SOURCE_LABEL,
          samples: 0,
          kind: "dcf-implied",
        },
        dcfPrior,
      };
    }

    warnings.push(
      `Payoff ratio uses the trade-plan's structural 3:1 target/stop geometry as a ${STRUCTURAL_B} ` +
        `assumption — only ${pnls.length} closed desk trade${pnls.length === 1 ? "" : "s"} exist ` +
        `(need ≥${MIN_CLOSED_TRADES} with at least one win and one loss to measure it).`
    );
    return {
      payoff: {
        value: STRUCTURAL_B,
        source: "structural assumption (stated, not measured)",
        samples: pnls.length,
        kind: "structural",
      },
      dcfPrior: null,
    };
  }

  /** V10 B3 — DCF-implied payoff prior from STORED scenarios (null = none). */
  private async dcfPriorFor(
    ticker: string,
    livePrice: number | null
  ): Promise<DcfImpliedPayoff | null> {
    try {
      const stored = await this.intelligenceRepository.latestStoredMetrics([ticker]);
      const s = stored.get(ticker.replace(/\.(NS|BO)$/i, "").toUpperCase());
      if (!s?.dcf) return null;
      // Compare against the live price; fall back to the price the scenarios
      // were computed at (real, stored — just possibly stale).
      const price = livePrice ?? s.dcf.priceAtCalc;
      return dcfImpliedPayoff(
        { bear: s.dcf.bear, base: s.dcf.base, bull: s.dcf.bull },
        price
      );
    } catch (err) {
      console.warn(`⚠️ DCF prior read failed for ${ticker}:`, (err as Error).message);
      return null;
    }
  }
}

/** Singleton export. */
export const positionSizeService = new PositionSizeService();
export default positionSizeService;
