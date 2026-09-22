/**
 * LiveFeedController — HTTP surface for the real-time market feed.
 *
 *   GET  /api/live/status  — is the feed running, how healthy, how fresh
 *   GET  /api/live/rows    — per-ticker live monitoring rows
 *   POST /api/live/start   — resolve the universe + open the stream (auth)
 *   POST /api/live/stop    — close the stream (auth)
 *
 * start/stop are authenticated POSTs because they open a broker connection and
 * consume the daily token; status/rows are reads. Nothing here publishes a
 * decision — see LiveFeedService for why a real-time feed raises the data mode
 * but not the evidence bar.
 */

import { NextFunction, Request, Response } from "express";
import { liveFeedService } from "../services/realtime/LiveFeedService";
import { intradayForecastService } from "../services/realtime/IntradayForecastService";

function ok(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ success: true, data });
}

export class LiveFeedController {
  status = (_req: Request, res: Response, next: NextFunction): void => {
    try {
      ok(res, liveFeedService.status());
    } catch (err) {
      next(err);
    }
  };

  rows = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const rows = await liveFeedService.rows();
      ok(res, { rows, status: liveFeedService.status() });
    } catch (err) {
      next(err);
    }
  };

  /**
   * Live 1m/5m forecasts with the measured scorecard beside them.
   *
   * The scorecard is returned in the SAME payload as the forecasts, not on a
   * separate endpoint, so no client can render the calls without the evidence
   * about how those calls have actually been doing.
   */
  forecasts = (_req: Request, res: Response, next: NextFunction): void => {
    try {
      ok(res, {
        ...intradayForecastService.snapshot(),
        recentGraded: intradayForecastService.recentGraded(40),
        feedRunning: liveFeedService.isRunning(),
      });
    } catch (err) {
      next(err);
    }
  };

  start = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = (req.body ?? {}) as { tickers?: unknown };
      const tickers = Array.isArray(body.tickers) ? body.tickers.filter((t): t is string => typeof t === "string") : undefined;
      ok(res, await liveFeedService.start(tickers), 201);
    } catch (err) {
      next(err);
    }
  };

  stop = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      ok(res, await liveFeedService.stop());
    } catch (err) {
      next(err);
    }
  };
}
