/**
 * PortfolioService — multi-stock allocation of a ₹ amount, the way a veteran
 * would size it. Three strategies:
 *
 *   short-term — swing ranking by the quant/momentum score; strict filters
 *                (BUY + 3:1 plausible plan + P(up,7d) ≥ 55%).
 *   long-term  — quality ranking by the 8-phase framework Master Score
 *                (fundamentals + valuation heavy). Momentum filters are
 *                relaxed (HOLD allowed, no 7d-probability gate) because a
 *                compounder's week does not matter; entry is staggered in
 *                tranches instead (never all-in at once).
 *   balanced   — half momentum, half quality.
 *
 * Risk controls baked in (loss-minimisation first):
 *   - Regime-based cash reserve: risk-off deploys only 50% of the amount,
 *     neutral 80%, risk-on 100% — stated, never silent.
 *   - Sector diversification first, score second.
 *   - Every leg carries a stop; position count scales with amount so flat
 *     DP charges cannot eat small accounts.
 *   - Combined ranges assume pairwise correlation ρ = 0.35 (stated).
 *
 * Every pick ships framework EVIDENCE (PEG, growth, ROE, sector rank, trend —
 * real values from the same 8-phase report the Analyze tab shows). Nothing is
 * fabricated; missing data is shown as missing.
 */

import { AppDataSource } from "../../config/database";
import { ModelPerformance } from "../../entities/ModelPerformance";
import { PaperTrade } from "../../entities/PaperTrade";
import { stockService, ScanEntry } from "../StockService";
import { marketDataService } from "../market/MarketDataService";
import { fundamentalsService } from "../market/FundamentalsService";
import { macroService } from "../market/MacroService";
import { frameworkService } from "../framework/FrameworkService";
import { analyzeBars } from "../quant/engine";
import {
  alignDailyReturns,
  beta1yVsIndex,
  blockBootstrapDrawdown,
  worstIndexWindows,
} from "../quant/stress";
import { buildTradePlan } from "../framework/plan";
import { estimateRoundTripFees } from "../framework/fees";
import {
  AllocationEvidence,
  AllocationOutcome,
  AllocationPlan,
  AllocationStock,
  Bar,
  FrameworkReport,
  Horizon,
  HttpError,
  MarketRegime,
  PortfolioCalibrationHorizon,
  PortfolioCalibrationResponse,
  PortfolioCalibrationTickerHorizon,
  PortfolioStrategy,
  PortfolioStressResponse,
  StressScenario,
} from "../../types";

const MODEL_VERSION = "quant-v1";
const MIN_DIRECTION_PROB_7D = 0.55;
const PAIRWISE_CORRELATION = 0.35;
/** Below this per-stock allocation the flat DP charge alone exceeds ~0.7%. */
const MIN_PER_STOCK_ALLOCATION = 2500;
/** How many pre-ranked candidates get the full framework evaluation. */
const FRAMEWORK_EVAL_LIMIT = 10;
const HORIZONS: Horizon[] = [1, 3, 7, 15, 30];

/** Deployment % of the amount by market regime — cash is a position. */
const REGIME_DEPLOYMENT: Record<MarketRegime["regime"], number> = {
  "risk-on": 100,
  neutral: 80,
  "risk-off": 50,
};

function round2(x: number): number {
  const r = Math.round(x * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

const inr = (x: number): string =>
  `₹${x.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

interface Candidate {
  entry: ScanEntry;
  plan: NonNullable<ReturnType<typeof buildTradePlan>>;
  framework: FrameworkReport | null; // null when bars/fundamentals were unavailable
  rank: number; // strategy-dependent ranking score
}

export function isPortfolioStrategy(x: unknown): x is PortfolioStrategy {
  return x === "short-term" || x === "long-term" || x === "balanced";
}

export class PortfolioService {
  /**
   * Suggest how to split `amount` across qualified stocks for the strategy.
   * Returns { allocation: null, reason } when nothing qualifies — never forces a trade.
   */
  async suggest(
    amount: number,
    strategy: PortfolioStrategy = "balanced"
  ): Promise<{ allocation: AllocationPlan | null; reason?: string }> {
    if (!Number.isFinite(amount) || amount < 100) {
      throw new HttpError(400, '"amount" must be a number ≥ ₹100.');
    }

    const [scan, regime] = await Promise.all([
      stockService.getScanSnapshot(),
      macroService.getMarketRegime().catch(() => null),
    ]);

    // ── Regime-based deliberate cash reserve ────────────────────────────────
    const deployPct = regime ? REGIME_DEPLOYMENT[regime.regime] : 80;
    const budget = round2((amount * deployPct) / 100);
    const cashReservePct = round2(100 - deployPct);
    const cashReserveReason = regime
      ? deployPct === 100
        ? `Market regime is risk-on (${Math.round(regime.score)}/100) — full deployment is justified.`
        : `Market regime is ${regime.regime} (${Math.round(regime.score)}/100 — NIFTY ${regime.nifty.vs200dmaPct >= 0 ? "+" : ""}${regime.nifty.vs200dmaPct}% vs 200DMA, VIX ${regime.vix.value} ${regime.vix.zone}), so only ${deployPct}% is deployed. Keeping ${cashReservePct}% in cash is the cheapest loss-protection there is — you cannot lose money you have not put at risk, and the reserve buys dips when others must sell.`
      : `Market regime is unavailable right now — deploying a cautious 80% by default.`;

    // ── Base eligibility by strategy ─────────────────────────────────────────
    const affordable = scan.entries.filter((e) => e.price <= budget);
    const eligible =
      strategy === "long-term"
        ? affordable.filter((e) => e.recommendation !== "AVOID")
        : affordable.filter(
            (e) =>
              e.recommendation === "BUY" &&
              (e.directionProb7d ?? 0) >= MIN_DIRECTION_PROB_7D
          );

    const withPlans = eligible
      .map((entry) => ({
        entry,
        plan: buildTradePlan({
          entry: entry.price,
          atr14: entry.atr14,
          annualVolatilityPct: entry.annualVolatilityPct,
          recommendation: entry.recommendation === "AVOID" ? "HOLD" : entry.recommendation,
        }),
      }))
      .filter(
        (c): c is { entry: ScanEntry; plan: NonNullable<ReturnType<typeof buildTradePlan>> } =>
          c.plan !== null && (strategy === "long-term" || c.plan.meetsRewardRisk)
      )
      .sort((a, b) => b.entry.score - a.entry.score);

    if (withPlans.length === 0) {
      return {
        allocation: null,
        reason:
          `No qualified ${strategy} setup for ${inr(amount)} right now (deployable budget ${inr(budget)} after the ` +
          `${cashReservePct}% regime reserve): of ${scan.scannedCount} stocks scanned, ${eligible.length} passed the ` +
          `${strategy === "long-term" ? "not-AVOID quality screen" : "BUY + P(up,7d) ≥ 55% momentum screen"} at an ` +
          `affordable price, and none also had a workable stop/target plan. Holding cash beats forcing a trade.`,
      };
    }

    // ── Framework evaluation for the top pre-ranked candidates ──────────────
    const evaluated: Candidate[] = [];
    for (const c of withPlans.slice(0, FRAMEWORK_EVAL_LIMIT)) {
      const framework = await this.frameworkFor(c.entry).catch(() => null);
      evaluated.push({ ...c, framework, rank: 0 });
    }

    // Strategy ranking. Long-term REQUIRES a framework score (quality must be
    // measurable); short-term ranks on momentum; balanced blends the two.
    let ranked: Candidate[];
    if (strategy === "long-term") {
      ranked = evaluated
        .filter((c) => c.framework?.masterScore != null)
        .map((c) => ({ ...c, rank: c.framework!.masterScore! }))
        .filter((c) => c.rank >= 60);
      if (ranked.length === 0) {
        return {
          allocation: null,
          reason:
            `No long-term candidate reaches a framework Master Score of 60/100 today ` +
            `(${evaluated.length} evaluated across macro/sector/fundamentals/valuation/technicals). ` +
            `A veteran does not lower the quality bar to stay busy — keep the cash and re-check tomorrow.`,
        };
      }
    } else if (strategy === "balanced") {
      ranked = evaluated.map((c) => ({
        ...c,
        rank: 0.5 * c.entry.score + 0.5 * (c.framework?.masterScore ?? c.entry.score),
      }));
    } else {
      ranked = evaluated.map((c) => ({ ...c, rank: c.entry.score }));
    }
    ranked.sort((a, b) => b.rank - a.rank);

    // ── Position count + sector-diverse greedy pick ──────────────────────────
    const byAmount = budget < 5000 ? 2 : budget < 20000 ? 3 : 5;
    const byFees = Math.max(1, Math.floor(budget / MIN_PER_STOCK_ALLOCATION));
    const maxStocks = Math.max(1, Math.min(byAmount, byFees, ranked.length));

    const picked: Candidate[] = [];
    const sectors = new Set<string>();
    for (const c of ranked) {
      if (picked.length >= maxStocks) break;
      if (!sectors.has(c.entry.sector)) {
        picked.push(c);
        sectors.add(c.entry.sector);
      }
    }
    for (const c of ranked) {
      if (picked.length >= maxStocks) break;
      if (!picked.includes(c)) picked.push(c);
    }

    // ── Rank-proportional weights → integer shares → greedy top-up ──────────
    const weights = picked.map((c) => Math.max(5, c.rank - 50));
    const weightSum = weights.reduce((s, w) => s + w, 0);
    const qtys = picked.map((c, i) =>
      Math.floor(((weights[i] / weightSum) * budget) / c.entry.price)
    );
    let spent = picked.reduce((s, c, i) => s + qtys[i] * c.entry.price, 0);
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < picked.length; i++) {
        if (spent + picked[i].entry.price <= budget) {
          qtys[i] += 1;
          spent += picked[i].entry.price;
          improved = true;
        }
      }
    }

    const kept = picked.map((c, i) => ({ c, qty: qtys[i] })).filter((x) => x.qty > 0);
    if (kept.length === 0) {
      const cheapest = ranked[ranked.length - 1];
      return {
        allocation: null,
        reason:
          `The deployable budget ${inr(budget)} cannot buy a single share of any qualified candidate ` +
          `(cheapest qualified: ${cheapest.entry.ticker} at ${inr(cheapest.entry.price)}).`,
      };
    }

    const cashUsed = round2(kept.reduce((s, x) => s + x.qty * x.c.entry.price, 0));
    const cashLeft = round2(amount - cashUsed);

    // ── Per-stock views with framework evidence ──────────────────────────────
    const stocks: AllocationStock[] = [];
    for (let i = 0; i < kept.length; i++) {
      const { c, qty } = kept[i];
      const e = c.entry;
      const invested = round2(qty * e.price);
      const fees = estimateRoundTripFees(invested);
      const p7 = e.predictions.find((p) => p.horizonDays === 7) ?? null;
      const p30 = e.predictions.find((p) => p.horizonDays === 30) ?? null;
      const master = c.framework?.masterScore ?? null;
      const evidence = this.extractEvidence(c.framework);

      const strategyFit =
        strategy === "long-term"
          ? `Quality compounder case: framework Master Score ${master?.toFixed(1)}/100 (${c.framework?.verdict}); entry is staggered in tranches, judged on fundamentals + valuation, not this week's move.`
          : strategy === "balanced"
            ? `Blended rank ${c.rank.toFixed(1)} = ½ momentum (${e.score}) + ½ quality (${master != null ? master.toFixed(1) : "n/a — momentum only"}).`
            : `Swing setup: momentum score ${e.score}/100 with P(up, 7d) ${e.directionProb7d != null ? `${(e.directionProb7d * 100).toFixed(0)}%` : "n/a"} — ride strength, exit fast at the stop.`;

      stocks.push({
        ticker: e.ticker,
        name: e.name,
        sector: e.sector,
        price: round2(e.price),
        qty,
        invested,
        weightPct: cashUsed > 0 ? round2((invested / cashUsed) * 100) : 0,
        score: e.score,
        masterScore: master,
        frameworkVerdict: c.framework?.verdict ?? null,
        directionProb7d: e.directionProb7d,
        stopLoss: c.plan.stopLoss,
        target: c.plan.target,
        maxLoss: round2(qty * (e.price - c.plan.stopLoss)),
        expected7dPct: p7 ? p7.expectedReturnPct : null,
        expected30dPct: p30 ? p30.expectedReturnPct : null,
        whyChosen:
          `Rank ${i + 1} for the ${strategy} strategy` +
          (master != null ? ` — Master Score ${master.toFixed(1)}/100, momentum ${e.score}/100` : ` — momentum ${e.score}/100`) +
          `, sector ${e.sector}${sectors.size > 1 ? " (diversification)" : ""}.`,
        strategyFit,
        evidence,
        reasons: e.topReasons.slice(0, 2),
        historicalOdds: await this.historicalOddsFor(e.ticker),
        fees: fees.roundTrip,
      });
    }

    // ── Combined per-horizon outcome with ρ-adjusted band width ─────────────
    const outcomes: AllocationOutcome[] = HORIZONS.map((h) => {
      let expectedStocks = 0;
      const halfWidths: number[] = [];
      for (const { c, qty } of kept) {
        const p = c.entry.predictions.find((x) => x.horizonDays === h);
        if (p) {
          expectedStocks += qty * p.expectedPrice;
          halfWidths.push(qty * (p.expectedPrice - p.lowPrice));
        } else {
          expectedStocks += qty * c.entry.price;
          halfWidths.push(0);
        }
      }
      const sumW = halfWidths.reduce((s, w) => s + w, 0);
      const sumW2 = halfWidths.reduce((s, w) => s + w * w, 0);
      const variance = sumW2 + PAIRWISE_CORRELATION * (sumW * sumW - sumW2);
      const halfWidth = Math.sqrt(Math.max(0, variance));
      const expectedValue = round2(expectedStocks + cashLeft);
      return {
        horizonDays: h,
        expectedValue,
        lowValue: round2(expectedStocks - halfWidth + cashLeft),
        highValue: round2(expectedStocks + halfWidth + cashLeft),
        expectedProfit: round2(expectedValue - amount),
        expectedProfitPct: amount > 0 ? round2(((expectedValue - amount) / amount) * 100) : 0,
      };
    });

    // ── Long-term staggered entry (never all-in at once) ────────────────────
    const tranchePlan =
      strategy === "long-term"
        ? [
            `Tranche 1 — now: deploy ~50% (${inr(round2(cashUsed * 0.5))}) at current prices.`,
            `Tranche 2 — add ~25% (${inr(round2(cashUsed * 0.25))}) after a 3%+ dip in a position OR after 2 weeks if the framework score still holds ≥ 60.`,
            `Tranche 3 — final ~25% (${inr(round2(cashUsed * 0.25))}) after a 6%+ dip OR after 4 weeks, same quality re-check.`,
            `If a position falls below its stop on a closing basis, exit that leg instead of averaging down — quality theses are re-bought later, capital is not.`,
          ]
        : null;

    const totalFeesRoundTrip = round2(stocks.reduce((s, x) => s + x.fees, 0));
    const totalFeesPct = cashUsed > 0 ? round2((totalFeesRoundTrip / cashUsed) * 100) : 0;

    const rationale: string[] = [
      strategy === "long-term"
        ? `Long-term picks are ranked by the 8-phase framework Master Score (fundamentals, valuation, sector, macro, technicals with your weights), NOT by this week's momentum — the evidence for each pick is quoted below.`
        : strategy === "balanced"
          ? `Balanced ranking = ½ momentum score + ½ framework Master Score — swing strength AND business quality both had to show up.`
          : `Short-term ranking uses the momentum score with strict gates: BUY rating, 3:1 reward-risk plausibility, P(up, 7 days) ≥ 55%.`,
      stocks.length > 1
        ? `Split across ${stocks.length} stocks in ${new Set(stocks.map((s) => s.sector)).size} sector(s) so one bad earnings surprise cannot sink the whole position — the single biggest free risk reduction available.`
        : `A single position: the budget cannot fund a second fee-efficient leg (each extra stock adds a flat ₹15.93 DP charge on exit).`,
      `Weights are proportional to conviction rank, rounded to whole shares; every leg carries a stop-loss — the loss-minimisation is the stop, the sizing and the reserve, not a prediction.`,
    ];

    const warnings: string[] = [];
    if (totalFeesPct > 0.5) {
      warnings.push(
        `Round-trip fees ${inr(totalFeesRoundTrip)} are ${totalFeesPct.toFixed(2)}% of the invested amount — ` +
          `above 0.5%, small positions are fee-inefficient. Fewer trades held longer beat frequent churn at this size.`
      );
    }
    if (stocks.length === 1 && budget >= 5000) {
      warnings.push(
        `Only one candidate qualified today — concentration risk. The filters stay strict on purpose; do not relax them to force diversification.`
      );
    }
    warnings.push(
      `Expected values are statistical estimates from a model with a measured ~50-51% direction hit rate — ` +
        `the ranges matter more than the midpoints. Nothing here is a guarantee.`
    );

    return {
      allocation: {
        amount: round2(amount),
        strategy,
        cashUsed,
        cashLeft,
        cashReservePct,
        cashReserveReason,
        stocks,
        outcomes,
        tranchePlan,
        totalFeesRoundTrip,
        totalFeesPct,
        correlationNote:
          `Combined ranges assume average pairwise correlation ρ = ${PAIRWISE_CORRELATION} between Indian large caps ` +
          `(diversification narrows the band vs a single stock, but correlated markets keep it wider than pure independence).`,
        rationale,
        warnings,
        asOf: new Date().toISOString(),
      },
    };
  }

  /** Full 8-phase framework report for a scan candidate (all inputs cached). */
  private async frameworkFor(entry: ScanEntry): Promise<FrameworkReport | null> {
    const bars = await marketDataService.getDailyBars(entry.ticker, "1y");
    if (bars.length < 60) return null;
    const quant = analyzeBars(bars);
    let fundamentals = null;
    let fundamentalsWarning: string | null = null;
    try {
      fundamentals = await fundamentalsService.getFundamentals(entry.ticker);
    } catch (err) {
      fundamentalsWarning = (err as Error).message;
    }
    const [regime, sectorMomentum] = await Promise.all([
      macroService.getMarketRegime().catch(() => null),
      frameworkService.getSectorMomentum().catch(() => null),
    ]);
    return frameworkService.buildReport({
      ticker: entry.ticker,
      sector: entry.sector,
      price: entry.price,
      quant,
      fundamentals,
      fundamentalsWarning,
      regime,
      sectorMomentum,
      tradePlan: buildTradePlan({
        entry: entry.price,
        atr14: entry.atr14,
        annualVolatilityPct: entry.annualVolatilityPct,
        recommendation: entry.recommendation === "AVOID" ? "HOLD" : entry.recommendation,
      }),
    });
  }

  /**
   * The checks a buyer actually cites: valuation (PEG/EV-EBITDA), growth,
   * profitability, sector strength, trend. Real values only — no-data checks
   * are skipped except when everything is missing.
   */
  private extractEvidence(report: FrameworkReport | null): AllocationEvidence[] {
    if (!report) return [];
    const wanted = [
      /peg/i,
      /ev\/?ebitda/i,
      /revenue growth/i,
      /earnings growth/i,
      /ro[ea]/i,
      /margin/i,
      /sector/i,
      /200[- ]?day|200dma/i,
      /insider|promoter/i,
    ];
    const out: AllocationEvidence[] = [];
    // Buyers cite fundamentals (4) and valuation (5) first, then sector (2),
    // technicals (6), moat/management (3), macro (1).
    const phaseOrder = [4, 5, 2, 6, 3, 1, 7, 8];
    const phases = [...report.phases].sort(
      (a, b) => phaseOrder.indexOf(a.phase) - phaseOrder.indexOf(b.phase)
    );
    for (const phase of phases) {
      for (const check of phase.checks) {
        if (out.length >= 6) return out;
        if (check.result === "no-data") continue;
        if (wanted.some((re) => re.test(check.name) || re.test(check.value))) {
          out.push({ name: check.name, value: check.value, result: check.result });
        }
      }
    }
    return out;
  }

  // ── V7 A4: portfolio stress + portfolio calibration ────────────────────────

  /**
   * Resolve the portfolio legs for stress/calibration: explicit tickers (with
   * optional weights) or, when none are given, the admin desk's OPEN paper
   * positions weighted by cost basis. Never invents a portfolio.
   */
  private async resolveLegs(
    tickersIn?: string[],
    weightsIn?: number[]
  ): Promise<Array<{ ticker: string; weight: number }>> {
    if (tickersIn && tickersIn.length > 0) {
      if (tickersIn.length > 15) {
        throw new HttpError(400, "At most 15 tickers per stress/calibration request.");
      }
      if (weightsIn && weightsIn.length > 0) {
        if (weightsIn.length !== tickersIn.length) {
          throw new HttpError(
            400,
            `"weights" must have one value per ticker (${tickersIn.length} tickers, ${weightsIn.length} weights).`
          );
        }
        if (weightsIn.some((w) => !Number.isFinite(w) || w <= 0)) {
          throw new HttpError(400, '"weights" must all be positive numbers.');
        }
      }
      // Resolve each ticker to a real listing; merge duplicate tickers.
      const byTicker = new Map<string, number>();
      for (let i = 0; i < tickersIn.length; i++) {
        const resolved = await marketDataService.resolve(tickersIn[i]);
        if (!resolved) {
          throw new HttpError(
            404,
            `Could not resolve "${tickersIn[i]}" to an Indian (NSE/BSE) listing.`
          );
        }
        const w = weightsIn && weightsIn.length > 0 ? weightsIn[i] : 1;
        byTicker.set(resolved.ticker, (byTicker.get(resolved.ticker) ?? 0) + w);
      }
      return Array.from(byTicker, ([ticker, weight]) => ({ ticker, weight }));
    }

    // No tickers given → admin desk open positions (cost-basis weights).
    const lots = await AppDataSource.getRepository(PaperTrade).find({
      where: { status: "OPEN", side: "BUY" },
    });
    const byTicker = new Map<string, number>();
    for (const lot of lots) {
      const notional = Number(lot.qty) * Number(lot.price);
      if (Number.isFinite(notional) && notional > 0) {
        byTicker.set(lot.ticker, (byTicker.get(lot.ticker) ?? 0) + notional);
      }
    }
    if (byTicker.size === 0) {
      throw new HttpError(
        400,
        "No tickers given and the trading desk has no open positions — pass " +
          "?tickers=RELIANCE.NS,TCS.NS (optionally &weights=60,40)."
      );
    }
    return Array.from(byTicker, ([ticker, weight]) => ({ ticker, weight }));
  }

  /**
   * GET /api/portfolio/stress — two REAL-data stress views (honest triage:
   * historical windows + block bootstrap, NOT a synthetic GAN):
   *  (a) worst non-overlapping 21-trading-day NIFTY windows over ~5y, mapped
   *      onto the portfolio via each stock's measured 1y beta;
   *  (b) 2,000 seeded block-bootstrap paths over the stocks' date-aligned real
   *      returns (same block across stocks → correlation preserved), reporting
   *      the P5/P1 worst point vs entry.
   */
  async stress(
    tickersIn?: string[],
    weightsIn?: number[]
  ): Promise<PortfolioStressResponse> {
    const legs = await this.resolveLegs(tickersIn, weightsIn);
    const weightSum = legs.reduce((s, l) => s + l.weight, 0);
    const norm = legs.map((l) => ({ ticker: l.ticker, w: l.weight / weightSum }));

    // Real bars per leg (DB-cached; a stale ticker may trigger one throttled fetch).
    const barsPerLeg: Bar[][] = [];
    for (const leg of norm) {
      const bars = await marketDataService.getDailyBars(leg.ticker, "1y");
      if (bars.length < 130) {
        throw new HttpError(
          422,
          `${leg.ticker} has only ${bars.length} daily bars — the stress test needs ≥130 days of real history.`
        );
      }
      barsPerLeg.push(bars);
    }

    // Index history: 5y preferred for real crash windows; degrade to 1y honestly.
    let niftyLong: Bar[];
    let niftySpan: string;
    try {
      niftyLong = await marketDataService.getNiftyBars("5y");
      niftySpan = "~5 years";
    } catch {
      niftyLong = await marketDataService.getNiftyBars("1y");
      niftySpan = "~1 year (5-year NIFTY history unavailable right now)";
    }

    // Beta per leg over ~1y of overlapping daily returns.
    const betas = barsPerLeg.map((bars) => beta1yVsIndex(bars, niftyLong));

    // (a) Historical windows → beta-mapped portfolio returns, worst first.
    const windows = worstIndexWindows(niftyLong, { windowLen: 21, count: 5 });
    const scenarios: StressScenario[] = windows
      .map((w) => {
        const portfolioReturnPct = norm.reduce(
          (s, leg, i) => s + leg.w * (betas[i] ?? 1) * w.indexReturnPct,
          0
        );
        return {
          label: `${w.startDate} → ${w.endDate} (NIFTY ${w.indexReturnPct >= 0 ? "+" : ""}${w.indexReturnPct}%)`,
          portfolioReturnPct: round2(portfolioReturnPct),
        };
      })
      .sort((a, b) => a.portfolioReturnPct - b.portfolioReturnPct);

    // (b) Block bootstrap over date-aligned real returns (seeded → reproducible).
    const { matrix } = alignDailyReturns(barsPerLeg);
    if (matrix.length < 26) {
      throw new HttpError(
        422,
        `Only ${matrix.length} overlapping trading days across ${norm.length} tickers — too few for the block bootstrap.`
      );
    }
    const bb = blockBootstrapDrawdown(
      matrix,
      norm.map((l) => l.w),
      { blocks: 2000, blockLen: 21 }
    );

    // Hedge hint: plain-text risk reduction from the live regime — no options fabrication.
    const regime = await macroService.getMarketRegime().catch(() => null);
    const worst = scenarios[0] ?? null;
    const biggest = norm.reduce((a, b) => (b.w > a.w ? b : a), norm[0]);
    const hedgeHint =
      (regime?.regime === "risk-off"
        ? `Market regime is RISK-OFF (${Math.round(regime.score)}/100): the cheapest protection is smaller ` +
          `exposure — trim the largest weight (${biggest.ticker}, ${(biggest.w * 100).toFixed(0)}%) and hold ` +
          `the freed cash; the regime reserve rule already keeps ~50% undeployed in this regime.`
        : regime?.regime === "neutral"
          ? `Market regime is neutral (${Math.round(regime.score)}/100): keep the ~20% cash reserve intact and ` +
            `cap any single position (largest now ${biggest.ticker} at ${(biggest.w * 100).toFixed(0)}%) so one ` +
            `bad print cannot dominate the book.`
          : regime
            ? `Market regime is risk-on (${Math.round(regime.score)}/100): stress still applies — respect every ` +
              `stop, and rebalance if ${biggest.ticker} (${(biggest.w * 100).toFixed(0)}%) keeps growing beyond plan.`
            : `Regime data is unavailable right now: default to caution — keep a cash reserve and respect stops.`) +
      ` This tool does not recommend derivatives — reducing weight and raising cash are the only hedges it will state.`;

    return {
      tickers: norm.map((leg, i) => ({
        ticker: leg.ticker,
        weightPct: round2(leg.w * 100),
        beta1y: betas[i],
      })),
      scenarios,
      p5DrawdownPct: bb.p5DrawdownPct,
      p1DrawdownPct: bb.p1DrawdownPct,
      method:
        `historical: worst non-overlapping 21-trading-day NIFTY windows over ${niftySpan}, beta-mapped per stock; ` +
        `bootstrap: ${bb.blocks.toLocaleString("en-IN")} seeded ${bb.blockLen}-day blocks resampled from ` +
        `${bb.observations} date-aligned real return days (same block across stocks preserves correlation and autocorrelation)`,
      note:
        `Both views are built ONLY from real historical returns — no synthetic data. ` +
        (worst
          ? `The worst historical scenario maps to ${worst.portfolioReturnPct >= 0 ? "+" : ""}${worst.portfolioReturnPct}% ` +
            `for this portfolio via measured betas${betas.some((b) => b === null) ? " (beta defaulted to 1 where unmeasurable)" : ""}. `
          : ``) +
        `History understates the truly unprecedented: crisis correlations run higher than measured ones, so treat ` +
        `P1 (${bb.p1DrawdownPct}%) as a floor estimate of pain, not a guarantee.`,
      hedgeHint,
      asOf: new Date().toISOString(),
    };
  }

  /**
   * GET /api/portfolio/calibration — weight-blended walk-forward brier/hit
   * stats of the portfolio's tickers from ModelPerformance. Measures how
   * honest the direction probabilities you'd be consuming are — NOT portfolio
   * return risk (that's the stress endpoint).
   */
  async calibrationFor(
    tickersIn?: string[],
    weightsIn?: number[]
  ): Promise<PortfolioCalibrationResponse> {
    const legs = await this.resolveLegs(tickersIn, weightsIn);
    const weightSum = legs.reduce((s, l) => s + l.weight, 0);
    const norm = legs.map((l) => ({ ticker: l.ticker, w: l.weight / weightSum }));

    const repo = AppDataSource.getRepository(ModelPerformance);
    const perTicker: PortfolioCalibrationResponse["perTicker"] = [];
    const rowsByTicker = new Map<string, ModelPerformance | null>();
    for (const leg of norm) {
      const row = await repo.findOne({
        where: { ticker: leg.ticker, modelVersion: MODEL_VERSION },
        order: { ranAt: "DESC" },
      });
      rowsByTicker.set(leg.ticker, row);
      const horizons: PortfolioCalibrationTickerHorizon[] = HORIZONS.map((h) => {
        const stat = row?.horizons?.find((x) => x.horizonDays === h);
        return {
          horizonDays: h,
          brier:
            stat && stat.samples > 0 && typeof stat.brierScore === "number"
              ? stat.brierScore
              : null,
          hitRatePct:
            stat && stat.samples > 0
              ? Number(stat.directionHitRatePct.toFixed(2))
              : null,
          samples: stat?.samples ?? 0,
        };
      });
      perTicker.push({
        ticker: leg.ticker,
        weightPct: round2(leg.w * 100),
        horizons,
      });
    }

    const horizons: PortfolioCalibrationHorizon[] = HORIZONS.map((h) => {
      let wWithData = 0;
      let brierW = 0;
      let hitW = 0;
      let samples = 0;
      for (let i = 0; i < norm.length; i++) {
        const t = perTicker[i].horizons.find((x) => x.horizonDays === h)!;
        if (t.brier === null || t.hitRatePct === null) continue;
        wWithData += norm[i].w;
        brierW += norm[i].w * t.brier;
        hitW += norm[i].w * t.hitRatePct;
        samples += t.samples;
      }
      return {
        horizonDays: h,
        weightedBrier: wWithData > 0 ? Number((brierW / wWithData).toFixed(4)) : null,
        weightedHitRatePct: wWithData > 0 ? Number((hitW / wWithData).toFixed(2)) : null,
        samples,
        coveragePct: round2(wWithData * 100),
      };
    });

    const ranAts = Array.from(rowsByTicker.values())
      .map((r) => (r?.ranAt ? new Date(r.ranAt).getTime() : 0))
      .filter((t) => t > 0);
    const updatedAt = ranAts.length
      ? new Date(Math.max(...ranAts)).toISOString()
      : new Date(0).toISOString();

    const missing = perTicker
      .filter((t) => t.horizons.every((h) => h.brier === null))
      .map((t) => t.ticker);
    return {
      perTicker,
      horizons,
      note:
        `Weighted blend of each ticker's latest walk-forward brier/hit-rate (weights = ` +
        `${weightsIn && weightsIn.length ? "as given" : tickersIn && tickersIn.length ? "equal" : "open-position cost basis"}, ` +
        `renormalized over tickers WITH stored stats — coveragePct shows how much of the portfolio that is). ` +
        (missing.length
          ? `No stored calibration yet for: ${missing.join(", ")} — run scripts/refreshBacktests.ts. `
          : ``) +
        `This measures the honesty of the direction probabilities, not portfolio risk; 0.25 is the coin-flip brier.`,
      updatedAt,
    };
  }

  /** Per-ticker measured 7d odds from ModelPerformance (live, never hardcoded). */
  private async historicalOddsFor(ticker: string): Promise<string> {
    try {
      const row = await AppDataSource.getRepository(ModelPerformance).findOne({
        where: { ticker, modelVersion: MODEL_VERSION },
        order: { ranAt: "DESC" },
      });
      const h7 = row?.horizons?.find((h) => h.horizonDays === 7);
      if (h7 && h7.samples > 0) {
        return `Measured 7d direction hit rate for this stock: ${h7.directionHitRatePct.toFixed(1)}% (${h7.samples} samples).`;
      }
      return "No measured 7d backtest accuracy for this stock yet.";
    } catch {
      return "Historical accuracy could not be loaded right now.";
    }
  }
}

export const portfolioService = new PortfolioService();
export default portfolioService;
