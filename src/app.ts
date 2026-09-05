import express, { Application } from "express";
import cors from "cors";
import { createStockRoutes } from "./routes";
import { errorHandler, notFoundHandler, requestLogger } from "./middleware";
import { AppDataSource } from "./config/database";

/**
 * Create and configure the Express application:
 * CORS, JSON parsing, request logging, /health, /api routes, error envelope.
 */
export const createApp = (): Application => {
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(requestLogger);

  // App-level health check
  app.get("/health", (_req, res) => {
    res.status(200).json({
      success: true,
      data: {
        status: "ok",
        service: "Indian Stock Analysis & Prediction System",
        timestamp: new Date().toISOString(),
        db: AppDataSource.isInitialized,
      },
    });
  });

  // API routes
  app.use("/api", createStockRoutes());

  // 404 + global error handler (must be last)
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
