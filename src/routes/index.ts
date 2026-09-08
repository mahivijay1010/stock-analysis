import { Router } from "express";
import {
  StockController,
  PortfolioController,
  IntelligenceController,
  QuantController,
  AuthController,
  LedgerController,
  ForecastController,
} from "../controllers";
import { createAdminRoutes } from "./admin";
import { requireAuth, requireAuthOrAdminKey, requireCsrfHeader } from "../middleware/auth";

/**
 * API routes (mounted at /api). Route order matters:
 * - /admin/* is mounted FIRST so nothing ever captures "admin" as a param.
 * - /stocks/popular MUST be registered before /stocks/:ticker/* so "popular"
 *   is never captured as a ticker parameter.
 *
 * REMOVED in the v2 upgrade (upgrade-audit §3 matrix; plan §3.2) — routes,
 * handlers, services, deps and feature-specific tests went together:
 *   POST /api/holdings/calculate   (absorbed into the real Holdings ledger, B2)
 *   POST /api/portfolio/suggest    (allocation builder removed from product)
 *   POST /api/assistant            (Sensei chatbot removed)
 *   GET  /api/options/skew/:t      (permanently Akamai-blocked provider)
 *   GET  /api/position-size/:t     (consumer Kelly advice removed)
 *   GET  /api/execution/summary    (adaptive execution feedback removed)
 *   GET  /api/admin/daily-plan     (cash-split + goal path removed)
 *
 * READ/WRITE CONTRACT (upgrade-audit §4, fixed in Phase B1): no GET mutates
 * canonical records. The two offenders were fixed — GET /api/backtest/:t no
 * longer upserts ModelPerformance (job path only), and GET /api/research/:t
 * runs a non-persisting analysis. What REMAINS on read paths, by design:
 *  - the internal daily-bar CACHE fill (MarketDataService.persistBars
 *    refreshing stale stock_history coverage) plus registry stock-row
 *    creation on resolve/search — cache semantics, not canonical records;
 *  - the idempotent one-time paper-account seed on /api/admin/*.
 */
export const createStockRoutes = (): Router => {
  const router = Router();
  const controller = new StockController();
  const portfolioController = new PortfolioController();
  const intelligenceController = new IntelligenceController();
  const quantController = new QuantController();
  const authController = new AuthController();
  const ledgerController = new LedgerController();
  const forecastController = new ForecastController();

  // ── Auth (Phase B2, spec §12) ─────────────────────────────────────────────
  // Session cookie: httpOnly + SameSite=Strict; CSRF = custom X-Requested-With
  // header required on all mutations (see src/middleware/auth.ts for the
  // documented choice). Registration disabled — single seeded owner account.
  router.post("/auth/login", requireCsrfHeader, authController.login); //   POST /api/auth/login { username, password }
  router.post("/auth/logout", requireAuth, authController.logout); //       POST /api/auth/logout
  router.get("/auth/me", requireAuth, authController.me); //                GET  /api/auth/me

  // ── Watchlist (spec §3: follow ≠ own; removing never touches holdings) ───
  router.get("/watchlist", requireAuth, ledgerController.listWatchlist); //         GET    /api/watchlist
  router.post("/watchlist", requireAuth, ledgerController.addWatchlist); //         POST   /api/watchlist { ticker, notes?, horizon? }
  router.delete("/watchlist/:id", requireAuth, ledgerController.removeWatchlist); //DELETE /api/watchlist/:id

  // ── Holdings + immutable transaction ledger (spec §3/§4) ─────────────────
  // NOTE: /transactions/export.csv and /transactions/import are registered
  // before /transactions/:id/correct so neither is captured as an :id.
  router.get("/holdings", requireAuth, ledgerController.holdings); //                    GET  /api/holdings (derived positions + P&L)
  router.get("/transactions", requireAuth, ledgerController.listTransactions); //        GET  /api/transactions?ticker=&limit=&offset=
  router.get("/transactions/export.csv", requireAuth, ledgerController.exportCsv); //    GET  /api/transactions/export.csv
  router.post("/transactions", requireAuth, ledgerController.recordTransaction); //      POST /api/transactions
  router.post("/transactions/import", requireAuth, ledgerController.importTransactions); // POST /api/transactions/import { rows, dryRun? }
  router.post("/transactions/:id/correct", requireAuth, ledgerController.correctTransaction); // POST /api/transactions/:id/correct { note? }

  // ── Immutable forecasts (Phase C, spec §5) ────────────────────────────────
  // GETs read stored issuances only; POSTs (auth) create NEW immutable
  // issuances — nothing here ever updates a forecast in place.
  router.get("/forecast/:ticker/daily", forecastController.daily); //                 GET  /api/forecast/:t/daily
  router.get("/forecast/:ticker/month/:period", forecastController.month); //         GET  /api/forecast/:t/month/2026-09
  router.post("/forecast/:ticker/issue", requireAuth, forecastController.issue); //   POST /api/forecast/:t/issue
  router.post(
    "/forecast/:ticker/month/:period/refresh",
    requireAuth,
    forecastController.refreshMonth
  ); //                                                                               POST /api/forecast/:t/month/:p/refresh
  router.get("/holdings/projection", requireAuth, forecastController.holdingsProjection); // GET /api/holdings/projection
  // Unified portfolio (owner request 2026-09-06): watchlist ∪ holdings with
  // month forecast + decision + horizon per row, one read.
  router.get("/portfolio/overview", requireAuth, forecastController.portfolioOverview); //   GET  /api/portfolio/overview
  // Canonical evidence-gated decisions (spec §9) — ONE service, every surface
  // reads the same published snapshot. BUY_CANDIDATE requires a VALIDATED
  // directional edge; today's measured record has none, stated honestly.
  router.get("/decision/:ticker", forecastController.decision); //                     GET  /api/decision/:t
  router.post("/decision/:ticker/publish", requireAuth, forecastController.publishDecision); // POST /api/decision/:t/publish
  // AI Investment Committee (risk-spec Rule 13): advisory + cap-only; audit-
  // trailed in ai_reviews; honest 503 when no provider key is configured.
  router.get("/decision/:ticker/committee", forecastController.committeeLatest); //     GET  /api/decision/:t/committee
  router.post("/decision/:ticker/committee", requireAuth, forecastController.committeeRun); // POST /api/decision/:t/committee
  router.post("/jobs/forecast-maintenance", requireAuthOrAdminKey, forecastController.maintenance); // POST /api/jobs/forecast-maintenance
  // Experiment registry (risk-spec Rule 4): champion vs naive baselines on
  // VERIFIED live predictions; append-only runs; GET is read-only.
  router.get("/experiments/latest", forecastController.experiments); //                 GET  /api/experiments/latest?limit=5
  router.post("/jobs/experiments", requireAuthOrAdminKey, forecastController.runExperiments); // POST /api/jobs/experiments

  // Admin trading desk (V2-D) — before any param routes. Now requires a real
  // session (or x-admin-key when ADMIN_KEY is configured) — see routes/admin.ts.
  router.use("/admin", createAdminRoutes());

  // Protected job submissions — the ONLY request path that may mutate official
  // stats (upgrade-audit §4 #1). Session auth (or configured admin key).
  router.post("/jobs/backtest", requireAuthOrAdminKey, controller.backtestJob); //  POST /api/jobs/backtest { ticker, days? }

  // V7 A4: portfolio stress + portfolio calibration (explicit query tickers).
  router.get("/portfolio/stress", portfolioController.stress); //  GET /api/portfolio/stress?tickers=A,B
  router.get("/portfolio/calibration", portfolioController.calibration); //  GET /api/portfolio/calibration?tickers=A,B

  // Provenance-first company fundamentals, macro observations and portfolio risk.
  router.post("/intelligence/macro/refresh", intelligenceController.refreshMacro);
  router.get("/intelligence/macro", intelligenceController.macro);
  router.get("/intelligence/source-registry", intelligenceController.registry);
  router.post("/intelligence/portfolio", intelligenceController.portfolio);
  router.post("/intelligence/:ticker/refresh", intelligenceController.refresh);
  router.get("/intelligence/:ticker", intelligenceController.get);

  // V8: relative rank + vol forecast (labeled diagnostics/evaluation keepers).
  router.get("/rank/universe", quantController.rankUniverse); //  GET /api/rank/universe
  router.get("/volatility/forecast/:ticker", quantController.volatilityForecast); //  GET /api/volatility/forecast/RELIANCE.NS

  router.get("/search", controller.search); //  GET /api/search?q=tata
  router.post("/analyze", controller.analyze); //  POST /api/analyze { ticker, amount? }
  router.get("/top-picks", controller.topPicks); //  GET /api/top-picks?count=5
  router.get("/backtest/:ticker", controller.backtest); //  GET /api/backtest/RELIANCE.NS?days=60 (read-only)
  router.get("/accuracy", controller.accuracy); //  GET /api/accuracy
  router.get("/calibration", controller.calibration); //  GET /api/calibration (V6)
  router.get("/research/:ticker", controller.research); //  GET /api/research/RELIANCE.NS (V6, read-only)

  // Legacy alias — MUST come before /stocks/:ticker/* routes.
  router.get("/stocks/popular", controller.popular); //  GET /api/stocks/popular

  router.get("/stocks/:ticker/chart", controller.chart); //  GET /api/stocks/:t/chart?range=1mo
  router.get("/stocks/:ticker/history", controller.history); //  GET /api/stocks/:t/history?limit=20
  router.get("/stocks", controller.stocks); //  GET /api/stocks

  return router;
};
