import * as cheerio from "cheerio";
import { ResilientHttpClient } from "../http";
import { SourceRef } from "../types";
import { FundamentalsProvider, ProviderResult, ScrapedRatios } from "./fundamentalsTypes";

/**
 * Screener.in provider (PRIMARY in the fallback chain) — private-use scraper
 * that fills the fundamentals panel for stocks Yahoo/XBRL leave blank.
 *
 * INTEGRITY FIREWALL (unchanged): current-snapshot values → live panel/
 * scorecard only, never `financial_facts` (the PIT store backtests read).
 * fetch() NEVER throws — returns {} on any failure so the chain can fall
 * through to the next source.
 */
const SCREENER_HOST = "screener.in";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

const TOP_RATIO_MAP: Record<string, keyof ScrapedRatios> = {
  "Stock P/E": "peRatio",
  "ROE": "roe",
  "ROCE": "roce",
  "Book Value": "bookValue",
  "Dividend Yield": "dividendYield",
  "Market Cap": "marketCap",
  "Face Value": "faceValue",
  "Current Price": "currentPrice",
};
const TABLE_RATIO_MAP: Record<string, keyof ScrapedRatios> = {
  "Debt to equity": "debtToEquity",
  "Current ratio": "currentRatio",
  "Price to book value": "priceToBook",
};

/** Parse a Screener number string ("₹ 1,234 Cr.", "32.5", "15.3 %") → number|null. */
export function parseScreenerNumber(raw: string): number | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/₹|,|%|x|Cr\.?|Crores?|Rs\.?/gi, "")
    .replace(/[^\d.\-]/g, " ")
    .trim()
    .split(/\s+/)[0];
  if (!cleaned || !/\d/.test(cleaned)) return null; // guard Number("")===0
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** YoY % from the last cell vs the cell 4 quarters earlier of a numeric row. */
export function yoyFromRow(cells: number[]): number | null {
  if (cells.length < 5) return null;
  const latest = cells[cells.length - 1];
  const yearAgo = cells[cells.length - 5];
  if (yearAgo === 0 || !Number.isFinite(yearAgo) || !Number.isFinite(latest)) return null;
  return Math.round(((latest - yearAgo) / Math.abs(yearAgo)) * 1000) / 10;
}

export class ScreenerDataSource implements FundamentalsProvider {
  readonly name = "SCREENER";
  private readonly http = new ResilientHttpClient([SCREENER_HOST], 600, 20_000);

  private symbol(ticker: string): string {
    return ticker.trim().toUpperCase().replace(/\.(NS|BO)$/i, "");
  }

  async fetch(ticker: string): Promise<ProviderResult> {
    const symbol = this.symbol(ticker);
    const source: SourceRef = { provider: "Screener.in", sourceLevel: 4, url: `https://www.screener.in/company/${symbol}/`, document: "company page" };
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
    if (!html) return { values: {}, source };

    const $ = cheerio.load(html);
    const values: Partial<ScrapedRatios> = {};

    // Top-ratios card.
    $("#top-ratios li").each((_, el) => {
      const name = $(el).find(".name").first().text().trim();
      const raw = $(el).find(".value").first().text().replace(/\s+/g, " ").trim();
      const key = TOP_RATIO_MAP[name];
      const n = parseScreenerNumber(raw);
      if (key && n != null) values[key] = n;
    });

    // Section tables: Ratios (debt/equity, current ratio, price/book).
    $("section table tr, table.data-table tr").each((_, tr) => {
      const cells = $(tr).find("td");
      if (cells.length < 2) return;
      const label = $(cells[0]).text().replace(/\s+/g, " ").trim();
      const key = TABLE_RATIO_MAP[label];
      if (!key) return;
      const n = parseScreenerNumber($(cells[cells.length - 1]).text());
      if (n != null) values[key] = n;
    });

    // Widened: quarterly Net Profit YoY + OPM (from the Quarters section).
    const numericRow = (rootSel: string, rowLabel: string): number[] | null => {
      let found: number[] | null = null;
      $(`${rootSel} table tr`).each((_, tr) => {
        if (found) return;
        const cells = $(tr).find("td");
        if (cells.length < 2) return;
        const label = $(cells[0]).text().replace(/\s+/g, " ").replace(/[+\-]$/, "").trim();
        if (!new RegExp(`^${rowLabel}`, "i").test(label)) return;
        found = cells.slice(1).map((_i, c) => parseScreenerNumber($(c).text()) ?? NaN).get().filter((x) => Number.isFinite(x));
      });
      return found;
    };
    const netProfit = numericRow("#quarters", "Net Profit") ?? numericRow("#quarters", "Profit");
    if (netProfit) {
      const yoy = yoyFromRow(netProfit);
      if (yoy != null) values.quarterlyProfitGrowthYoY = yoy;
    }
    const opm = numericRow("#quarters", "OPM");
    if (opm && opm.length) values.operatingMargin = opm[opm.length - 1];

    // Shareholding: Promoters latest + QoQ change.
    const promoters = numericRow("#shareholding", "Promoters");
    if (promoters && promoters.length) {
      values.promoterHolding = promoters[promoters.length - 1];
      if (promoters.length >= 2) values.promoterHoldingChangeQoQ = Math.round((promoters[promoters.length - 1] - promoters[promoters.length - 2]) * 100) / 100;
    }

    return { values, source };
  }
}

export const screenerDataSource = new ScreenerDataSource();
