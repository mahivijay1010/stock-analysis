import "reflect-metadata";
import * as dotenv from "dotenv";
dotenv.config();

import { createApp } from "./app";
import { initializeDatabase } from "./config/database";
import { CronService } from "./services/CronService";
import { stockService } from "./services/StockService";

const PORT = Number.parseInt(process.env.PORT || "5101", 10);
let cronService: CronService | null = null;

const startServer = async (): Promise<void> => {
  try {
    console.log("🔄 Initializing database connection...");
    await initializeDatabase();

    const app = createApp();

    cronService = new CronService(stockService);
    cronService.startAll();

    app.listen(PORT, () => {
      console.log("");
      console.log("════════════════════════════════════════════════════════════");
      console.log("  🚀 Indian Stock Analysis & Prediction System");
      console.log("════════════════════════════════════════════════════════════");
      console.log(`  Server running on: http://localhost:${PORT}`);
      console.log(`  Health check:      http://localhost:${PORT}/health`);
      console.log(`  Analyze endpoint:  POST http://localhost:${PORT}/api/analyze`);
      console.log("════════════════════════════════════════════════════════════");
      console.log("");
      console.log("⚠️  DISCLAIMER: educational analysis tool, not SEBI-registered");
      console.log("   investment advice. Markets are inherently uncertain.");
      console.log("");
      console.log("✓  Ready to accept requests");
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
};

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  cronService?.stopAll();
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  cronService?.stopAll();
  process.exit(1);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received: shutting down");
  cronService?.stopAll();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("SIGINT received: shutting down");
  cronService?.stopAll();
  process.exit(0);
});

startServer();
