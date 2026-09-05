import { NextFunction, Request, Response } from "express";
import { intelligenceService } from "../services/intelligence/IntelligenceService";
import { CorrelationWindow, PortfolioAnalyticsPosition } from "../services/intelligence/portfolioAnalytics";
import { HttpError } from "../types";
import { SOURCE_REGISTRY } from "../services/intelligence/sourceRegistry";

function ok(res: Response, data: unknown): void { res.status(200).json({ success: true, data }); }
function ticker(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9&.-]{1,20}$/.test(value.trim())) throw new HttpError(400, "A valid ticker is required.");
  return value.trim();
}

export class IntelligenceController {
  registry = async (_req: Request, res: Response): Promise<void> => { ok(res, SOURCE_REGISTRY); };
  refresh = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = req.body ?? {};
      if (body.irPageUrl != null && (typeof body.irPageUrl !== "string" || !body.irPageUrl.startsWith("https://")))
        throw new HttpError(400, "irPageUrl must be an official HTTPS investor-relations page.");
      ok(res, await intelligenceService.refreshTicker(ticker(req.params.ticker), {
        years: Number.isFinite(Number(body.years)) ? Number(body.years) : undefined,
        bseCode: typeof body.bseCode === "string" ? body.bseCode : undefined,
        irPageUrl: body.irPageUrl,
      }));
    } catch (error) { next(error); }
  };

  get = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try { ok(res, await intelligenceService.readTicker(ticker(req.params.ticker))); } catch (error) { next(error); }
  };

  refreshMacro = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try { ok(res, await intelligenceService.refreshMacro()); } catch (error) { next(error); }
  };

  macro = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try { ok(res, await intelligenceService.readMacro()); } catch (error) { next(error); }
  };

  portfolio = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const positions = req.body?.positions as PortfolioAnalyticsPosition[];
      if (!Array.isArray(positions) || positions.length < 1 || positions.length > 50) throw new HttpError(400, "positions must contain 1 to 50 holdings.");
      for (const position of positions) {
        if (!position || typeof position.ticker !== "string" || ![position.quantity, position.averagePrice, position.currentPrice].every(Number.isFinite))
          throw new HttpError(400, "Each position requires ticker, quantity, averagePrice and currentPrice numbers.");
      }
      const allowed: CorrelationWindow[] = ["30D", "90D", "1Y", "3Y", "5Y"];
      const requested = Array.isArray(req.body.windows) ? req.body.windows.filter((x: unknown): x is CorrelationWindow => allowed.includes(x as CorrelationWindow)) : undefined;
      ok(res, await intelligenceService.portfolio(positions, requested?.length ? requested : undefined));
    } catch (error) { next(error); }
  };
}
