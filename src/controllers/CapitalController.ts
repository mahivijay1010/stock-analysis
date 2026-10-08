/**
 * CapitalController — Money Desk HTTP surface.
 *   GET  /api/capital/today?capital=&profile=&horizon=&maxPositions=   (auth) persists an immutable plan
 *   POST /api/capital/simulate {capital, profile, horizon, maxPositions} (auth) same engine, nothing persisted
 *   GET  /api/capital/track-record                                     (public) withheld below 10 outcomes
 *   GET  /api/capital/history                                          (auth) past plans (immutable)
 *   GET  /api/capital/settings | PUT                                   (auth) desk defaults (capital, profile, horizon)
 *   POST /api/capital/grade                                            (auth) grade matured recommendations now
 *   GET  /api/model-lab                                                (public) read-only registry view
 *   GET  /api/model-lab/learning?ai=1                                  (public) Learning Analyst report
 * Every plan response carries the freshness contract; it never claims LIVE when delayed.
 */

import { NextFunction, Request, Response } from "express";
import { AppDataSource } from "../config/database";
import { ShortTermPreference } from "../entities";
import { HttpError } from "../types";
import { isRiskProfileName } from "../services/capital/riskProfiles";
import { CapitalHorizon, RiskProfileName } from "../services/capital/types";

function ok(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ success: true, data });
}

export interface DeskSettings {
  capitalAvailableInr: number;
  riskProfile: RiskProfileName;
  horizon: CapitalHorizon;
  maxPositions: number | null;
  dailySnapshot: boolean;
}
export const DEFAULT_DESK_SETTINGS: DeskSettings = { capitalAvailableInr: 20000, riskProfile: "BALANCED", horizon: "5-10d", maxPositions: null, dailySnapshot: true };

function parseHorizon(v: unknown): CapitalHorizon {
  return v === "3-5d" || v === "10-21d" ? v : "5-10d";
}
function parseCapital(v: unknown, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) throw new HttpError(400, "capital must be ≥ 0");
  return Math.min(n, 1e9);
}
function parseMax(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : undefined;
}

export async function loadDeskSettings(accountId: string): Promise<DeskSettings> {
  const row = await AppDataSource.getRepository(ShortTermPreference).findOne({ where: { accountId } });
  const raw = (row?.prefs?.capitalDesk ?? {}) as Partial<DeskSettings>;
  return {
    capitalAvailableInr: Number.isFinite(Number(raw.capitalAvailableInr)) ? Number(raw.capitalAvailableInr) : DEFAULT_DESK_SETTINGS.capitalAvailableInr,
    riskProfile: isRiskProfileName(raw.riskProfile) ? raw.riskProfile : DEFAULT_DESK_SETTINGS.riskProfile,
    horizon: parseHorizon(raw.horizon),
    maxPositions: raw.maxPositions != null && Number.isFinite(Number(raw.maxPositions)) ? Number(raw.maxPositions) : null,
    dailySnapshot: raw.dailySnapshot !== false,
  };
}

export class CapitalController {
  private async deskRequest(req: Request, source: Record<string, unknown>, persist: boolean) {
    const accountId = req.account!.accountId;
    const saved = await loadDeskSettings(accountId);
    const profileRaw = source.profile ?? source.riskProfile;
    return {
      accountId,
      capitalAvailableInr: parseCapital(source.capital ?? source.capitalAvailableInr, saved.capitalAvailableInr),
      riskProfile: isRiskProfileName(profileRaw) ? profileRaw : saved.riskProfile,
      horizon: source.horizon != null ? parseHorizon(source.horizon) : saved.horizon,
      maxPositions: parseMax(source.maxPositions) ?? saved.maxPositions ?? undefined,
      persist,
    };
  }

  today = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { capitalAllocationService } = await import("../services/capital/CapitalAllocationService");
      const r = await this.deskRequest(req, req.query as Record<string, unknown>, true);
      ok(res, await capitalAllocationService.plan(r));
    } catch (err) {
      next(err);
    }
  };

  simulate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { capitalAllocationService } = await import("../services/capital/CapitalAllocationService");
      const r = await this.deskRequest(req, (req.body ?? {}) as Record<string, unknown>, false);
      ok(res, { ...(await capitalAllocationService.plan(r)), scenarioNote: "SCENARIO — recomputed from the same evidence with your inputs; not persisted, not a prediction." });
    } catch (err) {
      next(err);
    }
  };

  history = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { capitalAllocationService } = await import("../services/capital/CapitalAllocationService");
      ok(res, { plans: await capitalAllocationService.history(req.account!.accountId, Number(req.query.limit) || 20) });
    } catch (err) {
      next(err);
    }
  };

  trackRecord = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { capitalOutcomeService } = await import("../services/capital/CapitalOutcomeService");
      ok(res, await capitalOutcomeService.trackRecord());
    } catch (err) {
      next(err);
    }
  };

  grade = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { capitalOutcomeService } = await import("../services/capital/CapitalOutcomeService");
      ok(res, await capitalOutcomeService.gradeMatured());
    } catch (err) {
      next(err);
    }
  };

  getSettings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      ok(res, await loadDeskSettings(req.account!.accountId));
    } catch (err) {
      next(err);
    }
  };

  putSettings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const accountId = req.account!.accountId;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const current = await loadDeskSettings(accountId);
      const next_: DeskSettings = {
        capitalAvailableInr: parseCapital(body.capitalAvailableInr, current.capitalAvailableInr),
        riskProfile: isRiskProfileName(body.riskProfile) ? body.riskProfile : current.riskProfile,
        horizon: body.horizon != null ? parseHorizon(body.horizon) : current.horizon,
        maxPositions: body.maxPositions === null ? null : (parseMax(body.maxPositions) ?? current.maxPositions),
        dailySnapshot: typeof body.dailySnapshot === "boolean" ? body.dailySnapshot : current.dailySnapshot,
      };
      const repo = AppDataSource.getRepository(ShortTermPreference);
      const existing = await repo.findOne({ where: { accountId } });
      if (existing) {
        existing.prefs = { ...existing.prefs, capitalDesk: next_ };
        existing.updatedAt = new Date();
        await repo.save(existing);
      } else await repo.save(repo.create({ accountId, prefs: { capitalDesk: next_ } }));
      ok(res, next_);
    } catch (err) {
      next(err);
    }
  };

  modelLab = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { modelLabService } = await import("../services/capital/ModelLabService");
      ok(res, await modelLabService.view());
    } catch (err) {
      next(err);
    }
  };

  learning = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { learningAnalystService } = await import("../services/capital/LearningAnalystService");
      ok(res, await learningAnalystService.report({ useAi: req.query.ai === "1" }));
    } catch (err) {
      next(err);
    }
  };
}
