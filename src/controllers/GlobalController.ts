/**
 * GlobalController — Global Market Intelligence HTTP surface.
 *   GET  /api/global/pulse           latest immutable snapshot (regime, regions, transmission, sectors, events, freshness)
 *   POST /api/global/snapshot        (auth) build a new snapshot now
 *   GET  /api/global/studies         shock studies + sector sensitivities (displayable flag, n)
 *   POST /api/global/run-studies     (auth) recompute studies (registers an experiment run)
 *   GET  /api/global/track-record    regime × NIFTY/sector forward returns × setup performance
 *   POST /api/global/backfill        (auth) backfill daily regimes
 *   GET  /api/global/events          upcoming scheduled events
 */
import { NextFunction, Request, Response } from "express";

function ok(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ success: true, data });
}

export class GlobalController {
  pulse = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { globalIntelligenceService } = await import("../services/global/GlobalIntelligenceService");
      const s = await globalIntelligenceService.latest();
      ok(res, s ?? { empty: true, note: "no global snapshot yet" });
    } catch (err) {
      next(err);
    }
  };
  snapshot = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { globalIntelligenceService } = await import("../services/global/GlobalIntelligenceService");
      ok(res, await globalIntelligenceService.snapshot({ persist: true }), 201);
    } catch (err) {
      next(err);
    }
  };
  studies = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { globalIntelligenceService } = await import("../services/global/GlobalIntelligenceService");
      const { MIN_SHOCK_N, SHOCKS } = await import("../services/global/globalRelationships");
      ok(res, { shocks: SHOCKS, minN: MIN_SHOCK_N, studies: await globalIntelligenceService.latestStudies(), sensitivities: await globalIntelligenceService.latestSensitivities(), caveat: "Empirical, point-in-time (global sessions usable only after they closed before India's close). Displayed only at n ≥ 20 (shocks) / ≥ 20 blocks (sensitivities). Evidence, not rules." });
    } catch (err) {
      next(err);
    }
  };
  runStudies = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { globalIntelligenceService } = await import("../services/global/GlobalIntelligenceService");
      ok(res, await globalIntelligenceService.runStudies(), 201);
    } catch (err) {
      next(err);
    }
  };
  trackRecord = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { globalIntelligenceService } = await import("../services/global/GlobalIntelligenceService");
      ok(res, await globalIntelligenceService.regimeTrackRecordCached());
    } catch (err) {
      next(err);
    }
  };
  backfill = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { globalIntelligenceService } = await import("../services/global/GlobalIntelligenceService");
      ok(res, await globalIntelligenceService.backfillRegimeDays(Number(req.query.days) || 500), 201);
    } catch (err) {
      next(err);
    }
  };
  indiaPulse = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { indiaMarketService } = await import("../services/global/IndiaMarketService");
      const diagnosis = await indiaMarketService.diagnose({ persist: true });
      ok(res, { diagnosis, history: await indiaMarketService.history(90), note: "Diagnostic context from closed sessions only. The authoritative gate input remains the short-term RegimeService; this never sizes a position by itself. FII/DII flows have no configured source and are reported as uncovered." });
    } catch (err) {
      next(err);
    }
  };
  indiaBackfill = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { indiaMarketService } = await import("../services/global/IndiaMarketService");
      ok(res, await indiaMarketService.backfill(Number(req.query.days) || 120), 201);
    } catch (err) {
      next(err);
    }
  };

  sectors = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { sectorIntelligenceService } = await import("../services/global/SectorIntelligenceService");
      const { INDIA_SECTOR_PROXIES } = await import("../services/global/globalUniverse");
      const regimes = await sectorIntelligenceService.diagnose({ persist: true });
      const history = await sectorIntelligenceService.history(60);
      ok(res, {
        regimes,
        history: Object.fromEntries([...history.entries()]),
        proxies: INDIA_SECTOR_PROXIES,
        note: "Sector states are diagnostic (equal-weight proxies from exchange closes, tier A/B constituents). The Money Desk shows them as context; they never veto a setup.",
      });
    } catch (err) {
      next(err);
    }
  };
  sectorsBackfill = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { sectorIntelligenceService } = await import("../services/global/SectorIntelligenceService");
      ok(res, await sectorIntelligenceService.backfill(Number(req.query.days) || 120), 201);
    } catch (err) {
      next(err);
    }
  };

  events = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { globalIntelligenceService } = await import("../services/global/GlobalIntelligenceService");
      await globalIntelligenceService.seedEvents();
      ok(res, { events: await globalIntelligenceService.upcomingEvents(new Date()) });
    } catch (err) {
      next(err);
    }
  };
}
