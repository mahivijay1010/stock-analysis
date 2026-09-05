/**
 * PortfolioController — thin HTTP handler over PortfolioService.
 * Public (non-admin) multi-stock allocation suggestions for any ₹ amount.
 */

import { Request, Response, NextFunction } from "express";
import { isPortfolioStrategy, portfolioService } from "../services/portfolio/PortfolioService";
import { DISCLAIMER, HttpError, PortfolioSuggestResponse } from "../types";

const AMOUNT_MIN = 100;
const AMOUNT_MAX = 100_000_000; // ₹10 crore

export class PortfolioController {
  /** POST /api/portfolio/suggest  body { amount, strategy? = "balanced" } */
  suggest = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const raw = (req.body ?? {}) as { amount?: unknown; strategy?: unknown };
      const amount = typeof raw.amount === "number" ? raw.amount : Number(raw.amount);
      if (!Number.isFinite(amount) || amount < AMOUNT_MIN || amount > AMOUNT_MAX) {
        throw new HttpError(
          400,
          `"amount" must be a number between ₹${AMOUNT_MIN.toLocaleString("en-IN")} and ₹${AMOUNT_MAX.toLocaleString("en-IN")}.`
        );
      }
      const strategy = raw.strategy === undefined ? "balanced" : raw.strategy;
      if (!isPortfolioStrategy(strategy)) {
        throw new HttpError(400, '"strategy" must be "short-term", "long-term" or "balanced".');
      }
      const { allocation, reason } = await portfolioService.suggest(amount, strategy);
      const data: PortfolioSuggestResponse = {
        amount,
        strategy,
        allocation,
        disclaimer: DISCLAIMER,
      };
      if (reason) data.reason = reason;
      res.status(200).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/portfolio/stress?tickers=A,B&weights=60,40 (V7 A4)
   * Without tickers: stresses the admin desk's open positions.
   */
  stress = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { tickers, weights } = parsePortfolioQuery(req);
      const data = await portfolioService.stress(tickers, weights);
      res.status(200).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/portfolio/calibration?tickers=A,B&weights=60,40 (V7 A4) */
  calibration = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { tickers, weights } = parsePortfolioQuery(req);
      const data = await portfolioService.calibrationFor(tickers, weights);
      res.status(200).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  };
}

/** Shared query parsing for the V7 portfolio endpoints. */
function parsePortfolioQuery(req: Request): {
  tickers?: string[];
  weights?: number[];
} {
  let tickers: string[] | undefined;
  if (typeof req.query.tickers === "string" && req.query.tickers.trim()) {
    tickers = req.query.tickers
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (tickers.length === 0) tickers = undefined;
  }
  let weights: number[] | undefined;
  if (typeof req.query.weights === "string" && req.query.weights.trim()) {
    weights = req.query.weights.split(",").map((w) => Number(w.trim()));
    if (weights.some((w) => !Number.isFinite(w) || w <= 0)) {
      throw new HttpError(400, '"weights" must be positive numbers, e.g. weights=60,40');
    }
    if (!tickers) {
      throw new HttpError(400, '"weights" requires "tickers" to be given too.');
    }
  }
  return { tickers, weights };
}

export default PortfolioController;
