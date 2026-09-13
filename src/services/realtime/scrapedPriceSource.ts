/**
 * ScrapedPriceSource (reviewer priority 1) — a generic, config-driven PriceSource
 * for the V1 SCRAPED_SNAPSHOT mode. It knows nothing site-specific: the caller
 * supplies a URL builder + CSS selectors, and injects the HTTP getter. That
 * keeps it vendor-agnostic and unit-testable against fixture HTML — no live
 * network needed to prove the parsing/validation contract.
 *
 * The engine never sees this class; it only sees the normalized RawPriceQuote it
 * returns, which then passes through the same validation firewall as any feed.
 */

import * as cheerio from "cheerio";
import { PriceSource, RawPriceQuote, Security } from "./marketDataProvider";

/** Parse a scraped numeric cell: strips ₹, commas, %, whitespace. Returns null
 *  when there is no digit — so `Number("")===0` and "N/A" can NEVER masquerade
 *  as a real 0 (the trap that silently poisons indicators). */
export function parseScrapedNumber(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const cleaned = String(raw).replace(/[₹,%\s₹]/g, "").replace(/[^0-9.\-]/g, "");
  if (!cleaned || !/\d/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export interface ScrapeSelectorConfig {
  name: string;
  /** Build the page URL for a security (site-specific; supplied by the owner). */
  buildUrl: (security: Security) => string;
  selectors: {
    price: string;
    open?: string;
    dayHigh?: string;
    dayLow?: string;
    volume?: string;
    previousClose?: string;
    changePct?: string;
    /** Optional element carrying a machine-readable timestamp (else freshness is UNKNOWN). */
    sourceTimestamp?: string;
  };
  /** Parse a timestamp element's text/attr to ms epoch; default: none (unknown freshness). */
  parseTimestamp?: (text: string) => number | null;
}

export type HttpGet = (url: string) => Promise<string>;

export class ScrapedPriceSource implements PriceSource {
  readonly name: string;
  constructor(private readonly cfg: ScrapeSelectorConfig, private readonly httpGet: HttpGet, private readonly now: () => number = Date.now) {
    this.name = cfg.name;
  }

  async fetch(security: Security): Promise<RawPriceQuote> {
    const url = this.cfg.buildUrl(security);
    const html = await this.httpGet(url);
    const $ = cheerio.load(html);
    const num = (sel?: string): number | null => (sel ? parseScrapedNumber($(sel).first().text()) : null);

    let sourceTimestamp: number | null = null;
    if (this.cfg.selectors.sourceTimestamp && this.cfg.parseTimestamp) {
      const t = $(this.cfg.selectors.sourceTimestamp).first().text();
      sourceTimestamp = this.cfg.parseTimestamp(t);
    }

    return {
      source: this.name,
      sourceUrl: url,
      securityId: security.securityId,
      ticker: security.ticker,
      price: num(this.cfg.selectors.price),
      open: num(this.cfg.selectors.open),
      dayHigh: num(this.cfg.selectors.dayHigh),
      dayLow: num(this.cfg.selectors.dayLow),
      volume: num(this.cfg.selectors.volume),
      previousClose: num(this.cfg.selectors.previousClose),
      changePct: num(this.cfg.selectors.changePct),
      sourceTimestamp,
      fetchedAt: this.now(),
    };
  }
}
