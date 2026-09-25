/**
 * EvidenceController — the read-only transparency surface.
 *
 *   GET /api/evidence            — everything the Evidence tab renders
 *   GET /api/evidence/predictions?limit=  — the raw ledger, wrong calls first
 *   GET /api/evidence/calibrators         — promotions AND rejections
 *   GET /api/evidence/governance          — model states + the reasons for them
 *   GET /api/evidence/experiments         — runs, including failed ones
 *
 * All GETs, all unauthenticated: this is the page that argues against the
 * system's own output, so it must be as easy to reach as the recommendations.
 */

import { NextFunction, Request, Response } from "express";
import { evidenceService } from "../services/evidence/EvidenceService";

function ok(res: Response, data: unknown): void {
  res.status(200).json({ success: true, data });
}

function limitOf(req: Request, fallback: number): number {
  const raw = Number(req.query.limit);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export class EvidenceController {
  bundle = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      ok(res, await evidenceService.bundle(limitOf(req, 200)));
    } catch (err) {
      next(err);
    }
  };

  predictions = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Optional filters: ?grade=WRONG|CORRECT|PENDING and ?ticker=HUDCO.
      // An unknown grade value is ignored (unfiltered), never an error.
      const gradeRaw = String(req.query.grade ?? "").toUpperCase();
      const grade = gradeRaw === "WRONG" || gradeRaw === "CORRECT" || gradeRaw === "PENDING" ? gradeRaw : undefined;
      const tickerRaw = String(req.query.ticker ?? "").trim();
      const ticker = tickerRaw.length > 0 ? tickerRaw.slice(0, 30) : undefined;
      ok(res, await evidenceService.predictions(limitOf(req, 200), { grade, ticker }));
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/evidence/selectivity — accuracy vs abstention, measured. */
  selectivity = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      ok(res, await evidenceService.selectivity());
    } catch (err) {
      next(err);
    }
  };

  calibrators = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      ok(res, { calibrators: await evidenceService.calibrators(limitOf(req, 200)) });
    } catch (err) {
      next(err);
    }
  };

  governance = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      ok(res, { governance: await evidenceService.governance() });
    } catch (err) {
      next(err);
    }
  };

  experiments = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      ok(res, { experiments: await evidenceService.experiments(limitOf(req, 50)) });
    } catch (err) {
      next(err);
    }
  };
}
