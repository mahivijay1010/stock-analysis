/**
 * StockController — thin HTTP handlers over the StockService orchestrator.
 * Every success response is wrapped { success: true, data }, and every
 * validation failure throws HttpError(400, ...) for the error middleware
 * to wrap as { success: false, error: { message } }.
 */

import { Request, Response, NextFunction } from "express";
import { stockService } from "../services/StockService";
import { AnalyzeRequest, ChartRange, HttpError } from "../types";

const CHART_RANGES: ChartRange[] = ["7d", "15d", "1mo", "3mo", "6mo", "1y", "5y"];
const AMOUNT_MIN = 100; // ₹100
const AMOUNT_MAX = 100_000_000; // ₹10,00,00,000 (10 crore)

function ok(res: Response, data: unknown): void {
  res.status(200).json({ success: true, data });
}

function parseIntOr(value: unknown, fallback: number): number {
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

export class StockController {
  /** GET /api/search?q= */
  search = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      if (!q) {
        throw new HttpError(400, 'Query parameter "q" is required, e.g. /api/search?q=tata');
      }
      ok(res, await stockService.search(q));
    } catch (err) {
      next(err);
    }
  };

  /** POST /api/analyze  body { ticker, amount? } (symbol or company name; ₹ amount 100..10,00,00,000) */
  analyze = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { ticker, amount } = (req.body ?? {}) as Partial<AnalyzeRequest>;
      if (!ticker || typeof ticker !== "string" || !ticker.trim()) {
        throw new HttpError(400, '"ticker" is required in the request body, e.g. { "ticker": "RELIANCE" }');
      }
      if (ticker.trim().length > 60) {
        throw new HttpError(400, '"ticker" is too long (max 60 characters).');
      }
      let parsedAmount: number | undefined;
      if (amount !== undefined && amount !== null) {
        const n = typeof amount === "number" ? amount : Number(amount);
        if (!Number.isFinite(n) || n < AMOUNT_MIN || n > AMOUNT_MAX) {
          throw new HttpError(
            400,
            `"amount" must be a number between ₹${AMOUNT_MIN.toLocaleString("en-IN")} and ` +
              `₹${AMOUNT_MAX.toLocaleString("en-IN")} (got ${JSON.stringify(amount)}).`
          );
        }
        parsedAmount = n;
      }
      ok(res, await stockService.analyze(ticker.trim(), parsedAmount));
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/top-picks?count=5&maxPrice=500 — maxPrice = ₹ budget per share (optional) */
  topPicks = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const count = Math.min(Math.max(parseIntOr(req.query.count, 5), 1), 20);
      let maxPrice: number | undefined;
      if (req.query.maxPrice !== undefined) {
        const n = Number(req.query.maxPrice);
        if (!Number.isFinite(n) || n < 1 || n > 10_000_000) {
          throw new HttpError(400, '"maxPrice" must be a number between ₹1 and ₹1,00,00,000.');
        }
        maxPrice = n;
      }
      ok(res, await stockService.getTopPicks(count, maxPrice));
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/backtest/:ticker?days=60 */
  backtest = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const days = parseIntOr(req.query.days, 60);
      ok(res, await stockService.runBacktest(req.params.ticker, days));
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/accuracy */
  accuracy = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      ok(res, await stockService.getAccuracy());
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/calibration — brier scores + reliability buckets (V6) */
  calibration = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      ok(res, await stockService.getCalibration());
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/research/:ticker — deterministic research brief (V6) */
  research = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ticker = (req.params.ticker ?? "").trim();
      if (!ticker) {
        throw new HttpError(400, 'A ticker is required, e.g. /api/research/RELIANCE.NS');
      }
      if (ticker.length > 60) {
        throw new HttpError(400, "Ticker is too long (max 60 characters).");
      }
      ok(res, await stockService.getResearchBrief(ticker));
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/stocks/:ticker/chart?range=1mo|3mo|6mo|1y|5y (default 1y) */
  chart = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const raw = typeof req.query.range === "string" ? req.query.range : "1y";
      if (!CHART_RANGES.includes(raw as ChartRange)) {
        throw new HttpError(400, `Invalid range "${raw}". Use one of: ${CHART_RANGES.join(", ")}`);
      }
      ok(res, await stockService.getChart(req.params.ticker, raw as ChartRange));
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/stocks — universe list (bare array per REBUILD_SPEC; the
   *  {count, stocks} wrapper is only for the legacy /api/stocks/popular alias) */
  stocks = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      ok(res, await stockService.getUniverse());
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/stocks/:ticker/history?limit=20 — stored Analysis rows */
  history = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const limit = parseIntOr(req.query.limit, 20);
      ok(res, await stockService.getHistory(req.params.ticker, limit));
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/stocks/popular — legacy alias mapped from top picks */
  popular = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const limit = Math.min(Math.max(parseIntOr(req.query.limit, 5), 1), 20);
      const topPicks = await stockService.getTopPicks(limit);
      const stocks = topPicks.picks.map((p) => ({
        ticker: p.ticker,
        name: p.name,
        sector: p.sector,
        currentPrice: p.price,
        priceChangePercent: p.changePercent,
        score: p.score,
        recommendation: p.recommendation,
        riskLevel: p.riskLevel,
        reasons: p.topReasons,
      }));
      ok(res, { count: stocks.length, asOf: topPicks.asOf, stocks });
    } catch (err) {
      next(err);
    }
  };
}

export default StockController;
