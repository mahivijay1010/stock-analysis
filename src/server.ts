import "reflect-metadata";
import * as dotenv from "dotenv";
dotenv.config();

import { createApp } from "./app";
import { initializeDatabase } from "./config/database";
import { CronService } from "./services/CronService";
import { stockService } from "./services/StockService";
import { upstoxTokenStore } from "./services/realtime/upstoxAuth";
import { liveFeedService } from "./services/realtime/LiveFeedService";
import { LiveFeedSupervisor } from "./services/realtime/liveFeedSupervisor";

const PORT = Number.parseInt(process.env.PORT || "5101", 10);
let cronService: CronService | null = null;
let feedSupervisor: LiveFeedSupervisor | null = null;

const startServer = async (): Promise<void> => {
  try {
    console.log("🔄 Initializing database connection...");
    await initializeDatabase();

    const app = createApp();

    cronService = new CronService(stockService);
    cronService.startAll();

    // Recover a still-valid Upstox token from the encrypted cache. A restart
    // during market hours should not cost a browser login the 03:30 expiry has
    // not yet forced — three sessions were lost that way (upstoxAuth.ts header).
    const restored = upstoxTokenStore.restoreFromVault();
    console.log(restored.restored ? `🔑 Upstox token restored — ${restored.reason}` : `🔑 No Upstox token in cache — ${restored.reason}`);

    // Auto-start the feed inside the trading window whenever a token exists.
    // The daily login stays manual (no refresh tokens); everything after it
    // is automatic.
    feedSupervisor = new LiveFeedSupervisor(liveFeedService);
    feedSupervisor.start();

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
  feedSupervisor?.stop();
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  cronService?.stopAll();
  feedSupervisor?.stop();
  process.exit(1);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received: shutting down");
  cronService?.stopAll();
  feedSupervisor?.stop();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("SIGINT received: shutting down");
  cronService?.stopAll();
  feedSupervisor?.stop();
  process.exit(0);
});

startServer();
