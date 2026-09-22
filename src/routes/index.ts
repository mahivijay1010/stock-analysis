import { Router } from "express";
import {
  StockController,
  ShortTermController,
  PortfolioController,
  IntelligenceController,
  QuantController,
  AuthController,
  LedgerController,
  ForecastController,
  UpstoxAuthController,
  LiveFeedController,
  EvidenceController,
  LearningJournalController,
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
  const upstoxAuthController = new UpstoxAuthController();
  const liveFeedController = new LiveFeedController();
  const evidenceController = new EvidenceController();
  const journalController = new LearningJournalController();
  const ledgerController = new LedgerController();
  const forecastController = new ForecastController();
  const shortTermController = new ShortTermController();

  // ── Auth (Phase B2, spec §12) ─────────────────────────────────────────────
  // Session cookie: httpOnly + SameSite=Strict; CSRF = custom X-Requested-With
  // header required on all mutations (see src/middleware/auth.ts for the
  // documented choice). Registration disabled — single seeded owner account.
  router.post("/auth/login", requireCsrfHeader, authController.login); //   POST /api/auth/login { username, password }
  router.post("/auth/passcode", requireCsrfHeader, authController.passcode); // POST /api/auth/passcode { passcode } — admin fast-path
  router.post("/auth/logout", requireAuth, authController.logout); //       POST /api/auth/logout
  router.get("/auth/me", requireAuth, authController.me); //                GET  /api/auth/me

  // ── Upstox real-time feed authorization (OAuth round trip) ───────────────
  // GETs by necessity: OAuth redirects are GETs. CSRF defence is the `state`
  // parameter, issued and verified once by the token store. No route ever
  // returns the access token. Upstox tokens die at 03:30 IST daily and have no
  // refresh token, so this is a once-a-day human step.
  router.get("/auth/upstox/login", upstoxAuthController.login); //          GET  /api/auth/upstox/login (302 → Upstox)
  router.get("/auth/upstox/callback", upstoxAuthController.callback); //    GET  /api/auth/upstox/callback?code=&state=
  router.get("/auth/upstox/status", upstoxAuthController.status); //        GET  /api/auth/upstox/status (no token exposed)

  // ── Live market feed (STREAMING mode) ────────────────────────────────────
  // Reads are open; start/stop are authenticated POSTs because they open a
  // broker connection and consume the daily Upstox token. Ticks drive
  // MONITORING only — a real-time feed raises the DATA mode, never the
  // evidence bar that gates an entry.
  router.get("/live/status", liveFeedController.status); //                 GET  /api/live/status
  router.get("/live/rows", liveFeedController.rows); //                     GET  /api/live/rows
  router.get("/live/forecasts", liveFeedController.forecasts); //          GET  /api/live/forecasts
  router.get("/live/detail/:ticker", liveFeedController.detail); //        GET  /api/live/detail/RELIANCE.NS
  router.post("/live/start", requireAuth, liveFeedController.start); //     POST /api/live/start { tickers? }
  router.post("/live/stop", requireAuth, liveFeedController.stop); //       POST /api/live/stop

  // ── Evidence ledger: the transparency surface ─────────────────────────────
  // Reads the append-only ledgers and shows what was predicted, what was
  // WRONG, and what changed as a result. Unauthenticated on purpose: the page
  // that argues against the system's own output must be as reachable as the
  // recommendations are.
  router.get("/evidence", evidenceController.bundle); //                    GET  /api/evidence?limit=200
  router.get("/evidence/predictions", evidenceController.predictions); //   GET  /api/evidence/predictions?limit=
  router.get("/evidence/calibrators", evidenceController.calibrators); //   GET  /api/evidence/calibrators
  router.get("/evidence/governance", evidenceController.governance); //     GET  /api/evidence/governance
  router.get("/evidence/experiments", evidenceController.experiments); //   GET  /api/evidence/experiments

  // ── Learning journal: pre-registered expectations, graded after the fact ──
  // Reads are open like the rest of the evidence surface. Writes are
  // authenticated because a registered claim is immutable — it can never be
  // edited or withdrawn, so writing one is a commitment.
  router.get("/journal", journalController.bundle); //                                        GET  /api/journal?limit=200
  router.get("/journal/due", journalController.due); //                                       GET  /api/journal/due
  router.post("/journal/expectations", requireAuth, journalController.register); //           POST /api/journal/expectations
  router.post("/journal/expectations/:id/resolve", requireAuth, journalController.resolve); //POST /api/journal/expectations/:id/resolve
  router.post("/journal/lessons", requireAuth, journalController.lesson); //                  POST /api/journal/lessons

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
  // Vintages (Parts 10/11): original stays immutable; current is a separate
  // issuance; drift = NORMAL/DRIFTING/INVALIDATED with reasons.
  router.get("/forecast/:ticker/vintage", forecastController.vintage); //              GET  /api/forecast/:t/vintage
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
  // Phase 14: batch row-chip summaries — MUST precede the :ticker param route.
  router.get("/decision/batch", forecastController.decisionBatch); //                   GET  /api/decision/batch?tickers=A,B
  router.get("/decision/:ticker", forecastController.decision); //                     GET  /api/decision/:t
  router.post("/decision/:ticker/publish", requireAuth, forecastController.publishDecision); // POST /api/decision/:t/publish
  // AI Investment Committee (risk-spec Rule 13): advisory + cap-only; audit-
  // trailed in ai_reviews; honest 503 when no provider key is configured.
  router.get("/decision/:ticker/committee", forecastController.committeeLatest); //     GET  /api/decision/:t/committee
  router.post("/decision/:ticker/committee", requireAuth, forecastController.committeeRun); // POST /api/decision/:t/committee
  router.post("/jobs/forecast-maintenance", requireAuthOrAdminKey, forecastController.maintenance); // POST /api/jobs/forecast-maintenance
  // SHORT-TERM TRADE RADAR (free-first; OpenAI only as governed escalation).
  // Static paths BEFORE :ticker so "latest"/"alerts" are never captured.
  router.post("/short-term/scan", requireAuth, shortTermController.scan); //            POST /api/short-term/scan
  router.get("/short-term/latest", shortTermController.latest); //                      GET  /api/short-term/latest
  router.get("/short-term/alerts", shortTermController.alerts); //                      GET  /api/short-term/alerts
  router.get("/short-term/model-lab", shortTermController.modelLab); //                 GET  /api/short-term/model-lab
  router.get("/short-term/ai-usage", shortTermController.aiUsage); //                   GET  /api/short-term/ai-usage
  router.get("/short-term/preferences", requireAuth, shortTermController.getPreferences); // GET /api/short-term/preferences
  router.put("/short-term/preferences", requireAuth, shortTermController.putPreferences); // PUT /api/short-term/preferences
  router.get("/short-term/:ticker", shortTermController.detail); //                     GET  /api/short-term/:t
  router.post("/short-term/:ticker/review", requireAuth, shortTermController.review); //POST /api/short-term/:t/review
  router.post("/short-term/:ticker/revalidate", requireAuth, shortTermController.revalidate); // POST /api/short-term/:t/revalidate
  // OpenAI multi-role AI pipeline (O2/O3): evidence graph -> analysts ->
  // critic -> committee; advisory + cap-only; honest 503 without a key.
  router.get("/events/:ticker", forecastController.events); //                          GET  /api/events/:t
  router.get("/ai/:ticker", forecastController.aiLatest); //                            GET  /api/ai/:t
  router.post("/ai/:ticker/analyze", requireAuth, forecastController.aiAnalyze); //     POST /api/ai/:t/analyze
  // Phase 13 live model monitoring: rolling Brier/coverage over resolved
  // prediction_logs → HEALTHY/DEGRADED/SUSPENDED/INSUFFICIENT_HISTORY.
  // SUSPENDED hard-caps BUY in decision-policy-v5.
  router.get("/monitoring/model-health", forecastController.modelHealth); //            GET  /api/monitoring/model-health
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
  // P0 security #11: expensive/outbound-fetch mutations require auth (refreshes
  // trigger provider fetches — the SSRF/exhaustion surface — and portfolio
  // takes user positions). GET reads stay public.
  router.post("/intelligence/macro/refresh", requireAuthOrAdminKey, intelligenceController.refreshMacro);
  router.get("/intelligence/macro", intelligenceController.macro);
  router.get("/intelligence/source-registry", intelligenceController.registry);
  router.post("/intelligence/portfolio", requireAuth, intelligenceController.portfolio);
  router.post("/intelligence/:ticker/refresh", requireAuthOrAdminKey, intelligenceController.refresh);
  router.get("/intelligence/:ticker", intelligenceController.get);

  // V8: relative rank + vol forecast (labeled diagnostics/evaluation keepers).
  router.get("/rank/universe", quantController.rankUniverse); //  GET /api/rank/universe
  router.get("/volatility/forecast/:ticker", quantController.volatilityForecast); //  GET /api/volatility/forecast/RELIANCE.NS

  router.get("/search", controller.search); //  GET /api/search?q=tata
  // P0 security #11: /analyze runs the full live pipeline (provider fetches +
  // heavy compute) — authenticate it to prevent unauthenticated resource abuse.
  router.post("/analyze", requireAuth, controller.analyze); //  POST /api/analyze { ticker, amount? }
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
