/**
 * QuantController — thin HTTP handlers for the surviving V8 endpoints:
 *   GET /api/rank/universe
 *   GET /api/volatility/forecast/:ticker
 * Same envelope conventions as StockController ({ success: true, data }).
 *
 * REMOVED in the v2 upgrade (upgrade-audit §3 rows 1/9): the options-skew
 * radar (permanently Akamai-blocked) and consumer Kelly position sizing.
 */

import { Request, Response, NextFunction } from "express";
import { rankService } from "../services/RankService";
import { volatilityService } from "../services/VolatilityService";
import { HttpError } from "../types";

function ok(res: Response, data: unknown): void {
  res.status(200).json({ success: true, data });
}

function requireTicker(req: Request): string {
  const ticker = (req.params.ticker ?? "").trim();
  if (!ticker) throw new HttpError(400, "A ticker is required in the path.");
  if (ticker.length > 60) throw new HttpError(400, "Ticker is too long (max 60 characters).");
  return ticker;
}

export class QuantController {
  /** GET /api/rank/universe — cross-sectional relative-strength ranking */
  rankUniverse = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      ok(res, await rankService.getRankUniverse());
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/volatility/forecast/:ticker — HAR-RV daily-proxy forecast */
  volatilityForecast = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      ok(res, await volatilityService.getForecast(requireTicker(req)));
    } catch (err) {
      next(err);
    }
  };
}

export default QuantController;
