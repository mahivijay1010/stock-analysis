/**
 * PortfolioController — thin HTTP handlers over the KEPT PortfolioService
 * risk endpoints (stress + calibration).
 *
 * REMOVED in the v2 upgrade (upgrade-spec §2 row 5): POST /api/portfolio/suggest
 * — the multi-stock allocation builder is out of the product; the reusable
 * risk calculations (stress, calibration) stay.
 */

import { Request, Response, NextFunction } from "express";
import { portfolioService } from "../services/portfolio/PortfolioService";
import { HttpError } from "../types";

export class PortfolioController {
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
