/**
 * ShortTermController (S1/S7/S11) — HTTP surface for the Trade Radar.
 * GETs read stored scans; running a scan or AI review is an authenticated POST.
 */

import { NextFunction, Request, Response } from "express";
import { AppDataSource } from "../config/database";
import { ShortTermAlert, ShortTermCandidate, ShortTermPreference, ShortTermScanRun, ShortTermTransition } from "../entities";
import { shortTermScanService } from "../services/shortterm/ScanService";
import { shortTermTradeAnalyst, aiCostGovernor } from "../services/shortterm/aiAnalyst";
import { preEntryRevalidationService } from "../services/shortterm/PreEntryRevalidationService";
import { SETUP_EVIDENCE_MODEL } from "../services/shortterm/setupEvidence";
import { ShortTermCandidateView, DEFAULT_SCAN_PARAMS, ScanParams } from "../services/shortterm/types";
import { HttpError } from "../types";

function ok(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ success: true, data });
}

/**
 * P0 #47 — explicit input validation. A bad value THROWS an HttpError(400)
 * rather than silently coercing (which previously accepted negative budgets,
 * extreme risk %, and min>max price windows). Ranges are documented bounds.
 */
export function parseParams(src: Record<string, unknown>): Partial<ScanParams> {
  const num = (v: unknown): number | null => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  const bounded = (v: unknown, name: string, min: number, max: number): number | null => {
    const n = num(v);
    if (n == null) return null;
    if (n < min || n > max) throw new HttpError(400, `${name} must be between ${min} and ${max} (got ${n}).`);
    return n;
  };
  const enumOr = <T extends string>(v: unknown, allowed: readonly T[], name: string): T | undefined => {
    if (v == null || v === "") return undefined;
    if (!allowed.includes(v as T)) throw new HttpError(400, `${name} must be one of ${allowed.join(", ")}.`);
    return v as T;
  };

  const budgetInr = bounded(src.budgetInr, "budgetInr", 1_000, 100_000_000);
  const priceMin = bounded(src.priceMin, "priceMin", 1, 10_000_000);
  const priceMax = bounded(src.priceMax, "priceMax", 1, 10_000_000);
  if (priceMin != null && priceMax != null && priceMin > priceMax) {
    throw new HttpError(400, `priceMin (${priceMin}) cannot exceed priceMax (${priceMax}).`);
  }
  return {
    budgetInr,
    priceMin,
    priceMax,
    horizon: enumOr(src.horizon, ["1-3d", "3-5d", "5-10d", "10-21d"] as const, "horizon"),
    // Varsity RM 14.1: "professional traders do not risk more than 1 to 3% of
    // their capital on any single trade" (worked example 1.5%). Ceiling was 5%.
    // The default (types.ts DEFAULT_SCAN_PARAMS, 0.5%) is deliberately BELOW
    // the professional range — conservative is not a doctrinal violation.
    riskPerTradePct: bounded(src.riskPerTradePct, "riskPerTradePct", 0.01, 3) ?? undefined,
    strategy: enumOr(src.strategy, ["ALL", "PULLBACK", "BREAKOUT", "MOMENTUM", "MEAN_REVERSION"] as const, "strategy"),
    sector: typeof src.sector === "string" && src.sector && src.sector !== "ALL" ? src.sector : null,
    minAdvInr: bounded(src.minAdvInr, "minAdvInr", 0, 1e12),
    aiDepth: enumOr(src.aiDepth, ["AUTO", "LOCAL_ONLY", "LOW_COST", "DEEP_REVIEW"] as const, "aiDepth"),
    limit: bounded(src.limit, "limit", 0, 50) ?? undefined,
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
      // V2: split on the payload's `qualified` flag (tier A + ENTRY_CONFIRMED +
      // affordable), NOT on base-gate passage — a passed base gate is not an
      // actionable trade.
      const isQualified = (r: (typeof rows)[number]) => (r.payload as { qualified?: boolean }).qualified === true;
      const qualified = rows.filter(isQualified).map((r) => r.payload);
      ok(res, {
        available: true,
        run,
        candidates: qualified,
        watchlist: rows.filter((r) => !isQualified(r)).map((r) => r.payload),
        qualifiedCount: qualified.length,
        watchlistCount: rows.length - qualified.length,
        emptyMessage: qualified.length === 0 ? "No statistically attractive short-term setups currently pass the risk and evidence gates. Interesting setups are on the Research Watchlist below." : null,
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

  /** POST /api/short-term/:ticker/revalidate — pre-entry gap/freshness/EV re-check (auth). */
  revalidate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      ok(res, await preEntryRevalidationService.revalidate(req.params.ticker), 201);
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/short-term/model-lab — per-setup evidence tiers + expectancy (Model Lab, Part 31). */
  modelLab = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const rows: Array<{ metrics: Record<string, unknown>; verdict: string | null; created_at: string }> = await AppDataSource.query(
        `SELECT metrics, verdict, created_at FROM short_term_model_performance
          WHERE model_name = $1 ORDER BY created_at DESC LIMIT 1`,
        [SETUP_EVIDENCE_MODEL]
      );
      const shadow: Array<{ metrics: Record<string, unknown>; verdict: string | null }> = await AppDataSource.query(
        `SELECT metrics, verdict FROM short_term_model_performance
          WHERE model_name IN ('st-shadow-tracker','st-meta-label-lgbm') ORDER BY created_at DESC LIMIT 5`
      );
      ok(res, {
        available: rows.length > 0,
        setupEvidence: rows[0] ? { cells: rows[0].metrics.cells ?? [], verdict: rows[0].verdict, asOf: rows[0].created_at } : null,
        shadow: shadow.map((s) => ({ metrics: s.metrics, verdict: s.verdict })),
      });
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
