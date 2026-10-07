/**
 * RegimeService — fetches the benchmark's bars and classifies the market
 * regime. Memory-cached (the regime does not change intraday). NIFTY is the
 * default scope; the pure classifier is reused unchanged for any index.
 */

import { marketDataService } from "../market/MarketDataService";
import { classifyRegime, RegimeAssessment } from "./regime";

const CACHE_TTL_MS = 60 * 60 * 1000; // 1h — a regime is a slow-moving description

export class RegimeService {
  private cache: { at: number; value: RegimeAssessment } | null = null;

  async detect(): Promise<RegimeAssessment> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.value;
    try {
      const bars = await marketDataService.getNiftyBars("2y");
      const value = classifyRegime(bars);
      this.cache = { at: Date.now(), value };
      return value;
    } catch {
      // Never throw — an unknown regime defaults to CHOPPY (the neutral, most
      // conservative state) so callers always get a usable answer.
      return {
        version: "regime-v1",
        regime: "CHOPPY",
        reasons: ["benchmark bars unavailable — defaulting to CHOPPY"],
        trendScore: 0,
        realizedVolPct: null,
        drawdownPct: null,
        sampleBars: 0,
      };
    }
  }
}

export const regimeService = new RegimeService();
