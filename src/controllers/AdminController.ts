/**
 * AdminController (Module V2-D) — thin HTTP handlers over AdminService.
 * Same envelope discipline as StockController: { success: true, data } on
 * success, HttpError → { success: false, error: { message } }.
 */

import { Request, Response, NextFunction } from "express";
import { adminService } from "../services/admin/AdminService";
import { executionAnalyticsService } from "../services/admin/ExecutionAnalyticsService";
import { AdminSettingsRequest, HttpError, RecordTradeRequest } from "../types";

function ok(res: Response, data: unknown): void {
  res.status(200).json({ success: true, data });
}

export class AdminController {
  /** GET /api/admin/account */
  account = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      ok(res, await adminService.getAccount());
    } catch (err) {
      next(err);
    }
  };

  /** POST /api/admin/trades  body { ticker, side, qty, price? } */
  recordTrade = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = (req.body ?? {}) as Partial<RecordTradeRequest>;
      if (!body.ticker || !body.side || body.qty === undefined) {
        throw new HttpError(
          400,
          'Body must include "ticker", "side" ("BUY"|"SELL") and "qty", e.g. ' +
            '{ "ticker": "SBIN", "side": "BUY", "qty": 5 }. "price" is optional (defaults to the live quote).'
        );
      }
      ok(res, await adminService.recordTrade(body as RecordTradeRequest));
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/admin/daily-plan */
  dailyPlan = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      ok(res, await adminService.getDailyPlan());
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/admin/prediction-audit — the validation loop: predicted vs real */
  predictionAudit = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      ok(res, await adminService.getPredictionAudit());
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/execution/summary — V9 E1 execution feedback loop (measured p/b, drift) */
  executionSummary = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      ok(res, await executionAnalyticsService.getSummary());
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/admin/forecast-locks — purchase-day forecasts, frozen and graded vs reality */
  forecastLocks = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      ok(res, await adminService.getForecastLocks());
    } catch (err) {
      next(err);
    }
  };

  /** POST /api/admin/account/settings  body { startCapital?, targetAmount?, targetDays?, confirmReset? } */
  updateSettings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = (req.body ?? {}) as AdminSettingsRequest;
      ok(res, await adminService.updateSettings(body));
    } catch (err) {
      next(err);
    }
  };
}

export default AdminController;
