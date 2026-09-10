import * as cheerio from "cheerio";
import { ResilientHttpClient } from "../http";
import { MetricResult, SourceRef } from "../types";

/**
 * Screener.in scraper (private-use data source) — fills the fundamentals panel
 * for stocks Yahoo/XBRL leave blank (esp. Indian micro-caps). Returns
 * MetricResult[] tagged status "SCRAPED", methodology "SCRAPED_SCREENER", with
 * the source URL — so provenance is explicit on the panel.
 *
 * INTEGRITY FIREWALL: these are CURRENT-SNAPSHOT values with no historical
 * as-of series. They populate the live panel + live scorecard only. They are
 * NEVER written to `financial_facts` (the point-in-time XBRL store the
 * walk-forward research reads), so backtests cannot be contaminated by a
 * present-day scrape.
 */
const SCREENER_HOST = "screener.in";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

/** Screener label → our canonical metric key + unit. */
const TOP_RATIO_MAP: Record<string, { metric: string; unit: string }> = {
  "Stock P/E": { metric: "pe_ratio", unit: "x" },
  "ROE": { metric: "roe", unit: "percent" },
  "ROCE": { metric: "roce", unit: "percent" },
  "Book Value": { metric: "book_value", unit: "inr" },
  "Dividend Yield": { metric: "dividend_yield", unit: "percent" },
  "Market Cap": { metric: "market_cap", unit: "inr_cr" },
  "Face Value": { metric: "face_value", unit: "inr" },
  "Current Price": { metric: "current_price", unit: "inr" },
};
/** Labels found in the "Ratios" / other section tables. */
const TABLE_RATIO_MAP: Record<string, { metric: string; unit: string }> = {
  "Debt to equity": { metric: "debt_to_equity", unit: "x" },
  "Current ratio": { metric: "current_ratio", unit: "x" },
  "Price to book value": { metric: "price_to_book", unit: "x" },
  "Promoter holding": { metric: "promoter_holding", unit: "percent" },
  "OPM": { metric: "operating_margin", unit: "percent" },
};

/** Parse a Screener number string ("₹ 1,234 Cr.", "32.5", "15.3 %", "1.2") → number|null. */
export function parseScreenerNumber(raw: string): number | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/₹|,|%|x|Cr\.?|Crores?|Rs\.?/gi, "")
    .replace(/[^\d.\-]/g, " ")
    .trim()
    .split(/\s+/)[0];
  // Guard the Number("") === 0 trap: require at least one digit.
  if (!cleaned || !/\d/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export class ScreenerDataSource {
  readonly name = "SCREENER";
  private readonly http = new ResilientHttpClient([SCREENER_HOST], 600, 20_000);

  private symbol(ticker: string): string {
    return ticker.trim().toUpperCase().replace(/\.(NS|BO)$/i, "");
  }

  /** Scrape the company page; consolidated first, standalone fallback. */
  async fetchRatios(ticker: string): Promise<MetricResult[]> {
    const symbol = this.symbol(ticker);
    const source: SourceRef = { provider: "Screener.in", sourceLevel: 4, url: `https://www.screener.in/company/${symbol}/`, document: "company ratios page" };
    let html: string | null = null;
    for (const path of [`/company/${symbol}/consolidated/`, `/company/${symbol}/`]) {
      try {
        html = (await this.http.getText(`https://www.screener.in${path}`, { headers: { "User-Agent": UA, Accept: "text/html" } })).data;
        source.url = `https://www.screener.in${path}`;
        if (html && html.includes("top-ratios")) break;
      } catch {
        html = null;
      }
    }
    if (!html) return [];

    const $ = cheerio.load(html);
    const at = new Date().toISOString();
    const results: MetricResult[] = [];
    const push = (label: string, map: { metric: string; unit: string }, raw: string) => {
      const value = parseScreenerNumber(raw);
      if (value == null) return;
      results.push({
        metric: map.metric,
        value,
        period: at.slice(0, 10),
        formula: `scraped from Screener.in "${label}"`,
        inputs: { raw: raw.trim(), unit: map.unit },
        methodology: "SCRAPED_SCREENER",
        sources: [source],
        status: "SCRAPED",
        confidence: "MEDIUM", // third-party aggregator, not primary filing
        reason: "current-snapshot value scraped for the live panel; NOT point-in-time, never used in backtests",
        calculatedAt: at,
      });
    };

    // Top-ratios card: <li><span class="name">ROE</span><span class="value">…</span></li>
    $("#top-ratios li").each((_, el) => {
      const name = $(el).find(".name").first().text().trim();
      const value = $(el).find(".value").first().text().replace(/\s+/g, " ").trim();
      const map = TOP_RATIO_MAP[name];
      if (map && value) push(name, map, value);
    });

    // Section tables (Ratios etc.): rows "Label   v1 v2 … latest"
    $("table.data-table tr, section table tr").each((_, tr) => {
      const cells = $(tr).find("td");
      if (cells.length < 2) return;
      const label = $(cells[0]).text().replace(/\s+/g, " ").trim();
      const map = TABLE_RATIO_MAP[label];
      if (!map) return;
      const last = $(cells[cells.length - 1]).text().replace(/\s+/g, " ").trim();
      if (last) push(label, map, last);
    });

    // Dedupe by metric (first occurrence wins — top-ratios preferred).
    const seen = new Set<string>();
    return results.filter((r) => (seen.has(r.metric) ? false : (seen.add(r.metric), true)));
  }
}

export const screenerDataSource = new ScreenerDataSource();
