/**
 * HoldingsController — thin HTTP handler over HoldingsService (stateless
 * "what profit can I book" calculator). Same envelope discipline as the
 * other controllers: { success: true, data } / HttpError → { success: false }.
 */

import { Request, Response, NextFunction } from "express";
import { holdingsService } from "../services/holdings/HoldingsService";
import { HoldingCalcRequest } from "../types";

function ok(res: Response, data: unknown): void {
  res.status(200).json({ success: true, data });
}

export class HoldingsController {
  /** POST /api/holdings/calculate  body { ticker, buyPrice?|buyDate?, quantity?|amount? } */
  calculate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = (req.body ?? {}) as Partial<HoldingCalcRequest>;
      ok(res, await holdingsService.calculate(body as HoldingCalcRequest));
    } catch (err) {
      next(err);
    }
  };
}

export default HoldingsController;
