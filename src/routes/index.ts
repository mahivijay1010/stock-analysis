import { Router } from "express";
import {
  StockController,
  HoldingsController,
  PortfolioController,
  AssistantController,
  IntelligenceController,
  QuantController,
} from "../controllers";
import { AdminController } from "../controllers/AdminController";
import { createAdminRoutes } from "./admin";

/**
 * API routes (mounted at /api). Route order matters:
 * - /admin/* is mounted FIRST so nothing ever captures "admin" as a param.
 * - /stocks/popular MUST be registered before /stocks/:ticker/* so "popular"
 *   is never captured as a ticker parameter.
 */
export const createStockRoutes = (): Router => {
  const router = Router();
  const controller = new StockController();
  const holdingsController = new HoldingsController();
  const portfolioController = new PortfolioController();
  const intelligenceController = new IntelligenceController();
  const quantController = new QuantController();

  // Admin trading desk (V2-D) — before any param routes.
  router.use("/admin", createAdminRoutes());

  // Holdings P&L calculator — stateless, usable from Analyze and Admin.
  router.post("/holdings/calculate", holdingsController.calculate); //  POST /api/holdings/calculate

  // Multi-stock allocation suggestion for any ₹ amount (public).
  router.post("/portfolio/suggest", portfolioController.suggest); //  POST /api/portfolio/suggest

  // V7 A4: portfolio stress + portfolio calibration (query tickers/weights,
  // or the admin desk's open positions when none given).
  router.get("/portfolio/stress", portfolioController.stress); //  GET /api/portfolio/stress?tickers=A,B
  router.get("/portfolio/calibration", portfolioController.calibration); //  GET /api/portfolio/calibration?tickers=A,B

  // Stock-only assistant (rule-based over live app data).
  router.post("/assistant", new AssistantController().ask); //  POST /api/assistant

  // Provenance-first company fundamentals, macro observations and portfolio risk.
  router.post("/intelligence/macro/refresh", intelligenceController.refreshMacro);
  router.get("/intelligence/macro", intelligenceController.macro);
  router.get("/intelligence/source-registry", intelligenceController.registry);
  router.post("/intelligence/portfolio", intelligenceController.portfolio);
  router.post("/intelligence/:ticker/refresh", intelligenceController.refresh);
  router.get("/intelligence/:ticker", intelligenceController.get);

  // V8 R1–R4: relative rank, vol forecast, options radar, Kelly sizing.
  router.get("/rank/universe", quantController.rankUniverse); //  GET /api/rank/universe
  router.get("/volatility/forecast/:ticker", quantController.volatilityForecast); //  GET /api/volatility/forecast/RELIANCE.NS
  router.get("/options/skew/:ticker", quantController.optionsSkew); //  GET /api/options/skew/RELIANCE.NS
  router.get("/position-size/:ticker", quantController.positionSize); //  GET /api/position-size/TCS.NS?capital=100000

  // V9 E1: execution feedback loop over the PaperTrade ledger.
  router.get("/execution/summary", new AdminController().executionSummary); //  GET /api/execution/summary

  router.get("/search", controller.search); //  GET /api/search?q=tata
  router.post("/analyze", controller.analyze); //  POST /api/analyze { ticker, amount? }
  router.get("/top-picks", controller.topPicks); //  GET /api/top-picks?count=5
  router.get("/backtest/:ticker", controller.backtest); //  GET /api/backtest/RELIANCE.NS?days=60
  router.get("/accuracy", controller.accuracy); //  GET /api/accuracy
  router.get("/calibration", controller.calibration); //  GET /api/calibration (V6)
  router.get("/research/:ticker", controller.research); //  GET /api/research/RELIANCE.NS (V6)

  // Legacy alias — MUST come before /stocks/:ticker/* routes.
  router.get("/stocks/popular", controller.popular); //  GET /api/stocks/popular

  router.get("/stocks/:ticker/chart", controller.chart); //  GET /api/stocks/:t/chart?range=1mo
  router.get("/stocks/:ticker/history", controller.history); //  GET /api/stocks/:t/history?limit=20
  router.get("/stocks", controller.stocks); //  GET /api/stocks

  return router;
};
