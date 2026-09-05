/**
 * V8 QuantController — thin HTTP handlers for the R1–R4 endpoints:
 *   GET /api/rank/universe
 *   GET /api/volatility/forecast/:ticker
 *   GET /api/options/skew/:ticker
 *   GET /api/position-size/:ticker?capital=100000
 * Same envelope conventions as StockController ({ success: true, data }).
 */

import { Request, Response, NextFunction } from "express";
import { rankService } from "../services/RankService";
import { volatilityService } from "../services/VolatilityService";
import { optionsRadar } from "../services/market/OptionsRadar";
import { positionSizeService } from "../services/PositionSizeService";
import { HttpError } from "../types";

const CAPITAL_DEFAULT = 100_000;
const CAPITAL_MIN = 100;
const CAPITAL_MAX = 100_000_000;

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

  /** GET /api/options/skew/:ticker — NSE option-chain radar (probe-first) */
  optionsSkew = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      ok(res, await optionsRadar.getSkew(requireTicker(req)));
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/position-size/:ticker?capital=100000 — half-Kelly sizing */
  positionSize = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ticker = requireTicker(req);
      let capital = CAPITAL_DEFAULT;
      if (req.query.capital !== undefined) {
        const n = Number(req.query.capital);
        if (!Number.isFinite(n) || n < CAPITAL_MIN || n > CAPITAL_MAX) {
          throw new HttpError(
            400,
            `"capital" must be a number between ₹${CAPITAL_MIN.toLocaleString("en-IN")} and ` +
              `₹${CAPITAL_MAX.toLocaleString("en-IN")}.`
          );
        }
        capital = n;
      }
      ok(res, await positionSizeService.getPositionSize(ticker, capital));
    } catch (err) {
      next(err);
    }
  };
}

export default QuantController;
