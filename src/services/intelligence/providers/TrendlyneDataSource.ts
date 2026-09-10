import * as cheerio from "cheerio";
import { ResilientHttpClient } from "../http";
import { SourceRef } from "../types";
import { FundamentalsProvider, ProviderResult, ScrapedRatios } from "./fundamentalsTypes";
import { parseScreenerNumber } from "./ScreenerDataSource";

/**
 * Trendlyne provider (FALLBACK 1). BEST-EFFORT: Trendlyne's public pages are
 * label→value cards; we match on visible labels so a layout change degrades
 * to {} rather than a wrong value (the whole point of the fallback chain).
 * fetch() never throws. Requires the Trendlyne slug, which we cannot resolve
 * from the NSE symbol alone without their search — so absent a configured slug
 * map this returns {} (honest). Enable per-ticker via TRENDLYNE_SLUGS env
 * ("RELIANCE=reliance-industries-ltd-RELI,...").
 */
const HOST = "trendlyne.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36";

const LABELS: Array<{ re: RegExp; key: keyof ScrapedRatios }> = [
  { re: /\bPE Ratio\b|\bP\/E\b/i, key: "peRatio" },
  { re: /\bROE\b/i, key: "roe" },
  { re: /\bROCE\b/i, key: "roce" },
  { re: /\bBook Value\b/i, key: "bookValue" },
  { re: /\bDividend Yield\b/i, key: "dividendYield" },
  { re: /\bMarket Cap\b/i, key: "marketCap" },
  { re: /\bCurrent Ratio\b/i, key: "currentRatio" },
  { re: /\bDebt.?to.?Equity\b/i, key: "debtToEquity" },
  { re: /\bPromoter\b.*\bHolding\b/i, key: "promoterHolding" },
];

export class TrendlyneDataSource implements FundamentalsProvider {
  readonly name = "TRENDLYNE";
  private readonly http = new ResilientHttpClient([HOST], 700, 20_000);

  private slug(ticker: string): string | null {
    const sym = ticker.trim().toUpperCase().replace(/\.(NS|BO)$/i, "");
    const map = (process.env.TRENDLYNE_SLUGS ?? "").split(",").map((c) => c.trim()).filter(Boolean);
    for (const entry of map) {
      const [k, v] = entry.split("=");
      if (k?.trim().toUpperCase() === sym && v) return v.trim();
    }
    return null;
  }

  async fetch(ticker: string): Promise<ProviderResult> {
    const slug = this.slug(ticker);
    const source: SourceRef = { provider: "Trendlyne", sourceLevel: 4, url: "https://trendlyne.com/", document: "equity fundamentals" };
    if (!slug) return { values: {}, source }; // no slug configured — skip honestly
    try {
      const url = `https://trendlyne.com/equity/${slug}/`;
      source.url = url;
      const html = (await this.http.getText(url, { headers: { "User-Agent": UA, Accept: "text/html" } })).data;
      const $ = cheerio.load(html);
      const values: Partial<ScrapedRatios> = {};
      // Generic label/value scan over common card + table structures.
      $("tr, li, .fundamental-item, .metric").each((_, el) => {
        const text = $(el).text().replace(/\s+/g, " ").trim();
        for (const { re, key } of LABELS) {
          if (values[key] != null || !re.test(text)) continue;
          const m = text.match(/(-?\d[\d,]*\.?\d*)\s*%?/);
          const n = m ? parseScreenerNumber(m[1]) : null;
          if (n != null) values[key] = n;
        }
      });
      return { values, source };
    } catch {
      return { values: {}, source };
    }
  }
}
