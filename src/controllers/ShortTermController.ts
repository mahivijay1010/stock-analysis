/**
 * ShortTermController (S1/S7/S11) — HTTP surface for the Trade Radar.
 * GETs read stored scans; running a scan or AI review is an authenticated POST.
 */

import { NextFunction, Request, Response } from "express";
import { AppDataSource } from "../config/database";
import { ShortTermAlert, ShortTermCandidate, ShortTermPreference, ShortTermScanRun, ShortTermTransition } from "../entities";
import { shortTermScanService } from "../services/shortterm/ScanService";
import { shortTermTradeAnalyst, aiCostGovernor } from "../services/shortterm/aiAnalyst";
import { ShortTermCandidateView, DEFAULT_SCAN_PARAMS, ScanParams } from "../services/shortterm/types";
import { HttpError } from "../types";

function ok(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ success: true, data });
}

function parseParams(src: Record<string, unknown>): Partial<ScanParams> {
  const num = (v: unknown): number | null => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    budgetInr: num(src.budgetInr),
    priceMin: num(src.priceMin),
    priceMax: num(src.priceMax),
    horizon: (["1-3d", "3-5d", "5-10d", "10-21d"] as const).includes(src.horizon as never) ? (src.horizon as ScanParams["horizon"]) : undefined,
    riskPerTradePct: num(src.riskPerTradePct) ?? undefined,
    strategy: (["ALL", "PULLBACK", "BREAKOUT", "MOMENTUM", "MEAN_REVERSION"] as const).includes(src.strategy as never)
      ? (src.strategy as ScanParams["strategy"])
      : undefined,
    sector: typeof src.sector === "string" && src.sector && src.sector !== "ALL" ? src.sector : null,
    minAdvInr: num(src.minAdvInr),
    aiDepth: (["AUTO", "LOCAL_ONLY", "LOW_COST", "DEEP_REVIEW"] as const).includes(src.aiDepth as never) ? (src.aiDepth as ScanParams["aiDepth"]) : undefined,
    limit: num(src.limit) ?? undefined,
  };
}

export class ShortTermController {
  /** POST /api/short-term/scan — run a scan with the user's parameters (auth). */
  scan = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      ok(res, await shortTermScanService.scan(parseParams((req.body ?? {}) as Record<string, unknown>)), 201);
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/short-term/latest — most recent stored scan + its candidates (no recompute). */
  latest = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const run = await AppDataSource.getRepository(ShortTermScanRun).findOne({ where: {}, order: { createdAt: "DESC" } });
      if (!run) {
        ok(res, { available: false, reason: "No scan has been run yet. POST /api/short-term/scan to run one." });
        return;
      }
      const rows = await AppDataSource.getRepository(ShortTermCandidate).find({ where: { scanRunId: run.id }, order: { rank: "ASC" } });
      ok(res, {
        available: true,
        run,
        candidates: rows.filter((r) => r.passedGates).map((r) => r.payload),
        watchlist: rows.filter((r) => !r.passedGates).map((r) => ({ ticker: r.ticker, state: r.state, action: r.action, setupType: r.setupType })),
        emptyMessage: rows.filter((r) => r.passedGates).length === 0 ? "No statistically attractive short-term setups currently pass the risk and evidence gates." : null,
      });
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/short-term/:ticker — the ticker's latest candidate row + transitions + alerts. */
  detail = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const t = req.params.ticker.trim().toUpperCase();
      const yt = /\.(NS|BO)$/.test(t) ? t : `${t}.NS`;
      const cand = await AppDataSource.getRepository(ShortTermCandidate)
        .createQueryBuilder("c")
        .where("c.ticker = :yt", { yt })
        .orderBy("c.created_at", "DESC")
        .getOne();
      if (!cand) throw new HttpError(404, `${yt} has no short-term evaluation yet — run a scan first.`);
      const transitions = await AppDataSource.getRepository(ShortTermTransition).find({
        where: { ticker: yt },
        order: { createdAt: "DESC" },
        take: 30,
      });
      ok(res, { candidate: cand.payload, state: cand.state, evaluatedAt: cand.createdAt.toISOString(), transitions });
    } catch (err) {
      next(err);
    }
  };

  /** POST /api/short-term/:ticker/review — AI review at the requested depth (auth; budget-governed). */
  review = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const t = req.params.ticker.trim().toUpperCase();
      const yt = /\.(NS|BO)$/.test(t) ? t : `${t}.NS`;
      const cand = await AppDataSource.getRepository(ShortTermCandidate)
        .createQueryBuilder("c")
        .where("c.ticker = :yt", { yt })
        .orderBy("c.created_at", "DESC")
        .getOne();
      if (!cand) throw new HttpError(404, `${yt} has no short-term evaluation yet — run a scan first.`);
      const body = (req.body ?? {}) as { depth?: "AUTO" | "LOCAL_ONLY" | "LOW_COST" | "DEEP_REVIEW"; question?: string; budgetInr?: number; riskPerTradePct?: number };
      const review = await shortTermTradeAnalyst.review(cand.payload as unknown as ShortTermCandidateView, {
        depth: body.depth ?? "AUTO",
        question: typeof body.question === "string" ? body.question.slice(0, 400) : undefined,
        userBudget: body.budgetInr ?? null,
        userRiskPct: body.riskPerTradePct ?? null,
      });
      ok(res, { review }, 201);
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/short-term/alerts — latest transition alerts (deduped at write time). */
  alerts = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const rows = await AppDataSource.getRepository(ShortTermAlert).find({ order: { createdAt: "DESC" }, take: 50 });
      ok(res, { alerts: rows });
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/short-term/ai-usage — the cost dashboard (Part: COST DASHBOARD). */
  aiUsage = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      ok(res, { usage: await aiCostGovernor.usage(), mode: "FREE-FIRST" });
    } catch (err) {
      next(err);
    }
  };

  /** GET/PUT /api/short-term/preferences — per-account settings (never inferred). */
  getPreferences = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const row = await AppDataSource.getRepository(ShortTermPreference).findOne({ where: { accountId: req.account!.accountId } });
      ok(res, { prefs: row?.prefs ?? DEFAULT_SCAN_PARAMS });
    } catch (err) {
      next(err);
    }
  };

  putPreferences = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const repo = AppDataSource.getRepository(ShortTermPreference);
      const existing = await repo.findOne({ where: { accountId: req.account!.accountId } });
      const prefs = parseParams((req.body ?? {}) as Record<string, unknown>) as Record<string, unknown>;
      if (existing) {
        existing.prefs = { ...existing.prefs, ...prefs };
        existing.updatedAt = new Date();
        await repo.save(existing);
        ok(res, { prefs: existing.prefs });
      } else {
        const row = await repo.save(repo.create({ accountId: req.account!.accountId, prefs }));
        ok(res, { prefs: row.prefs }, 201);
      }
    } catch (err) {
      next(err);
    }
  };
}
