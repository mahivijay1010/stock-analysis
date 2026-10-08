/**
 * UniverseController — Universe + Research Engine 2.0 HTTP surface.
 *   GET  /api/universe/health                 counts, tiers, coverage, freshness, provider health, failures
 *   GET  /api/universe/securities?tier=&type=&q=&cap=&limit=
 *   GET  /api/universe/funnel                 latest broad-scan stage counts + exact reasons
 *   GET  /api/universe/scan/latest?...filters the scanner results table
 *   POST /api/universe/sync                   (auth) run the security-master sync now
 *   POST /api/universe/scan                   (auth) run the broad scan now
 *   GET  /api/universe/research-queue
 *   POST /api/universe/research/:symbol      (auth) build profile (+AI with ?ai=1)
 *   GET  /api/universe/company/:symbol        Company Intelligence bundle
 *   GET  /api/universe/learning               segment performance (withheld < 10)
 */
import { NextFunction, Request, Response } from "express";
import { AppDataSource } from "../config/database";
import { HttpError } from "../types";

function ok(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ success: true, data });
}
const sym = (v: unknown): string => String(v ?? "").replace(/\.NS$/i, "").toUpperCase();

export class UniverseController {
  health = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { universeHealthService } = await import("../services/universe/UniverseHealthService");
      ok(res, await universeHealthService.health());
    } catch (err) {
      next(err);
    }
  };

  securities = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query;
      const where: string[] = ["1=1"];
      const params: unknown[] = [];
      const add = (cond: string, v: unknown) => {
        params.push(v);
        where.push(cond.replace("?", `$${params.length}`));
      };
      if (typeof q.tier === "string" && q.tier) add("liquidity_tier = ?", q.tier.toUpperCase());
      if (typeof q.type === "string" && q.type) add("instrument_type = ?", q.type.toUpperCase());
      if (typeof q.cap === "string" && q.cap) add("market_cap_bucket = ?", q.cap.toUpperCase());
      if (typeof q.q === "string" && q.q.trim()) add("(symbol ILIKE ? OR company_name ILIKE ?)".replace("? OR company_name ILIKE ?", `$${params.length + 1} OR company_name ILIKE $${params.length + 1}`), `%${q.q.trim()}%`);
      if (q.active !== "all") where.push("is_active");
      const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
      const rows = await AppDataSource.query(
        `SELECT m.symbol, m.company_name, m.isin, m.series, m.instrument_type, m.sector, m.industry, m.market_cap_bucket, m.market_cap_source, m.liquidity_tier, m.liquidity_median_value_inr, m.liquidity_as_of, m.last_trade_date, m.is_active, m.is_tradable, m.surveillance, m.data_status, m.indices, m.source, m.source_freshness_at, c.coverage_score, c.ohlcv_available, c.fundamentals_available, c.news_available
           FROM security_master m LEFT JOIN security_data_coverage c ON c.symbol = m.symbol WHERE ${where.join(" AND ")} ORDER BY m.liquidity_median_value_inr DESC NULLS LAST LIMIT ${limit}`,
        params
      );
      ok(res, { rows, limit });
    } catch (err) {
      next(err);
    }
  };

  funnel = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { marketOpportunityScanner } = await import("../services/universe/MarketOpportunityScanner");
      const f = await marketOpportunityScanner.latestFunnel();
      ok(res, f ?? { stages: [], finalQualified: 0, zeroBecause: ["no broad scan has run yet"], asOf: null, regime: null, scanId: null, durationMs: 0, scanRunId: null });
    } catch (err) {
      next(err);
    }
  };

  scanLatest = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const [scan] = (await AppDataSource.query(`SELECT id, as_of::text, regime, stages FROM opportunity_scans WHERE status='success' ORDER BY started_at DESC LIMIT 1`)) as Array<{ id: string; as_of: string; regime: string | null; stages: unknown }>;
      if (!scan) {
        ok(res, { asOf: null, regime: null, rows: [], total: 0 });
        return;
      }
      const q = req.query;
      const where: string[] = ["c.scan_id = $1"];
      const params: unknown[] = [scan.id];
      const add = (cond: string, v: unknown) => {
        params.push(v);
        where.push(cond.replace("?", `$${params.length}`));
      };
      if (typeof q.tier === "string" && q.tier) add("c.liquidity_tier = ?", q.tier.toUpperCase());
      if (typeof q.cap === "string" && q.cap) add("c.market_cap_bucket = ?", q.cap.toUpperCase());
      if (typeof q.sector === "string" && q.sector) add("c.sector = ?", q.sector);
      if (typeof q.stage === "string" && q.stage) add("c.stage_reached = ?", q.stage.toUpperCase());
      if (typeof q.signal === "string" && q.signal) add("? = ANY(c.signals)", q.signal.toUpperCase());
      if (typeof q.setup === "string" && q.setup) add("c.setup_type = ?", q.setup.toUpperCase());
      if (typeof q.trend === "string" && q.trend) add("c.features->>'trend' = ?", q.trend.toUpperCase());
      if (q.minPrice) add("(c.features->>'price')::numeric >= ?", Number(q.minPrice));
      if (q.maxPrice) add("(c.features->>'price')::numeric <= ?", Number(q.maxPrice));
      if (q.minRelVol) add("(c.features->>'volumeRatio20')::numeric >= ?", Number(q.minRelVol));
      if (q.minTechnical) add("c.technical_score >= ?", Number(q.minTechnical));
      if (q.minFundamental) add("c.fundamental_score >= ?", Number(q.minFundamental));
      if (q.min52w) add("(c.features->>'pos52wPct')::numeric >= ?", Number(q.min52w));
      if (q.maxVol) add("(c.features->>'realizedVol20AnnPct')::numeric <= ?", Number(q.maxVol));
      if (q.recentEvent === "1") add("c.event_score IS NOT NULL AND c.event_score <> ?", -1);
      if (typeof q.q === "string" && q.q.trim()) {
        params.push(`%${q.q.trim()}%`);
        where.push(`(c.symbol ILIKE $${params.length} OR m.company_name ILIKE $${params.length})`);
      }
      const limit = Math.min(500, Math.max(1, Number(q.limit) || 150));
      const sort = typeof q.sort === "string" && ["technical_score", "fundamental_score", "liquidity_score", "risk_score", "screen_rank"].includes(q.sort) ? q.sort : "technical_score";
      const rows = await AppDataSource.query(
        `SELECT c.symbol, m.company_name, c.sector, c.liquidity_tier, c.market_cap_bucket, c.stage_reached, c.rejected_at_stage, c.rejection_reasons, c.signals, c.features,
                c.technical_score, c.fundamental_score, c.event_score, c.research_evidence_score, c.liquidity_score, c.risk_score, c.model_health_score, c.screen_rank,
                c.setup_type, c.action, c.tier, c.decision_status, c.plan, cov.coverage_score, cov.ohlcv_available, cov.fundamentals_available, cov.news_available,
                (SELECT status FROM research_queue r WHERE r.symbol = c.symbol ORDER BY queued_at DESC LIMIT 1) AS research_status,
                (SELECT built_at FROM company_research_profiles p WHERE p.symbol = c.symbol ORDER BY built_at DESC LIMIT 1) AS researched_at
           FROM opportunity_candidates c JOIN security_master m ON m.symbol = c.symbol LEFT JOIN security_data_coverage cov ON cov.symbol = c.symbol
          WHERE ${where.join(" AND ")} ORDER BY ${sort} DESC NULLS LAST, c.symbol LIMIT ${limit}`,
        params
      );
      const [{ total }] = (await AppDataSource.query(`SELECT COUNT(*)::int total FROM opportunity_candidates c JOIN security_master m ON m.symbol = c.symbol WHERE ${where.join(" AND ")}`, params)) as Array<{ total: number }>;
      const sectors = await AppDataSource.query(`SELECT DISTINCT sector FROM opportunity_candidates WHERE scan_id = $1 AND sector IS NOT NULL ORDER BY 1`, [scan.id]);
      ok(res, { scanId: scan.id, asOf: scan.as_of, regime: scan.regime, stages: scan.stages, rows, total, limit, sectors: (sectors as Array<{ sector: string }>).map((s) => s.sector) });
    } catch (err) {
      next(err);
    }
  };

  sync = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { universeIngestionService } = await import("../services/universe/UniverseIngestionService");
      const { securityDataCoverageService } = await import("../services/universe/SecurityDataCoverageService");
      const sync = await universeIngestionService.syncSecurityUniverse();
      const coverage = await securityDataCoverageService.recomputeAll();
      ok(res, { sync, coverage }, 201);
    } catch (err) {
      next(err);
    }
  };

  scan = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { marketOpportunityScanner } = await import("../services/universe/MarketOpportunityScanner");
      const { researchQueueService } = await import("../services/universe/ResearchQueueService");
      const body = (req.body ?? {}) as Record<string, unknown>;
      const funnel = await marketOpportunityScanner.run({
        ...(Number.isFinite(Number(body.technicalKeep)) ? { technicalKeep: Number(body.technicalKeep) } : {}),
        ...(Number.isFinite(Number(body.researchKeep)) ? { researchKeep: Number(body.researchKeep) } : {}),
      });
      const queue = await researchQueueService.rebuild();
      ok(res, { funnel, queue }, 201);
    } catch (err) {
      next(err);
    }
  };

  researchQueue = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { researchQueueService } = await import("../services/universe/ResearchQueueService");
      ok(res, { items: await researchQueueService.list(100) });
    } catch (err) {
      next(err);
    }
  };

  research = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { companyResearchProfileService } = await import("../services/universe/CompanyResearchProfileService");
      const { aiResearchService } = await import("../services/universe/AiResearchService");
      const s = sym(req.params.symbol);
      const built = await companyResearchProfileService.build(s, { persist: true });
      const ai = req.query.ai === "1" ? await aiResearchService.research(s, built) : null;
      ok(res, { profile: built.profile, evidence: built.evidence, profileId: built.profileId, ai, aiNote: req.query.ai === "1" && !ai ? "AI research skipped: cost governor or provider unavailable" : null }, 201);
    } catch (err) {
      next(err);
    }
  };

  company = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { companyResearchProfileService } = await import("../services/universe/CompanyResearchProfileService");
      const s = sym(req.params.symbol);
      const [exists] = (await AppDataSource.query(`SELECT symbol FROM security_master WHERE symbol = $1`, [s])) as Array<{ symbol: string }>;
      if (!exists) throw new HttpError(404, `Unknown security ${s}`);
      const stored = await companyResearchProfileService.latest(s);
      const fresh = stored && Date.now() - new Date(stored.builtAt).getTime() < 6 * 3600_000 ? null : await companyResearchProfileService.build(s, { persist: false });
      const profile = fresh ? fresh.profile : (stored!.profile as unknown);
      const evidence = fresh ? fresh.evidence : stored!.evidenceItems;
      const latestAi = (await AppDataSource.query(`SELECT ai, built_at, model_version FROM company_research_profiles WHERE symbol = $1 AND ai IS NOT NULL ORDER BY built_at DESC LIMIT 1`, [s])) as Array<{ ai: unknown; built_at: string; model_version: string | null }>;
      const decisions = await AppDataSource.query(
        `SELECT a.plan_date::text, a.action, a.decision_status, a.recommended_amount_inr, a.entry_price, a.stop_price, a.target1, a.reason_codes, p.risk_profile, p.market_regime
           FROM capital_allocations a JOIN capital_plans p ON p.id = a.capital_plan_id WHERE a.ticker IN ($1, $2) ORDER BY a.created_at DESC LIMIT 20`,
        [s, `${s}.NS`]
      );
      const scanHistory = await AppDataSource.query(`SELECT as_of::text, stage_reached, rejected_at_stage, rejection_reasons, signals, setup_type, action, tier, technical_score FROM opportunity_candidates WHERE symbol = $1 ORDER BY as_of DESC LIMIT 15`, [s]);
      const liq = await AppDataSource.query(`SELECT liquidity_tier, liquidity_median_value_inr, surveillance, is_tradable, data_status FROM security_master WHERE symbol = $1`, [s]);
      ok(res, { symbol: s, profile, evidence, profileSource: fresh ? "built-now" : "stored", profileBuiltAt: fresh ? fresh.profile.builtAt : stored!.builtAt, ai: latestAi[0]?.ai ?? null, aiBuiltAt: latestAi[0]?.built_at ?? null, decisionHistory: decisions, scanHistory, risk: liq[0] ?? null });
    } catch (err) {
      next(err);
    }
  };

  learning = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { opportunityOutcomeService } = await import("../services/universe/OpportunityOutcomeService");
      ok(res, await opportunityOutcomeService.learning());
    } catch (err) {
      next(err);
    }
  };
}
