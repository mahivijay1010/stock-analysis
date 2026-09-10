/**
 * StockService — slim orchestrator over the market data layer (Module 1) and
 * the pure quant engine (Module 2). Owns all API-facing composition:
 *
 *  - analyze():      resolve → bars → quant analysis → projections → persist
 *  - top picks:      30-min cached universe scan from DB bars
 *  - backtest():     walk-forward backtest + ModelPerformance upsert
 *  - accuracy():     aggregate measured accuracy across the universe
 *  - chart()/universe()/history(): read endpoints
 *  - cron hooks:     refreshUniverseBars, scanUniverse(logPredictions),
 *                    verifyMaturedPredictions, cleanupOldAnalyses
 *
 * NEVER fabricates data: every number comes from Yahoo bars/quotes or the DB.
 */

import { AppDataSource } from "../config/database";
import { Stock } from "../entities/Stock";
import { Analysis } from "../entities/Analysis";
import { PredictionLog } from "../entities/PredictionLog";
import { ModelPerformance } from "../entities/ModelPerformance";
import { NSE_UNIVERSE } from "../data/nseUniverse";
import { marketDataService } from "./market/MarketDataService";
import { fundamentalsService } from "./market/FundamentalsService";
import { macroService } from "./market/MacroService";
import { newsService } from "./market/NewsService";
import { frameworkService, SectorMomentumSnapshot } from "./framework/FrameworkService";
import { buildTradePlan, buildInvestmentPlan } from "./framework/plan";
import { computeEntryTiming } from "./framework/entryTiming";
import {
  analyzeBars,
  buildProjections,
  HORIZONS,
  TRADING_DAY_OFFSETS,
} from "./quant/engine";
import { simulateBootstrap } from "./quant/montecarlo";
import { backtestBars, isDirectionHit, PROB_BUCKET_EDGES } from "./quant/backtest";
import { dailyReturns, smaSeries } from "./quant/indicators";
import { adjustedDailyReturns } from "./market/canonical";
import { CronExecutionLog } from "../entities/CronExecutionLog";
import {
  AccuracyPerStock,
  AccuracyResponse,
  AccuracySummary,
  AnalyzeResponse,
  BacktestResult,
  Bar,
  CalibrationHorizon,
  CalibrationLiveHorizon,
  CalibrationResponse,
  ProbBucket,
  ResearchBrief,
  ChartPayload,
  ChartRange,
  ChartResponse,
  DISCLAIMER,
  EntryAction,
  Fundamentals,
  HttpError,
  Horizon,
  HorizonPrediction,
  InvestmentPlan,
  MarketRegime,
  MonteCarloForecast,
  NewsSummary,
  ProjectionRow,
  QuantAnalysis,
  Quote,
  TopPick,
  TopPicksResponse,
  TradePlan,
  UniverseStockRow,
} from "../types";

const MODEL_VERSION = "quant-v1";
const TOP_PICKS_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MIN_BARS_FOR_ANALYSIS = 60;
const DEFAULT_BACKTEST_DAYS = 60;

/** Fetch range per chart range (wider fetch so SMA200 has warm-up bars). */
const CHART_FETCH_RANGE: Record<ChartRange, "1y" | "2y" | "5y"> = {
  "7d": "1y",
  "15d": "1y",
  "1mo": "1y",
  "3mo": "1y",
  "6mo": "2y",
  "1y": "2y",
  "5y": "5y",
};

/** Calendar days shown per chart range. */
const CHART_WINDOW_DAYS: Record<ChartRange, number> = {
  "7d": 7,
  "15d": 15,
  "1mo": 31,
  "3mo": 92,
  "6mo": 183,
  "1y": 366,
  "5y": 1827,
};

export interface ScanEntry {
  ticker: string;
  name: string;
  sector: string;
  price: number;
  changePercent: number;
  score: number;
  recommendation: "BUY" | "HOLD" | "AVOID";
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  topReasons: string[];
  predictions: HorizonPrediction[];
  projections: ProjectionRow[];
  // V2: extra real quant values the admin daily-plan needs for trade planning.
  atr14: number | null;
  annualVolatilityPct: number | null;
  directionProb7d: number | null;
  // V5: technical-only entry timing (news=null, pop7d=directionProb7d).
  entryAction: EntryAction;
  entryScore: number;
  // Risk-spec Rule 15: extension inputs for scan bucketing.
  week52PositionPct: number | null;
  r60dPct: number | null;
}

export interface ScanResult {
  asOf: string;
  scannedCount: number;
  entries: ScanEntry[]; // sorted by score desc, ALL scanned stocks
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** YYYY-MM-DD in Asia/Kolkata. */
function istDateString(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** dateStr (YYYY-MM-DD) + n calendar days → YYYY-MM-DD. */
function addCalendarDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/** pg 'date' columns can come back as Date or string — normalize to YYYY-MM-DD. */
function toDateStr(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function mapRiskToEntity(risk: "LOW" | "MEDIUM" | "HIGH"): "Low" | "Medium" | "High" {
  return risk === "LOW" ? "Low" : risk === "HIGH" ? "High" : "Medium";
}

/** Old rows may carry legacy vocabulary — surface only BUY/HOLD/AVOID. */
function mapRecommendationOut(rec: string | null): string | null {
  if (rec === null) return null;
  return rec === "SELL" ? "AVOID" : rec;
}

export class StockService {
  private topPicksCache: ScanResult | null = null;
  private topPicksBuiltAt = 0;
  private scanInFlight: Promise<ScanResult> | null = null;
  private scanInFlightLogsPredictions = false;

  // ── Search ─────────────────────────────────────────────────────────────────

  async search(query: string): Promise<Array<{ ticker: string; name: string; exchange: string }>> {
    const q = (query ?? "").trim();
    if (!q) return [];
    return marketDataService.search(q);
  }

  // ── Analyze ────────────────────────────────────────────────────────────────

  /**
   * @param opts.persist Default true (POST /api/analyze records its analysis
   * and same-day predictions append-only-if-absent). Read-shaped callers
   * (GET /api/research) MUST pass false — reads never mutate canon.
   */
  async analyze(
    tickerOrName: string,
    amount?: number,
    opts?: { persist?: boolean }
  ): Promise<AnalyzeResponse> {
    const persist = opts?.persist !== false;
    const resolved = await marketDataService.resolve(tickerOrName);
    if (!resolved) {
      throw new HttpError(
        404,
        `Could not resolve "${tickerOrName}" to an analyzable NSE/BSE stock. This tool analyzes individual ` +
          `listed companies (technicals + fundamentals) — mutual funds, ETFs and index products aren't ` +
          `supported since they don't have the daily price/fundamental data this analysis needs. ` +
          `Try a company name or ticker instead, e.g. "Reliance", "TCS", "HDFC Bank".`
      );
    }
    const ticker = resolved.ticker;

    // V2: kick off fundamentals / macro / sector-momentum fetches NOW so they
    // run concurrently with the bars+quote work below. Each degrades honestly:
    // a failure yields null and the framework phases are marked no-data with
    // the warning recorded — the analyze request itself never fails for this.
    let fundamentalsWarning: string | null = null;
    const fundamentalsP: Promise<Fundamentals | null> = fundamentalsService
      .getFundamentals(ticker)
      .catch((err: Error) => {
        fundamentalsWarning = err.message;
        return null;
      });
    const regimeP: Promise<MarketRegime | null> = macroService
      .getMarketRegime()
      .catch((err: Error) => {
        console.warn(`⚠️ macro regime unavailable: ${err.message}`);
        return null;
      });
    const sectorP: Promise<SectorMomentumSnapshot | null> = frameworkService
      .getSectorMomentum()
      .catch((err: Error) => {
        console.warn(`⚠️ sector momentum unavailable: ${err.message}`);
        return null;
      });
    // V5: two-source news radar — a failure yields null and NEVER blocks the
    // analysis (the entry-timing verdict simply becomes non-news-aware).
    const newsP: Promise<NewsSummary | null> = newsService
      .getNews(ticker, resolved.name)
      .catch((err: Error) => {
        console.warn(`⚠️ news unavailable for ${ticker}: ${err.message}`);
        return null;
      });

    const { bars, source: barsSource } =
      await marketDataService.getDailyBarsWithSource(ticker, "2y");
    if (bars.length < MIN_BARS_FOR_ANALYSIS) {
      throw new HttpError(
        422,
        `${ticker} does not have enough real trading history to analyze (${bars.length} of the required ` +
          `${MIN_BARS_FOR_ANALYSIS} daily bars). This usually means it's a newly listed stock, a thinly-traded ` +
          `product, or not a regular equity — this tool needs real price history to compute anything.`
      );
    }

    let niftyBars: Bar[] | undefined;
    try {
      niftyBars = await marketDataService.getNiftyBars("1y");
    } catch {
      niftyBars = undefined; // relative-strength signal degrades to neutral
    }

    let quote: Quote;
    let dataStatus: "live" | "cached";
    try {
      quote = await marketDataService.getQuote(ticker);
      // A live quote alone is not enough: if the bars silently fell back to
      // stale DB history (Yahoo unreachable), the analysis is degraded and
      // must say so (REBUILD_SPEC ground rule 2).
      dataStatus = barsSource === "db-stale" ? "cached" : "live";
    } catch {
      // Yahoo quote unavailable — fall back to the latest REAL bar (never fabricated).
      quote = this.quoteFromBars(ticker, bars);
      dataStatus = "cached";
    }

    const analysis = analyzeBars(bars, { niftyBars });
    const projections = buildProjections(quote.price, analysis.predictions);
    const chart = this.buildChartPayload(bars, 250);
    const accuracy = await this.latestAccuracySummary(ticker);

    // V5: seeded bootstrap Monte Carlo from the SAME real bars' daily returns.
    let monteCarlo: MonteCarloForecast;
    try {
      monteCarlo = simulateBootstrap(adjustedDailyReturns(bars));
    } catch (err) {
      // Only possible with <61 bars (we already require 60) — surface honestly.
      throw new HttpError(
        422,
        `${ticker} has too little real return history for the Monte Carlo forecast: ${(err as Error).message}`
      );
    }

    // V5: 1-year beta vs NIFTY (cov/var over overlapping daily returns).
    const beta1y = this.computeBeta1y(bars, niftyBars);

    // V2: await the concurrent fetches and compose framework + plans.
    const [fundamentals, macro, sectorMomentum, news] = await Promise.all([
      fundamentalsP,
      regimeP,
      sectorP,
      newsP,
    ]);

    // V5: news-aware entry timing — pop7d from the Monte Carlo forecast.
    // (The V7 six-model ensemble blend was removed from production execution
    // per upgrade-spec §2 — historical ensemble_weights rows are preserved as
    // experiment artifacts; nothing here consumes them anymore.)
    const mcPop7 = monteCarlo.horizons.find((h) => h.horizonDays === 7)?.pop ?? null;
    const pop7dInput = mcPop7;
    const entryTiming = computeEntryTiming({
      quantScore: analysis.score,
      recommendation: analysis.recommendation,
      rsi14: analysis.technicals.rsi14,
      bollingerPercentB: analysis.technicals.bollinger?.percentB ?? null,
      regime: macro?.regime ?? null,
      pop7d: pop7dInput,
      expected1dPct:
        analysis.predictions.find((p) => p.horizonDays === 1)?.expectedReturnPct ?? null,
      news: news
        ? {
            sentimentScore: news.sentimentScore,
            hypeTemperature: news.hypeTemperature,
            fresh24hCount: news.fresh24hCount,
          }
        : null,
      bollingerLower: analysis.technicals.bollinger?.lower ?? null,
    });

    const forecastUpperCandidates = [
      (() => {
        const p = analysis.predictions.find((prediction) => prediction.horizonDays === 30);
        return p && Number.isFinite(p.high80Pct)
          ? { horizonDays: 30, upperReturnPct: p.high80Pct, label: "the 80% forecast upper bound" }
          : null;
      })(),
      (() => {
        const h = monteCarlo.horizons.find((horizon) => horizon.horizonDays === 30);
        return h && Number.isFinite(h.percentiles.p95)
          ? { horizonDays: 30, upperReturnPct: h.percentiles.p95, label: "the bootstrap p95 upper bound" }
          : null;
      })(),
    ].filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null && candidate.upperReturnPct > 0);
    const forecastConstraint = forecastUpperCandidates.sort(
      (a, b) => a.upperReturnPct - b.upperReturnPct
    )[0] ?? null;
    const recentResistance = Math.max(
      ...bars.slice(-61, -1).map((bar) => bar.high).filter(Number.isFinite)
    );
    const technicalResistance = Number.isFinite(recentResistance) && recentResistance > quote.price
      ? { price: recentResistance, label: "the observed 60-session resistance" }
      : null;

    const tradePlan: TradePlan | null = buildTradePlan({
      entry: quote.price,
      atr14: analysis.technicals.atr14,
      annualVolatilityPct: analysis.technicals.annualVolatilityPct,
      recommendation: analysis.recommendation,
      forecastConstraint,
      technicalResistance,
    });

    const sector =
      NSE_UNIVERSE.find((u) => u.ticker === ticker)?.sector ?? null;
    const framework = frameworkService.buildReport({
      ticker,
      sector,
      price: quote.price,
      quant: analysis,
      fundamentals,
      fundamentalsWarning,
      regime: macro,
      sectorMomentum,
      tradePlan,
    });

    const investmentPlan: InvestmentPlan | null =
      amount !== undefined
        ? buildInvestmentPlan({
            amount,
            price: quote.price,
            ticker,
            tradePlan,
            predictions: analysis.predictions,
            recommendation: analysis.recommendation,
          })
        : null;

    // Persist Analysis + PredictionLog rows (best-effort: a storage hiccup
    // must not turn a completed analysis into a 500). Read-shaped callers
    // (GET /api/research) pass persist:false — a read must not mutate
    // canonical records (upgrade-audit §4 #2). PredictionLog writes are
    // append-only-if-absent: a same-day row is NEVER deleted or rewritten.
    if (persist) {
      try {
        await this.persistAnalysis(ticker, quote, analysis);
        await this.persistPredictionLogs(ticker, bars, analysis);
      } catch (err) {
        console.error(`⚠️ Failed to persist analysis rows for ${ticker}:`, err);
      }
    }

    return {
      ticker,
      name: resolved.name,
      exchange: resolved.exchange,
      currency: "INR",
      quote,
      analysis,
      projections,
      accuracy,
      chart,
      dataStatus,
      disclaimer: DISCLAIMER,
      framework,
      macro,
      fundamentals,
      tradePlan,
      investmentPlan,
      news,
      monteCarlo,
      entryTiming,
      beta1y,
    };
  }

  /**
   * V5: 1-year beta vs NIFTY 50 — cov(stock, nifty) / var(nifty) over
   * overlapping daily returns (dates present in BOTH series). Returns null
   * when fewer than 100 overlapping return observations exist — an honest
   * "not enough data", never a made-up 1.0.
   */
  private computeBeta1y(bars: Bar[], niftyBars: Bar[] | undefined): number | null {
    if (!niftyBars || niftyBars.length < 2) return null;
    const niftyByDate = new Map(niftyBars.map((b) => [b.date, b.close]));
    const window = bars.slice(-260); // ~1 trading year
    const paired: Array<{ s: number; n: number }> = [];
    for (const b of window) {
      const n = niftyByDate.get(b.date);
      if (n !== undefined && b.close > 0 && n > 0) paired.push({ s: b.close, n });
    }
    const sRet: number[] = [];
    const nRet: number[] = [];
    for (let i = 1; i < paired.length; i++) {
      sRet.push(paired[i].s / paired[i - 1].s - 1);
      nRet.push(paired[i].n / paired[i - 1].n - 1);
    }
    if (sRet.length < 100) return null;
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const mS = mean(sRet);
    const mN = mean(nRet);
    let cov = 0;
    let varN = 0;
    for (let i = 0; i < sRet.length; i++) {
      cov += (sRet[i] - mS) * (nRet[i] - mN);
      varN += (nRet[i] - mN) ** 2;
    }
    if (varN === 0) return null;
    return Number((cov / varN).toFixed(3));
  }

  /** Quote derived from the latest real bars (fallback when Yahoo is down). */
  private quoteFromBars(ticker: string, bars: Bar[]): Quote {
    const last = bars[bars.length - 1];
    const prev = bars.length > 1 ? bars[bars.length - 2] : last;
    const w52 = bars.slice(-252);
    const change = last.close - prev.close;
    return {
      ticker,
      price: last.close,
      previousClose: prev.close,
      change,
      changePercent: prev.close !== 0 ? (change / prev.close) * 100 : 0,
      dayHigh: last.high,
      dayLow: last.low,
      volume: last.volume,
      fiftyTwoWeekHigh: Math.max(...w52.map((b) => b.high)),
      fiftyTwoWeekLow: Math.min(...w52.map((b) => b.low)),
      currency: "INR",
      asOf: new Date(`${last.date}T15:30:00+05:30`).toISOString(),
    };
  }

  private buildChartPayload(bars: Bar[], windowBars: number): ChartPayload {
    const closes = bars.map((b) => b.close);
    const start = Math.max(0, bars.length - windowBars);
    return {
      bars: bars.slice(start),
      sma20: smaSeries(closes, 20).slice(start),
      sma50: smaSeries(closes, 50).slice(start),
      sma200: smaSeries(closes, 200).slice(start),
    };
  }

  private async latestAccuracySummary(ticker: string): Promise<AccuracySummary | null> {
    const row = await AppDataSource.getRepository(ModelPerformance).findOne({
      where: { ticker, modelVersion: MODEL_VERSION },
      order: { ranAt: "DESC" },
    });
    if (!row || !row.horizons || !row.ranAt) return null;
    return {
      testDays: row.testDays ?? DEFAULT_BACKTEST_DAYS,
      horizons: row.horizons as AccuracySummary["horizons"],
      ranAt: new Date(row.ranAt).toISOString(),
    };
  }

  private async persistAnalysis(
    ticker: string,
    quote: Quote,
    analysis: QuantAnalysis
  ): Promise<void> {
    const stock = await AppDataSource.getRepository(Stock).findOne({ where: { ticker } });
    if (!stock) return; // stock row is created by getDailyBars persistence; nothing to attach to

    const p30 = analysis.predictions.find((p) => p.horizonDays === 30);
    const summaryParts = [
      `${ticker}: score ${analysis.score}/100 — ${analysis.recommendation} (${analysis.riskLevel} risk).`,
    ];
    if (p30) {
      summaryParts.push(
        `30d expected ${p30.expectedReturnPct >= 0 ? "+" : ""}${p30.expectedReturnPct.toFixed(2)}% ` +
          `(80% band ${p30.low80Pct.toFixed(2)}%..${p30.high80Pct.toFixed(2)}%).`
      );
    }
    if (analysis.reasons.positive[0]) summaryParts.push(analysis.reasons.positive[0]);
    if (analysis.reasons.negative[0]) summaryParts.push(analysis.reasons.negative[0]);

    const row = AppDataSource.getRepository(Analysis).create({
      stockId: stock.id,
      summary: summaryParts.join(" "),
      recommendation: analysis.recommendation,
      riskLevel: mapRiskToEntity(analysis.riskLevel),
      currentPrice: quote.price,
      rsi: analysis.technicals.rsi14 ?? undefined,
      score: analysis.score,
      priceChangePercent: Number(quote.changePercent.toFixed(2)),
    });
    await AppDataSource.getRepository(Analysis).save(row);
  }

  /**
   * One PredictionLog row per horizon, keyed to the date of the last bar the
   * prediction was computed from.
   *
   * APPEND-ONLY-IF-ABSENT (Phase B1 fix, upgrade-audit §4 #2/#5): if ANY row
   * already exists for (ticker, modelVersion, predictionDate) the write is
   * skipped entirely — the first record of the day stands. Rows are NEVER
   * deleted or rewritten here; prediction history is an immutable record
   * (spec §5 — a re-analysis must not move a previously logged prediction).
   */
  private async persistPredictionLogs(
    ticker: string,
    bars: Bar[],
    analysis: QuantAnalysis
  ): Promise<void> {
    const lastBar = bars[bars.length - 1];
    const predictionDate = lastBar.date;
    const repo = AppDataSource.getRepository(PredictionLog);

    const existing = await repo.count({
      where: {
        ticker,
        modelVersion: MODEL_VERSION,
        predictionDate: predictionDate as unknown as Date,
      },
    });
    if (existing > 0) return; // same-day rows exist — never delete, never rewrite

    const rows = analysis.predictions.map((p) =>
      repo.create({
        ticker,
        predictionDate: predictionDate as unknown as Date,
        modelVersion: MODEL_VERSION,
        predictedDirection:
          p.directionProb > 0.5 ? "UP" : p.directionProb < 0.5 ? "DOWN" : "UNCERTAIN",
        predictedProbability: p.directionProb,
        confidence: p.directionProb,
        expectedReturn: p.expectedReturnPct,
        expectedVolatility: analysis.technicals.annualVolatilityPct ?? undefined,
        horizonDays: p.horizonDays,
        targetDate: addCalendarDays(predictionDate, p.horizonDays) as unknown as Date,
        basePrice: lastBar.close,
        expectedPrice: p.expectedPrice,
        low80Pct: p.low80Pct,
        high80Pct: p.high80Pct,
        score: analysis.score,
        predictionUncertainty: analysis.riskLevel.toLowerCase(),
        recommendationGiven: analysis.recommendation,
      })
    );
    await repo.save(rows);
  }

  // ── Daily scan (30-min cached) — bucketed per risk-spec Rule 15 ───────────

  async getTopPicks(count: number, maxPrice?: number): Promise<TopPicksResponse> {
    const scan = await this.getScan(false);
    let pool = scan.entries;
    let affordableCount: number | null = null;
    if (maxPrice !== undefined && Number.isFinite(maxPrice) && maxPrice > 0) {
      pool = scan.entries.filter((e) => e.price <= maxPrice);
      affordableCount = pool.length;
    }

    // Rule 15: ONLY stocks with a currently-valid gate-passed canonical
    // decision may appear under BEST NEW ENTRIES. Read stored snapshots —
    // never recompute or lower the bar here.
    let gatePassed = new Set<string>();
    try {
      const rows: Array<{ ticker: string }> = await AppDataSource.query(
        `SELECT DISTINCT ON (instrument_id) ticker
           FROM decision_snapshots
          WHERE decision_status = 'BUY_CANDIDATE' AND valid_until > now()
          ORDER BY instrument_id, as_of DESC`
      );
      gatePassed = new Set(rows.map((r) => r.ticker));
    } catch {
      gatePassed = new Set(); // unreadable ⇒ nobody passes (conservative)
    }

    const toPick = (e: ScanEntry, i: number): TopPick => ({
      rank: i + 1,
      ticker: e.ticker,
      name: e.name,
      sector: e.sector,
      price: e.price,
      changePercent: e.changePercent,
      score: e.score,
      recommendation: e.recommendation,
      riskLevel: e.riskLevel,
      topReasons: e.topReasons,
      predictions: e.predictions,
      projections: e.projections,
      entryAction: e.entryAction,
      entryScore: e.entryScore,
    });

    const byScore = [...pool].sort((a, b) => b.score - a.score);
    const extended = (e: ScanEntry) =>
      e.week52PositionPct != null && e.week52PositionPct >= 90 && e.r60dPct != null && e.r60dPct >= 15;

    const best: ScanEntry[] = [];
    const highRisk: ScanEntry[] = [];
    const strongExtended: ScanEntry[] = [];
    const pullback: ScanEntry[] = [];
    let insufficientCount = 0;
    for (const e of byScore) {
      if (gatePassed.has(e.ticker)) best.push(e);
      else if (e.score >= 62 && e.riskLevel === "HIGH") highRisk.push(e);
      else if (e.score >= 62 && extended(e)) strongExtended.push(e);
      else if (e.score >= 62) pullback.push(e);
      else insufficientCount++;
    }

    const cap = Math.max(count, 5);
    const buckets = {
      bestNewEntries: best.slice(0, cap).map(toPick),
      strongButExtended: strongExtended.slice(0, cap).map(toPick),
      watchForPullback: pullback.slice(0, cap).map(toPick),
      highRiskMomentum: highRisk.slice(0, cap).map(toPick),
      insufficientEdgeCount: insufficientCount,
    };
    const bestNewEntriesNote =
      best.length > 0
        ? `${best.length} stock(s) currently pass the evidence gate (validated edge, calibration, data quality, entry quality, EV after costs).`
        : "No statistically attractive entries today — no stock currently passes the evidence gate " +
          "(validated directional edge on independent samples, calibration, data quality, entry quality, " +
          "positive expected value after costs). Strong setups without that evidence are listed below as " +
          "what they are: setups, not recommendations.";

    // Legacy flat list (highest setup scores, HIGH-risk carve-out retained for
    // response-shape compatibility) — the UI now renders buckets instead.
    const eligible = byScore.filter((e) => e.riskLevel !== "HIGH" || e.score >= 75);
    const picks: TopPick[] = eligible.slice(0, count).map(toPick);
    const note =
      maxPrice !== undefined && affordableCount !== null
        ? `Budget mode: of ${scan.scannedCount} stocks scanned, ${affordableCount} trade at or under ` +
          `₹${maxPrice.toLocaleString("en-IN")} per share. Buckets are SETUP descriptions ranked by the ` +
          `setup score — only the evidence gate can call anything a buy.`
        : `Buckets are SETUP descriptions ranked by the setup score across all ${scan.scannedCount} scanned ` +
          `stocks — only the evidence gate can call anything a buy (see Best new entries).`;

    return {
      asOf: scan.asOf,
      universeSize: NSE_UNIVERSE.length,
      scannedCount: scan.scannedCount,
      maxPrice: maxPrice !== undefined && Number.isFinite(maxPrice) && maxPrice > 0 ? maxPrice : null,
      affordableCount,
      note,
      picks,
      buckets,
      bestNewEntriesNote,
    };
  }

  /**
   * V2-D: public accessor to the same cached universe scan the top-picks
   * endpoint uses — the admin daily plan REUSES this cache (no extra scans).
   */
  async getScanSnapshot(): Promise<ScanResult> {
    return this.getScan(false);
  }

  /**
   * V10 B4 — cache-only scan peek: the ticker's entry from the FRESH (≤30min)
   * cached scan, or null. NEVER triggers a scan — the buy-path entry-context
   * snapshot must not add a ~90s universe scan to a trade record.
   */
  peekScanEntry(ticker: string): ScanEntry | null {
    if (!this.topPicksCache || Date.now() - this.topPicksBuiltAt >= TOP_PICKS_TTL_MS) {
      return null;
    }
    return this.topPicksCache.entries.find((e) => e.ticker === ticker) ?? null;
  }

  /** Cached scan accessor — 30-minute TTL; scanUniverse() single-flights. */
  private async getScan(force: boolean): Promise<ScanResult> {
    if (
      !force &&
      this.topPicksCache &&
      Date.now() - this.topPicksBuiltAt < TOP_PICKS_TTL_MS
    ) {
      return this.topPicksCache;
    }
    return this.scanUniverse({ logPredictions: false });
  }

  /**
   * Scan the whole universe from DB bars (stale tickers are refreshed from
   * Yahoo best-effort; actual Yahoo fetches are followed by a throttle pause).
   *
   * Single-flight: at most one scan runs at a time, whether triggered by HTTP
   * (top-picks) or by the 08:45 cron. Callers that don't need prediction
   * logging piggyback on any in-flight scan; a logging caller (the cron) never
   * piggybacks on a non-logging scan — it waits, then runs its own.
   */
  async scanUniverse(opts?: { logPredictions?: boolean }): Promise<ScanResult> {
    const logPredictions = opts?.logPredictions === true;
    while (this.scanInFlight) {
      if (!logPredictions || this.scanInFlightLogsPredictions) {
        return this.scanInFlight;
      }
      await this.scanInFlight.catch(() => undefined);
    }
    const run = this.runScan(logPredictions).finally(() => {
      if (this.scanInFlight === run) {
        this.scanInFlight = null;
      }
    });
    this.scanInFlight = run;
    this.scanInFlightLogsPredictions = logPredictions;
    return run;
  }

  /** The actual universe scan — only ever entered via scanUniverse(). */
  private async runScan(logPredictions: boolean): Promise<ScanResult> {
    let niftyBars: Bar[] | undefined;
    try {
      niftyBars = await marketDataService.getNiftyBars("1y");
    } catch {
      niftyBars = undefined;
    }
    // V5: one regime fetch for the whole scan (entry timing input); no news
    // fetches here — 151 tickers would hammer the free sources.
    const scanRegime: MarketRegime | null = await macroService
      .getMarketRegime()
      .catch(() => null);

    const entries: ScanEntry[] = [];
    for (const u of NSE_UNIVERSE) {
      try {
        const { bars, source } = await marketDataService.getDailyBarsWithSource(
          u.ticker,
          "1y"
        );
        if (bars.length < MIN_BARS_FOR_ANALYSIS) continue;

        const analysis = analyzeBars(bars, { niftyBars });
        const last = bars[bars.length - 1];
        const prev = bars.length > 1 ? bars[bars.length - 2] : last;
        const directionProb7d =
          analysis.predictions.find((p) => p.horizonDays === 7)?.directionProb ?? null;
        // V5: technical-only entry timing (news=null → newsAware=false).
        const entryTiming = computeEntryTiming({
          quantScore: analysis.score,
          recommendation: analysis.recommendation,
          rsi14: analysis.technicals.rsi14,
          bollingerPercentB: analysis.technicals.bollinger?.percentB ?? null,
          regime: scanRegime?.regime ?? null,
          pop7d: directionProb7d,
          expected1dPct:
            analysis.predictions.find((p) => p.horizonDays === 1)?.expectedReturnPct ?? null,
          news: null,
          bollingerLower: analysis.technicals.bollinger?.lower ?? null,
        });
        entries.push({
          ticker: u.ticker,
          name: u.name,
          sector: u.sector,
          price: last.close,
          changePercent:
            prev.close !== 0
              ? Number((((last.close - prev.close) / prev.close) * 100).toFixed(2))
              : 0,
          score: analysis.score,
          recommendation: analysis.recommendation,
          riskLevel: analysis.riskLevel,
          topReasons: analysis.reasons.positive.slice(0, 3),
          predictions: analysis.predictions,
          projections: buildProjections(last.close, analysis.predictions),
          atr14: analysis.technicals.atr14,
          annualVolatilityPct: analysis.technicals.annualVolatilityPct,
          directionProb7d,
          entryAction: entryTiming.action,
          entryScore: entryTiming.score,
          week52PositionPct: analysis.technicals.week52?.positionPct ?? null,
          r60dPct: analysis.technicals.returns.r60dPct,
        });

        if (logPredictions) {
          await this.persistPredictionLogs(u.ticker, bars, analysis);
        }
        // Space out actual Yahoo fetches ≥300ms (spec ground rule 1);
        // DB-served tickers need no pause.
        if (source === "yahoo") await sleep(350);
      } catch (err) {
        console.warn(`⚠️ scan skipped ${u.ticker}:`, (err as Error).message);
      }
    }

    entries.sort((a, b) => b.score - a.score);
    const result: ScanResult = {
      asOf: new Date().toISOString(),
      scannedCount: entries.length,
      entries,
    };
    this.topPicksCache = result;
    this.topPicksBuiltAt = Date.now();
    return result;
  }

  // ── Backtest & accuracy ────────────────────────────────────────────────────

  /**
   * PURE walk-forward backtest — computes and RETURNS the stats without
   * touching ModelPerformance (Phase B1 fix, upgrade-audit §4 #1: a GET must
   * never overwrite official statistics). Official stats change only via the
   * job path (runBacktestJob) or the evening verification cron.
   *
   * The V7 six-model pool merge was removed from production execution
   * (upgrade-spec §2); historical ModelPerformance rows keep their stored
   * per-model jsonb keys untouched as experiment evidence.
   */
  async runBacktest(tickerOrName: string, testDays: number): Promise<BacktestResult> {
    const resolved = await marketDataService.resolve(tickerOrName);
    if (!resolved) {
      throw new HttpError(
        404,
        `Could not resolve "${tickerOrName}" to an Indian (NSE/BSE) listing.`
      );
    }
    const days = Math.min(Math.max(Math.floor(testDays), 10), 250);
    const bars = await marketDataService.getDailyBars(resolved.ticker, "2y");
    if (bars.length < 122) {
      throw new HttpError(
        422,
        `Not enough price history for ${resolved.ticker} to backtest: need at least 122 daily bars, have ${bars.length}.`
      );
    }
    return backtestBars(resolved.ticker, bars, { testDays: days });
  }

  /**
   * POST /api/jobs/backtest — the ONLY request path that may update the
   * official ModelPerformance row for a ticker. Every run appends an
   * immutable job record to cron_execution_logs (insert-only; the table is
   * the existing safe JobRun-style mechanism until the Phase C durable
   * queue lands — plan §2 JobRun).
   */
  async runBacktestJob(
    tickerOrName: string,
    testDays: number
  ): Promise<{ jobRunId: string; ticker: string; testDays: number; result: BacktestResult }> {
    const startedAt = new Date();
    const jobRepo = AppDataSource.getRepository(CronExecutionLog);
    try {
      const result = await this.runBacktest(tickerOrName, testDays);
      const bars = await marketDataService.getDailyBars(result.ticker, "2y");
      await this.upsertModelPerformance(result.ticker, result, bars);
      const record = await jobRepo.save(
        jobRepo.create({
          jobName: "job:backtest",
          executionStart: startedAt,
          executionEnd: new Date(),
          executionDurationMs: Date.now() - startedAt.getTime(),
          status: "completed",
          stocksProcessed: 1,
          stocksFailed: 0,
          apiCallsMade: 0,
          errorSummary: `ticker=${result.ticker} testDays=${result.testDays} ranAt=${result.ranAt}`,
        })
      );
      return { jobRunId: record.id, ticker: result.ticker, testDays: result.testDays, result };
    } catch (err) {
      // Failure is recorded too (append-only) — then surfaced to the caller.
      await jobRepo
        .save(
          jobRepo.create({
            jobName: "job:backtest",
            executionStart: startedAt,
            executionEnd: new Date(),
            executionDurationMs: Date.now() - startedAt.getTime(),
            status: "failed",
            stocksProcessed: 0,
            stocksFailed: 1,
            apiCallsMade: 0,
            errorSummary: `ticker=${tickerOrName}: ${(err as Error).message}`,
          })
        )
        .catch(() => undefined);
      throw err;
    }
  }

  async upsertModelPerformance(
    ticker: string,
    result: BacktestResult,
    bars: Bar[]
  ): Promise<void> {
    const totalPredictions = result.horizons.reduce((s, h) => s + h.samples, 0);
    const correctPredictions = result.horizons.reduce(
      (s, h) => s + Math.round((h.directionHitRatePct / 100) * h.samples),
      0
    );
    const accuracy =
      totalPredictions > 0
        ? Number((correctPredictions / totalPredictions).toFixed(4))
        : 0;

    // Walk-forward window: T ranges over the last testDays trading days.
    const n = bars.length;
    const startIdx = Math.min(Math.max(120, n - result.testDays), Math.max(0, n - 2));
    const periodStart = bars[startIdx]?.date ?? bars[0].date;
    const periodEnd = bars[n - 1].date;

    // Atomic ON CONFLICT upsert on the (ticker, model_version) unique index —
    // concurrent backtests can never create duplicate rows.
    await AppDataSource.getRepository(ModelPerformance).upsert(
      {
        ticker,
        modelVersion: MODEL_VERSION,
        testDays: result.testDays,
        ranAt: new Date(result.ranAt),
        horizons: result.horizons,
        periodStart: periodStart as unknown as Date,
        periodEnd: periodEnd as unknown as Date,
        aggregationLevel: "backtest",
        totalPredictions,
        correctPredictions,
        accuracy,
        accuracyBelowThreshold: accuracy < 0.65,
      },
      ["ticker", "modelVersion"]
    );
  }

  async getAccuracy(): Promise<AccuracyResponse> {
    const rows = await AppDataSource.getRepository(ModelPerformance)
      .createQueryBuilder("mp")
      .where("mp.model_version = :mv", { mv: MODEL_VERSION })
      .andWhere("mp.ticker IS NOT NULL")
      .andWhere("mp.horizons IS NOT NULL")
      .orderBy("mp.ran_at", "DESC")
      .getMany();

    // Latest row per ticker (upsert should keep one, but be defensive).
    const latestByTicker = new Map<string, ModelPerformance>();
    for (const row of rows) {
      if (row.ticker && !latestByTicker.has(row.ticker)) {
        latestByTicker.set(row.ticker, row);
      }
    }

    // Aggregate horizons across the universe, weighted by sample count.
    const agg = new Map<
      number,
      { samples: number; hit: number; err: number; pred: number; act: number; band: number }
    >();
    for (const row of latestByTicker.values()) {
      for (const h of row.horizons ?? []) {
        const a =
          agg.get(h.horizonDays) ??
          { samples: 0, hit: 0, err: 0, pred: 0, act: 0, band: 0 };
        a.samples += h.samples;
        a.hit += (h.directionHitRatePct / 100) * h.samples;
        a.err += h.avgAbsErrorPct * h.samples;
        a.pred += h.avgPredictedPct * h.samples;
        a.act += h.avgActualPct * h.samples;
        a.band += (h.withinBandPct / 100) * h.samples;
        agg.set(h.horizonDays, a);
      }
    }
    const overall = [1, 3, 7, 15, 30]
      .filter((h) => agg.has(h))
      .map((h) => {
        const a = agg.get(h)!;
        const n = a.samples || 1;
        return {
          horizonDays: h as Horizon,
          samples: a.samples,
          // Risk-spec Rule 3: a 1-trading-day-step backtest makes h-day
          // predictions share (h_td−1)/h_td of their outcome windows; the raw
          // count wildly overstates the evidence. Report BOTH, per ticker
          // (cross-ticker correlation makes even this an upper bound).
          effectiveIndependentSamples: Math.max(
            1,
            Math.floor(a.samples / Math.max(1, TRADING_DAY_OFFSETS[h as Horizon] ?? 1))
          ),
          directionHitRatePct: Number(((a.hit / n) * 100).toFixed(2)),
          avgAbsErrorPct: Number((a.err / n).toFixed(4)),
          avgPredictedPct: Number((a.pred / n).toFixed(4)),
          avgActualPct: Number((a.act / n).toFixed(4)),
          withinBandPct: Number(((a.band / n) * 100).toFixed(2)),
        };
      });

    const universeNames = new Map(NSE_UNIVERSE.map((u) => [u.ticker, u.name]));
    const perStock: AccuracyPerStock[] = Array.from(latestByTicker.values())
      .map((row) => {
        const horizons = row.horizons ?? [];
        const rate = (h: number): number | null => {
          const stat = horizons.find((x) => x.horizonDays === h);
          return stat && stat.samples > 0 ? Number(stat.directionHitRatePct.toFixed(2)) : null;
        };
        return {
          ticker: row.ticker!,
          name: universeNames.get(row.ticker!) ?? row.ticker!,
          hitRate1d: rate(1),
          hitRate7d: rate(7),
          hitRate30d: rate(30),
          samples: horizons.reduce((s, h) => s + h.samples, 0),
        };
      })
      .sort((a, b) => (b.hitRate7d ?? -1) - (a.hitRate7d ?? -1));

    const updatedAt = rows[0]?.ranAt
      ? new Date(rows[0].ranAt).toISOString()
      : new Date(0).toISOString();

    return {
      overall,
      perStock,
      updatedAt,
      perStockCaveat:
        "Per-stock horizon hit rates use OVERLAPPING backtest windows (e.g. ~40 samples of " +
        "21-trading-day windows share most of their days — closer to 2–3 independent observations). " +
        "Extreme per-stock rates (0% or 100%) at 15d/30d are usually one trend counted many times, " +
        "not skill. Trust the aggregate table and short horizons first.",
      methodology:
        "Accuracy is measured by walk-forward backtesting: for each of the last 60 trading days, " +
        "the model was given only the bars available up to that day, its 1/3/7/15/30-day predictions were " +
        "recorded, and then compared against what the stock actually did. Direction hit rate is the share of " +
        "predictions that got the direction right; within-band is the share of actual returns that landed inside " +
        "the stated 80% range. 100% accuracy is impossible — these are honest, measured historical rates, " +
        "and they change as markets change.",
      disclaimer: DISCLAIMER,
    };
  }

  // ── V6: Calibration dashboard (SPEC_CALIBRATION Module C2) ────────────────

  /**
   * GET /api/calibration — how honest are the stated direction probabilities?
   * Backtest side: sample-weighted aggregation of the brierScore/probBuckets
   * stored on ModelPerformance rows (run scripts/refreshBacktests.ts to fill
   * them). Live side: brier measured on VERIFIED PredictionLog rows
   * (predicted_probability vs actual_direction), null under 10 samples.
   * The interpretation string is COMPUTED from the real numbers, never canned.
   */
  async getCalibration(): Promise<CalibrationResponse> {
    const rows = await AppDataSource.getRepository(ModelPerformance)
      .createQueryBuilder("mp")
      .where("mp.model_version = :mv", { mv: MODEL_VERSION })
      .andWhere("mp.ticker IS NOT NULL")
      .andWhere("mp.horizons IS NOT NULL")
      .orderBy("mp.ran_at", "DESC")
      .getMany();

    const latestByTicker = new Map<string, ModelPerformance>();
    for (const row of rows) {
      if (row.ticker && !latestByTicker.has(row.ticker)) {
        latestByTicker.set(row.ticker, row);
      }
    }

    // Sample-weighted pooling per horizon; buckets pooled by fixed edge index.
    interface HAgg {
      samples: number;
      brierSum: number; // Σ brier × samples
      bandSum: number; // Σ withinBand fraction × samples (for the interpretation)
      buckets: Array<{ n: number; predSum: number; upSum: number }>;
    }
    const agg = new Map<Horizon, HAgg>();

    // NOTE: the V7 per-model/blended-ensemble aggregation was removed from
    // production execution (upgrade-spec §2 row 6). Historical
    // ModelPerformance rows still carry their stored per-model jsonb keys —
    // preserved as experiment evidence, no longer aggregated here.
    for (const row of latestByTicker.values()) {
      for (const h of row.horizons ?? []) {
        if (
          h.samples <= 0 ||
          typeof h.brierScore !== "number" ||
          !Array.isArray(h.probBuckets)
        ) {
          continue; // pre-calibration row — honest omission, not a zero
        }
        const key = h.horizonDays as Horizon;
        const a =
          agg.get(key) ??
          {
            samples: 0,
            brierSum: 0,
            bandSum: 0,
            buckets: PROB_BUCKET_EDGES.map(() => ({ n: 0, predSum: 0, upSum: 0 })),
          };
        a.samples += h.samples;
        a.brierSum += h.brierScore * h.samples;
        a.bandSum += (h.withinBandPct / 100) * h.samples;
        for (const b of h.probBuckets) {
          const idx = PROB_BUCKET_EDGES.findIndex(
            ([lo, hi]) => lo === b.pLow && hi === b.pHigh
          );
          if (idx < 0 || b.n <= 0) continue;
          a.buckets[idx].n += b.n;
          a.buckets[idx].predSum += b.meanPredicted * b.n;
          a.buckets[idx].upSum += b.observedUpFreq * b.n;
        }
        agg.set(key, a);
      }
    }

    const backtest: CalibrationHorizon[] = ([1, 3, 7, 15, 30] as Horizon[])
      .filter((h) => (agg.get(h)?.samples ?? 0) > 0)
      .map((h) => {
        const a = agg.get(h)!;
        const brier = a.brierSum / a.samples;
        const buckets: ProbBucket[] = PROB_BUCKET_EDGES.map(([pLow, pHigh], i) => {
          const b = a.buckets[i];
          return {
            pLow,
            pHigh,
            n: b.n,
            meanPredicted: b.n > 0 ? Number((b.predSum / b.n).toFixed(4)) : 0,
            observedUpFreq: b.n > 0 ? Number((b.upSum / b.n).toFixed(4)) : 0,
          };
        });
        return {
          horizonDays: h,
          samples: a.samples,
          brierScore: Number(brier.toFixed(4)),
          coinFlipBrier: 0.25 as const,
          skillPct: Number((((0.25 - brier) / 0.25) * 100).toFixed(2)),
          buckets,
        };
      });

    // Live brier from VERIFIED PredictionLog rows (real outcomes only).
    const liveRows: Array<{ horizon_days: number; n: string; brier: string | null }> =
      await AppDataSource.query(
        `SELECT horizon_days,
                COUNT(*) AS n,
                AVG(POWER(predicted_probability::float8 -
                          CASE WHEN actual_direction = 'UP' THEN 1 ELSE 0 END, 2)) AS brier
           FROM prediction_logs
          WHERE model_version = $1
            AND actual_direction IS NOT NULL
            AND predicted_probability IS NOT NULL
            AND horizon_days IS NOT NULL
          GROUP BY horizon_days
          ORDER BY horizon_days`,
        [MODEL_VERSION]
      );
    const liveByHorizon = new Map(liveRows.map((r) => [Number(r.horizon_days), r]));
    const live: CalibrationLiveHorizon[] = [1, 3, 7, 15, 30].map((h) => {
      const r = liveByHorizon.get(h);
      const samples = r ? Number(r.n) : 0;
      const brier = r?.brier !== null && r?.brier !== undefined ? Number(r.brier) : null;
      return {
        horizonDays: h,
        samples,
        // Under 10 verified samples a brier is noise, not a measurement.
        brierScore: samples >= 10 && brier !== null ? Number(brier.toFixed(4)) : null,
      };
    });

    // ── Interpretation: computed from the numbers above, never hardcoded ──
    const totalSamples = backtest.reduce((s, h) => s + h.samples, 0);
    let interpretation: string;
    if (totalSamples === 0) {
      interpretation =
        "No calibration data stored yet — run `npx ts-node scripts/refreshBacktests.ts` to " +
        "re-backtest the universe and fill ModelPerformance with brier scores.";
    } else {
      const overallBrier =
        backtest.reduce((s, h) => s + h.brierScore * h.samples, 0) / totalSamples;
      const overallSkillPct = ((0.25 - overallBrier) / 0.25) * 100;
      const overallBandPct =
        (Array.from(agg.values()).reduce((s, a) => s + a.bandSum, 0) / totalSamples) * 100;
      const skillText =
        overallSkillPct >= 0
          ? `${overallSkillPct.toFixed(1)}% skill over a coin flip`
          : `${Math.abs(overallSkillPct).toFixed(1)}% WORSE than a coin flip`;
      const readText =
        overallSkillPct >= 5
          ? "the stated probabilities carry a modest real edge, but keep position sizing tight"
          : overallSkillPct >= -5
            ? "the direction probabilities are honest but carry essentially no directional edge — " +
              `trust the ranges (~${overallBandPct.toFixed(1)}% measured band coverage) and risk discipline over direction calls`
            : "the probabilities are overconfident — ignore direction confidence entirely and rely on the 80% ranges and stops";
      interpretation =
        `Brier ≈ ${overallBrier.toFixed(3)} vs 0.25 coin-flip across ` +
        `${totalSamples.toLocaleString("en-IN")} walk-forward samples (${skillText}): ${readText}.`;
      const liveWithData = live.filter((l) => l.brierScore !== null);
      if (liveWithData.length > 0) {
        const liveSamples = liveWithData.reduce((s, l) => s + l.samples, 0);
        const liveBrier =
          liveWithData.reduce((s, l) => s + (l.brierScore ?? 0) * l.samples, 0) / liveSamples;
        const gap = liveBrier - overallBrier;
        interpretation +=
          ` Live verified predictions (${liveSamples.toLocaleString("en-IN")} samples) show a brier of ` +
          `${liveBrier.toFixed(3)} — ${
            Math.abs(gap) <= 0.01
              ? "consistent with the backtest"
              : gap > 0
                ? "somewhat worse than the backtest, as live conditions usually are"
                : "slightly better than the backtest so far, likely small-sample luck"
          }.`;
      } else {
        interpretation +=
          " Not enough verified live predictions yet (need ≥10 per horizon) for a live brier.";
      }
    }

    const updatedAt = rows[0]?.ranAt
      ? new Date(rows[0].ranAt).toISOString()
      : new Date(0).toISOString();

    return {
      backtest,
      live,
      interpretation,
      methodology:
        "Calibration is measured on the walk-forward backtest: for each of the last 60 trading days " +
        "the model stated a probability that the stock would be UP after each horizon, using only data " +
        "available at that moment. The Brier score is the average squared gap between that stated " +
        "probability and what actually happened (1 if the stock closed up, 0 otherwise) — 0 is perfect, " +
        "0.25 is what always saying 50/50 scores, and skill% = (0.25 − brier) / 0.25 × 100. The " +
        "reliability buckets group predictions by stated probability and compare the group's mean stated " +
        "probability against the observed up-frequency: on a perfectly calibrated model the two match. " +
        "The live table applies the same brier to verified PredictionLog rows — real predictions logged " +
        "in advance and checked against real later prices; horizons with fewer than 10 verified samples " +
        "report null rather than a noisy number.",
      updatedAt,
    };
  }

  // ── V6: Research brief (SPEC_CALIBRATION Module C3) ────────────────────────

  /**
   * GET /api/research/:ticker — a deterministic analyst-style brief composed
   * from ONE analyze() call. Every figure is a real value from that analysis;
   * every nullable is guarded so the text never reads "null" or "undefined".
   *
   * READ-ONLY (Phase B1 fix, upgrade-audit §4 #2): the underlying analyze()
   * runs with persist:false — no Analysis row is written and no PredictionLog
   * row is touched by this GET.
   */
  async getResearchBrief(tickerOrName: string): Promise<ResearchBrief> {
    const a = await this.analyze(tickerOrName, undefined, { persist: false });
    const sector = NSE_UNIVERSE.find((u) => u.ticker === a.ticker)?.sector ?? null;

    const fmtInr = (x: number): string =>
      `₹${x.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const sgn = (x: number, dp = 2): string => `${x >= 0 ? "+" : ""}${x.toFixed(dp)}%`;

    const t = a.analysis.technicals;
    const f = a.fundamentals;
    const mc30 = a.monteCarlo.horizons.find((h) => h.horizonDays === 30);
    const p1d = a.analysis.predictions.find((p) => p.horizonDays === 1);
    const p30d = a.analysis.predictions.find((p) => p.horizonDays === 30);

    // ── Verdict strip ──
    const verdict = {
      recommendation: a.analysis.recommendation,
      entryAction: a.entryTiming.action,
      quantScore: a.analysis.score,
      masterScore: a.framework.masterScore,
      riskLevel: a.analysis.riskLevel,
      timingScore: a.entryTiming.score,
    };

    // ── Bull / bear cases: quant reasons + framework check evidence (≤5) ──
    const checks = a.framework.phases.flatMap((ph) => ph.checks);
    const passChecks = checks
      .filter((c) => c.result === "pass")
      .map((c) => `${c.name}: ${c.value}`);
    const failChecks = checks
      .filter((c) => c.result === "fail")
      .map((c) => `${c.name}: ${c.value}`);
    const dedupe = (xs: string[]): string[] => Array.from(new Set(xs));
    const bullCase = dedupe([...a.analysis.reasons.positive, ...passChecks]).slice(0, 5);
    const bearCase = dedupe([...a.analysis.reasons.negative, ...failChecks]).slice(0, 5);

    // ── Key numbers (honest "n/a" when free data could not provide one) ──
    const keyNumbers: Array<{ label: string; value: string }> = [
      { label: "Price", value: `${fmtInr(a.quote.price)} (${sgn(a.quote.changePercent)} today)` },
      { label: "P/E (trailing)", value: f?.trailingPE != null ? f.trailingPE.toFixed(1) : "n/a" },
      { label: "PEG ratio", value: f?.pegRatio != null ? f.pegRatio.toFixed(2) : "n/a" },
      {
        label: "Revenue growth",
        value: f?.revenueGrowthPct != null ? sgn(f.revenueGrowthPct, 1) : "n/a",
      },
      { label: "Beta (1y vs NIFTY)", value: a.beta1y != null ? a.beta1y.toFixed(2) : "n/a" },
      {
        label: "Annualised volatility",
        value: t.annualVolatilityPct != null ? `${t.annualVolatilityPct.toFixed(1)}%` : "n/a",
      },
      {
        label: "52-week position",
        value: t.week52 != null ? `${t.week52.positionPct.toFixed(0)}% of range` : "n/a",
      },
      {
        label: "30d P(gain) — Monte Carlo",
        value: mc30 != null ? `${(mc30.pop * 100).toFixed(1)}%` : "n/a",
      },
      {
        label: "30d P(−20% or worse)",
        value: mc30 != null ? `${(mc30.pDown20 * 100).toFixed(1)}%` : "n/a",
      },
    ];

    // ── Forecast table: quant expectations + Monte Carlo P(gain) ──
    const forecast = a.analysis.predictions.map((p) => {
      const mcH = a.monteCarlo.horizons.find((m) => m.horizonDays === p.horizonDays);
      return {
        horizonDays: p.horizonDays as number,
        expectedPct: p.expectedReturnPct,
        low80Pct: p.low80Pct,
        high80Pct: p.high80Pct,
        // T3 fix (audit §4): NEVER substitute the engine's uncalibrated
        // normal-CDF heuristic for a missing bootstrap frequency under one
        // label — a missing scenario frequency renders as unavailable.
        pop: mcH ? mcH.pop : null,
      };
    });

    // ── Thesis: 2–3 deterministic paragraphs quoting only real values ──
    const para1Bits: string[] = [
      `${a.name} (${a.ticker}${sector ? `, ${sector}` : ""}) trades at ${fmtInr(a.quote.price)}, ` +
        `${sgn(a.quote.changePercent)} on the day.`,
      `The quant engine scores it ${a.analysis.score}/100 — ${a.analysis.recommendation} with ` +
        `${a.analysis.riskLevel} risk` +
        (a.framework.masterScore != null
          ? `, while the 8-phase framework's Master Score of ${a.framework.masterScore.toFixed(1)}/100 ` +
            `rates it ${a.framework.verdict.replace(/_/g, " ")}`
          : "") +
        `.`,
      `Entry timing currently reads ${a.entryTiming.action.replace(/_/g, " ")} with a timing score of ` +
        `${a.entryTiming.score}/100.`,
    ];

    const tape: string[] = [];
    if (t.rsi14 != null) tape.push(`a 14-day RSI of ${t.rsi14.toFixed(1)}`);
    if (t.week52 != null) {
      tape.push(
        `a price sitting at ${t.week52.positionPct.toFixed(0)}% of its 52-week range ` +
          `(${fmtInr(t.week52.low)}–${fmtInr(t.week52.high)})`
      );
    }
    if (t.annualVolatilityPct != null) {
      tape.push(`annualised volatility of ${t.annualVolatilityPct.toFixed(1)}%`);
    }
    if (a.beta1y != null) tape.push(`a 1-year beta of ${a.beta1y.toFixed(2)} against the NIFTY 50`);
    const fund: string[] = [];
    if (f?.trailingPE != null) fund.push(`a trailing P/E of ${f.trailingPE.toFixed(1)}`);
    if (f?.pegRatio != null) fund.push(`a PEG of ${f.pegRatio.toFixed(2)}`);
    if (f?.revenueGrowthPct != null) fund.push(`revenue growth of ${sgn(f.revenueGrowthPct, 1)}`);
    if (f?.returnOnEquityPct != null) fund.push(`return on equity of ${f.returnOnEquityPct.toFixed(1)}%`);
    const para2Bits: string[] = [
      tape.length > 0
        ? `On the tape the stock shows ${tape.join(", ")}.`
        : `Not enough recent price data was available to characterise the tape.`,
      fund.length > 0
        ? `Fundamentally it carries ${fund.join(", ")}.`
        : `Free fundamental data was unavailable for this run, so the brief leans on price behaviour — ` +
          `an honest gap, not a hidden one.`,
    ];

    const para3Bits: string[] = [];
    if (p30d != null) {
      para3Bits.push(
        `Over the next 30 days the model expects ${sgn(p30d.expectedReturnPct)} with an 80% band of ` +
          `${sgn(p30d.low80Pct)} to ${sgn(p30d.high80Pct)}` +
          (mc30 != null
            ? `, and the ${a.monteCarlo.paths.toLocaleString("en-IN")}-path bootstrap Monte Carlo puts ` +
              `the probability of any gain at ${(mc30.pop * 100).toFixed(1)}% with a ` +
              `${(mc30.pDown20 * 100).toFixed(1)}% chance of a 20% drawdown`
            : "") +
          `.`
      );
    } else if (mc30 != null) {
      para3Bits.push(
        `The ${a.monteCarlo.paths.toLocaleString("en-IN")}-path bootstrap Monte Carlo puts the 30-day ` +
          `probability of any gain at ${(mc30.pop * 100).toFixed(1)}% with a ` +
          `${(mc30.pDown20 * 100).toFixed(1)}% chance of a 20% drawdown.`
      );
    }
    para3Bits.push(
      a.news != null
        ? `On the news tape, sentiment reads ${a.news.sentimentScore >= 0 ? "+" : ""}${a.news.sentimentScore.toFixed(0)}` +
            `/100 with ${a.news.fresh24hCount} fresh item${a.news.fresh24hCount === 1 ? "" : "s"} in the last 24 hours ` +
            `and a hype temperature of ${a.news.hypeTemperature.toFixed(0)}/100.`
        : `The news tape is quiet for this name across the free sources, so headlines are not moving this read.`
    );
    para3Bits.push(
      `These are measured, calibrated estimates rather than promises — backtested direction accuracy sits ` +
        `close to a coin flip, so the ranges, position sizing and the stop matter more than the point forecast.`
    );

    const thesis = [para1Bits.join(" "), para2Bits.join(" "), para3Bits.join(" ")].join("\n\n");

    // ── Risks: risk level rationale, drawdown odds, band caveat, fee note ──
    const risks: string[] = [];
    risks.push(
      `${a.analysis.riskLevel} risk classification` +
        (t.annualVolatilityPct != null
          ? ` — annualised volatility of ${t.annualVolatilityPct.toFixed(1)}%` +
            (a.beta1y != null ? ` and a 1-year beta of ${a.beta1y.toFixed(2)} vs the NIFTY 50` : "")
          : "") +
        `.`
    );
    if (mc30 != null) {
      risks.push(
        `Monte Carlo downside odds over 30 days: ${(mc30.pDown10 * 100).toFixed(1)}% chance of a −10% move ` +
          `and ${(mc30.pDown20 * 100).toFixed(1)}% chance of −20% or worse.`
      );
    }
    const band7 = a.accuracy?.horizons.find((h) => h.horizonDays === 7);
    risks.push(
      band7 != null && band7.samples > 0
        ? `The 80% forecast bands are statistical ranges, not guarantees — measured 7-day band coverage for ` +
          `this stock is ${band7.withinBandPct.toFixed(1)}% (${band7.samples} samples), so outcomes outside ` +
          `the band happen regularly.`
        : `The 80% forecast bands are statistical ranges, not guarantees — roughly 1 in 5 outcomes is ` +
          `expected to land outside them by construction.`
    );
    if (p1d != null && Math.abs(p1d.expectedReturnPct) < 0.5) {
      risks.push(
        `Fee warning: the 1-day expected move (${sgn(p1d.expectedReturnPct)}) is smaller than typical ` +
          `round-trip transaction costs (brokerage + STT + impact, roughly 0.2–0.5%), so very short-horizon ` +
          `trading of this signal loses money to fees even when the direction call is right.`
      );
    }

    // ── Accuracy context: this ticker's own measured rates + honesty line ──
    let accuracyContext: string;
    if (a.accuracy != null && a.accuracy.horizons.length > 0) {
      const rate = (hd: number): string | null => {
        const h = a.accuracy!.horizons.find((x) => x.horizonDays === hd);
        return h && h.samples > 0
          ? `${hd}d ${h.directionHitRatePct.toFixed(1)}% (${h.samples} samples)`
          : null;
      };
      const rates = [rate(1), rate(7), rate(30)].filter((x): x is string => x !== null);
      const brier7 = a.accuracy.horizons.find((h) => h.horizonDays === 7)?.brierScore;
      accuracyContext =
        `Measured walk-forward hit rates for this stock (${a.accuracy.testDays} test days): ` +
        `${rates.join(", ")}` +
        (brier7 != null ? `; 7d Brier score ${brier7.toFixed(4)} vs 0.25 coin-flip` : "") +
        `. Direction accuracy near 50% is normal and honest — the value is in the calibrated ranges ` +
        `and risk discipline, not the up/down call.`;
    } else {
      accuracyContext =
        `No stored backtest exists for this ticker yet, so there are no measured hit rates to quote — ` +
        `treat every direction call here as an unproven lean and rely on the ranges and stops.`;
    }

    return {
      ticker: a.ticker,
      name: a.name,
      sector,
      generatedAt: new Date().toISOString(),
      verdict,
      thesis,
      bullCase,
      bearCase,
      keyNumbers,
      forecast,
      newsContext:
        a.news?.assessment ??
        `No fresh news flow was found for this name across the free sources — a quiet tape, so the ` +
          `analysis is driven by price action and fundamentals rather than headlines.`,
      risks,
      accuracyContext,
      disclaimer: DISCLAIMER,
    };
  }

  // ── Charts, universe, history ─────────────────────────────────────────────

  async getChart(tickerOrName: string, range: ChartRange): Promise<ChartResponse> {
    const resolved = await marketDataService.resolve(tickerOrName);
    if (!resolved) {
      throw new HttpError(
        404,
        `Could not resolve "${tickerOrName}" to an Indian (NSE/BSE) listing.`
      );
    }
    const bars = await marketDataService.getDailyBars(
      resolved.ticker,
      CHART_FETCH_RANGE[range]
    );
    if (bars.length === 0) {
      throw new HttpError(404, `No price history available for ${resolved.ticker}.`);
    }

    const cutoff = addCalendarDays(istDateString(), -CHART_WINDOW_DAYS[range]);
    let start = bars.findIndex((b) => b.date >= cutoff);
    if (start < 0) start = 0;

    const closes = bars.map((b) => b.close);
    return {
      ticker: resolved.ticker,
      range,
      bars: bars.slice(start),
      sma20: smaSeries(closes, 20).slice(start),
      sma50: smaSeries(closes, 50).slice(start),
      sma200: smaSeries(closes, 200).slice(start),
    };
  }

  /** Universe list with latest cached score/recommendation + last close. */
  async getUniverse(): Promise<UniverseStockRow[]> {
    const tickers = NSE_UNIVERSE.map((u) => u.ticker);
    const rows: Array<{
      ticker: string;
      score: string | null;
      recommendation: string | null;
      risk_level: string | null;
      analyzed_at: Date | null;
      close_price: string | null;
      price_change_percent: string | null;
    }> = await AppDataSource.query(
      `SELECT s.ticker,
              a.score, a.recommendation, a.risk_level, a.created_at AS analyzed_at,
              h.close_price, h.price_change_percent
         FROM stocks s
         LEFT JOIN LATERAL (
           SELECT score, recommendation, risk_level, created_at
             FROM analysis WHERE stock_id = s.id
            ORDER BY created_at DESC LIMIT 1
         ) a ON true
         LEFT JOIN LATERAL (
           SELECT close_price, price_change_percent
             FROM stock_history WHERE stock_id = s.id
            ORDER BY trading_date DESC, fetch_timestamp DESC LIMIT 1
         ) h ON true
        WHERE s.ticker = ANY($1)`,
      [tickers]
    );
    const byTicker = new Map(rows.map((r) => [r.ticker, r]));

    // V5: merge the latest in-memory scan snapshot (fresher AND complete —
    // every scanned stock has a score) over the DB fallback rows. This is what
    // removes the "—" score/recommendation gaps for universe stocks that were
    // scanned but never individually analyzed.
    const scanByTicker = new Map<string, ScanEntry>(
      // T3 fix (audit §10.10): respect the scan-cache TTL here exactly like
      // peekScanEntry does — an hours-old in-memory scan is not "current".
      (this.topPicksCache && Date.now() - this.topPicksBuiltAt <= TOP_PICKS_TTL_MS
        ? this.topPicksCache.entries
        : []
      ).map((e) => [e.ticker, e])
    );
    const scanAsOf = this.topPicksCache?.asOf ?? null;

    return NSE_UNIVERSE.map((u) => {
      const r = byTicker.get(u.ticker);
      const s = scanByTicker.get(u.ticker);
      if (s) {
        return {
          ticker: u.ticker,
          name: u.name,
          sector: u.sector,
          price: s.price,
          changePercent: s.changePercent,
          score: s.score,
          recommendation: s.recommendation,
          riskLevel: s.riskLevel,
          analyzedAt: scanAsOf,
          entryAction: s.entryAction,
        };
      }
      return {
        ticker: u.ticker,
        name: u.name,
        sector: u.sector,
        price: toNum(r?.close_price ?? null),
        changePercent: toNum(r?.price_change_percent ?? null),
        score: toNum(r?.score ?? null),
        recommendation: mapRecommendationOut(r?.recommendation ?? null),
        riskLevel: r?.risk_level ? r.risk_level.toUpperCase() : null,
        analyzedAt: r?.analyzed_at ? new Date(r.analyzed_at).toISOString() : null,
        entryAction: null,
      };
    });
  }

  /** Stored Analysis rows for a ticker, newest first. */
  async getHistory(
    tickerOrName: string,
    limit: number
  ): Promise<{ ticker: string; count: number; analyses: Array<Record<string, unknown>> }> {
    const resolved = await marketDataService.resolve(tickerOrName);
    if (!resolved) {
      throw new HttpError(
        404,
        `Could not resolve "${tickerOrName}" to an Indian (NSE/BSE) listing.`
      );
    }
    const stock = await AppDataSource.getRepository(Stock).findOne({
      where: { ticker: resolved.ticker },
    });
    if (!stock) return { ticker: resolved.ticker, count: 0, analyses: [] };

    const rows = await AppDataSource.getRepository(Analysis).find({
      where: { stockId: stock.id },
      order: { createdAt: "DESC" },
      take: Math.min(Math.max(limit, 1), 100),
    });
    return {
      ticker: resolved.ticker,
      count: rows.length,
      analyses: rows.map((r) => ({
        id: r.id,
        recommendation: mapRecommendationOut(r.recommendation),
        riskLevel: r.riskLevel ? r.riskLevel.toUpperCase() : null,
        score: toNum(r.score ?? null),
        currentPrice: toNum(r.currentPrice ?? null),
        rsi: toNum(r.rsi ?? null),
        priceChangePercent: toNum(r.priceChangePercent ?? null),
        summary: r.summary,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  // ── Cron hooks ─────────────────────────────────────────────────────────────

  /** 08:45 IST — refresh universe bars from Yahoo (throttled). */
  async refreshUniverseBars(): Promise<{ ok: string[]; failed: string[] }> {
    return marketDataService.seedUniverse();
  }

  /**
   * 18:30 IST — fill actual outcomes on matured PredictionLog rows using real
   * bars, then refresh ModelPerformance for the affected tickers.
   */
  async verifyMaturedPredictions(): Promise<{ verified: number; tickersRefreshed: number }> {
    const repo = AppDataSource.getRepository(PredictionLog);
    const pending = await repo
      .createQueryBuilder("p")
      .where("p.actual_return IS NULL")
      .andWhere("p.model_version = :mv", { mv: MODEL_VERSION })
      .andWhere("p.horizon_days IS NOT NULL")
      .getMany();

    const byTicker = new Map<string, PredictionLog[]>();
    for (const row of pending) {
      const list = byTicker.get(row.ticker) ?? [];
      list.push(row);
      byTicker.set(row.ticker, list);
    }

    let verified = 0;
    const refreshed: string[] = [];
    for (const [ticker, logs] of byTicker) {
      let bars: Bar[];
      try {
        // T3 fix (audit §5): a 1y window silently never-verified rows older
        // than it; 2y covers every log this system can have produced.
        bars = await marketDataService.getDailyBars(ticker, "2y");
      } catch (err) {
        console.warn(`⚠️ verify skipped ${ticker}:`, (err as Error).message);
        continue;
      }
      const indexByDate = new Map(bars.map((b, i) => [b.date, i]));
      let touched = false;

      for (const log of logs) {
        const predDate = toDateStr(log.predictionDate);
        const horizon = log.horizonDays as Horizon | undefined;
        if (!horizon || !(horizon in TRADING_DAY_OFFSETS)) continue;
        // The prediction was made on a bar date; find it (exact match).
        let idx = indexByDate.get(predDate);
        if (idx === undefined) {
          // Bar history may have been revised — use the last bar ≤ predDate.
          idx = -1;
          for (let i = bars.length - 1; i >= 0; i--) {
            if (bars[i].date <= predDate) {
              idx = i;
              break;
            }
          }
          if (idx < 0) continue;
        }
        const offset = TRADING_DAY_OFFSETS[horizon];
        const outcomeIdx = idx + offset;
        if (outcomeIdx > bars.length - 1) continue; // not matured yet

        const base = bars[idx].close;
        if (!(base > 0)) continue;
        const actual = (bars[outcomeIdx].close / base - 1) * 100;
        const predicted = toNum(log.expectedReturn) ?? 0;

        log.actualReturn = Number(actual.toFixed(4));
        log.actualDirection = actual >= 0 ? "UP" : "DOWN";
        log.predictionCorrect = isDirectionHit(predicted, actual);
        log.outcomeDate = bars[outcomeIdx].date as unknown as Date;
        await repo.save(log);
        verified++;
        touched = true;
      }

      if (touched) {
        try {
          const fullBars = await marketDataService.getDailyBars(ticker, "2y");
          if (fullBars.length >= 122) {
            // Single-engine backtest only — the V7 model-pool merge was
            // removed from production execution (upgrade-spec §2 row 6).
            const result = backtestBars(ticker, fullBars, {
              testDays: DEFAULT_BACKTEST_DAYS,
            });
            await this.upsertModelPerformance(ticker, result, fullBars);
            refreshed.push(ticker);
          }
        } catch (err) {
          console.warn(`⚠️ ModelPerformance refresh failed for ${ticker}:`, (err as Error).message);
        }
      }
    }
    return { verified, tickersRefreshed: refreshed.length };
  }

  /** Midnight — delete Analysis rows older than 365 days. NEVER touches PredictionLog/ModelPerformance. */
  async cleanupOldAnalyses(): Promise<number> {
    const result = await AppDataSource.getRepository(Analysis)
      .createQueryBuilder()
      .delete()
      .where("created_at < NOW() - INTERVAL '365 days'")
      .execute();
    return result.affected ?? 0;
  }
}

/** Shared singleton — controller and cron use the same top-picks cache. */
export const stockService = new StockService();
export default stockService;
