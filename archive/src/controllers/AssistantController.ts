/**
 * AssistantController — thin HTTP handler over the stock-only assistant.
 */

import { Request, Response, NextFunction } from "express";
import { assistantService } from "../services/assistant/AssistantService";
import { HttpError } from "../types";

export class AssistantController {
  /** POST /api/assistant  body { message } */
  ask = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = (req.body ?? {}) as { message?: unknown };
      if (typeof body.message !== "string" || !body.message.trim()) {
        throw new HttpError(400, '"message" is required, e.g. { "message": "should I buy TCS?" }');
      }
      res.status(200).json({ success: true, data: await assistantService.answer(body.message) });
    } catch (err) {
      next(err);
    }
  };
}

export default AssistantController;
