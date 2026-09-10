import { ResilientHttpClient } from "../http";
import { SourceRef } from "../types";
import { FundamentalsProvider, ProviderResult, ScrapedRatios } from "./fundamentalsTypes";

/**
 * Tickertape provider (FALLBACK 2). Tickertape renders fundamentals via a JSON
 * API behind its stock pages rather than static HTML, and needs the internal
 * security id. Without a configured id map (TICKERTAPE_IDS env
 * "RELIANCE=RELI,...") this returns {} honestly. When ids are supplied it hits
 * the public ratios endpoint and maps the known keys. Never throws.
 */
const HOST = "tickertape.in";

const KEY_MAP: Record<string, keyof ScrapedRatios> = {
  peRatio: "peRatio",
  pbRatio: "priceToBook",
  divYield: "dividendYield",
  roe: "roe",
  roce: "roce",
  currentRatio: "currentRatio",
  debtToEquity: "debtToEquity",
  marketCap: "marketCap",
};

export class TickertapeDataSource implements FundamentalsProvider {
  readonly name = "TICKERTAPE";
  private readonly http = new ResilientHttpClient([HOST], 700, 20_000);

  private secId(ticker: string): string | null {
    const sym = ticker.trim().toUpperCase().replace(/\.(NS|BO)$/i, "");
    const map = (process.env.TICKERTAPE_IDS ?? "").split(",").map((c) => c.trim()).filter(Boolean);
    for (const entry of map) {
      const [k, v] = entry.split("=");
      if (k?.trim().toUpperCase() === sym && v) return v.trim();
    }
    return null;
  }

  async fetch(ticker: string): Promise<ProviderResult> {
    const secId = this.secId(ticker);
    const source: SourceRef = { provider: "Tickertape", sourceLevel: 4, url: "https://www.tickertape.in/", document: "ratios API" };
    if (!secId) return { values: {}, source };
    try {
      const url = `https://api.tickertape.in/stocks/financials/ratio/${encodeURIComponent(secId)}`;
      source.url = url;
      const res = await this.http.getJson<{ data?: Record<string, unknown> }>(url);
      const data = (res.data?.data ?? {}) as Record<string, unknown>;
      const values: Partial<ScrapedRatios> = {};
      for (const [srcKey, key] of Object.entries(KEY_MAP)) {
        const v = data[srcKey];
        if (typeof v === "number" && Number.isFinite(v)) values[key] = v;
      }
      return { values, source };
    } catch {
      return { values: {}, source };
    }
  }
}
