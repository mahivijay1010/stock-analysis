/**
 * Smoke test for the market data layer (Module 1).
 * Run: npx ts-node scripts/testMarketData.ts
 *
 * - resolves "reliance" and "tata motors" (universe-first resolution)
 * - fetches a live quote for RELIANCE.NS (Yahoo chart meta)
 * - fetches 1y of daily bars for RELIANCE.NS (DB-cached in stock_history)
 */

import "reflect-metadata";
import { AppDataSource } from "../src/config/database";
import { marketDataService } from "../src/services/market/MarketDataService";

async function main(): Promise<void> {
  await AppDataSource.initialize();
  console.log("✓ Database connected");

  const reliance = await marketDataService.resolve("reliance");
  console.log('resolve("reliance")    →', reliance);
  if (!reliance || reliance.ticker !== "RELIANCE.NS") {
    throw new Error('resolve("reliance") did not return RELIANCE.NS');
  }

  const tataMotors = await marketDataService.resolve("tata motors");
  console.log('resolve("tata motors") →', tataMotors);
  if (!tataMotors || !/\.(NS|BO)$/.test(tataMotors.ticker)) {
    throw new Error('resolve("tata motors") did not return an Indian ticker');
  }

  const quote = await marketDataService.getQuote("RELIANCE.NS");
  console.log(
    `quote: ${quote.ticker} (${reliance.name}) price=₹${quote.price} ` +
      `prevClose=₹${quote.previousClose} change=${quote.changePercent.toFixed(2)}% ` +
      `currency=${quote.currency} asOf=${quote.asOf}`
  );
  if (quote.currency !== "INR") {
    throw new Error(`expected INR quote, got ${quote.currency}`);
  }

  const bars = await marketDataService.getDailyBars("RELIANCE.NS", "1y");
  if (bars.length === 0) throw new Error("no 1y bars for RELIANCE.NS");
  console.log(`bars (1y): count=${bars.length}`);
  console.log("first bar:", bars[0]);
  console.log("last bar: ", bars[bars.length - 1]);

  // Second call should now be served from the stock_history DB cache.
  const cachedBars = await marketDataService.getDailyBars("RELIANCE.NS", "1y");
  console.log(
    `bars (1y, second call — DB cache): count=${cachedBars.length}, ` +
      `last=${cachedBars[cachedBars.length - 1].date}`
  );

  await AppDataSource.destroy();
  console.log("✓ testMarketData passed");
}

main().catch((err) => {
  console.error("✗ testMarketData FAILED:", err);
  process.exitCode = 1;
});
