/**
 * PortfolioService — the KEPT portfolio risk endpoints:
 *
 *   stress()         — historical NIFTY crash windows beta-mapped onto the
 *                      portfolio + seeded block-bootstrap drawdowns (real
 *                      returns only, correlation preserved).
 *   calibrationFor() — weight-blended walk-forward brier/hit stats of the
 *                      portfolio's tickers from ModelPerformance.
 *
 * REMOVED in the v2 upgrade (upgrade-spec §2 row 5): suggest() — the
 * multi-stock allocation builder and daily cash-split are out of the product
 * (archived under archive/). Both remaining endpoints now require EXPLICIT
 * ?tickers= legs: the old silent default onto the paper desk's open positions
 * was re-pointed away from the sandbox (upgrade-audit §3 row 5); a real
 * Holdings default arrives with the B2 transaction ledger.
 */
import { AppDataSource } from "../../config/database";
import { ModelPerformance } from "../../entities/ModelPerformance";
import { marketDataService } from "../market/MarketDataService";
import { macroService } from "../market/MacroService";
import {
  alignDailyReturns,
  beta1yVsIndex,
  blockBootstrapDrawdown,
  worstIndexWindows,
} from "../quant/stress";
import {
  Bar,
  Horizon,
  HttpError,
  PortfolioCalibrationHorizon,
  PortfolioCalibrationResponse,
  PortfolioCalibrationTickerHorizon,
  PortfolioStressResponse,
  StressScenario,
} from "../../types";

const MODEL_VERSION = "quant-v1";
const HORIZONS: Horizon[] = [1, 3, 7, 15, 30];

function round2(x: number): number {
  const r = Math.round(x * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

const inr = (x: number): string =>
  `₹${x.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export class PortfolioService {
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

    // v2 upgrade: no silent default legs. The old fallback read the paper
    // desk's open positions (sandbox state); it was re-pointed away per
    // upgrade-audit §3 row 5. A real-Holdings default arrives with the B2
    // transaction ledger.
    throw new HttpError(
      400,
      "No tickers given — pass ?tickers=RELIANCE.NS,TCS.NS (optionally &weights=60,40). " +
        "A holdings-based default will return once the real Holdings ledger lands."
    );
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

}

export const portfolioService = new PortfolioService();
export default portfolioService;
