/**
 * EventService (completion directive, Phase 9) — structured, point-in-time
 * market events with explicit source tiers.
 *
 * Source priority (spec): 1 NSE/BSE exchange filings · 2 company IR /
 * exchange-sourced data · 3 government · 4 reputable publications · 5 other.
 *
 * Ingestors implemented against sources this system genuinely has:
 *  - tier 1: NSE corporate-announcements API (cookie-bootstrapped; NSE
 *    aggressively rate-limits — failures are recorded, never faked),
 *  - tier 2: corporate actions (splits/dividends) already persisted on
 *    stock_history by the Phase 1 adjusted-data pipeline, and the Yahoo
 *    earnings calendar,
 *  - tier 4: NewsService headlines classified by a deterministic keyword
 *    rule set (order wins, regulatory, management changes, ratings, results).
 *
 * POINT-IN-TIME DISCIPLINE: announcedAt is set conservatively — never earlier
 * than the moment the fact was provably knowable to this system (ex-date for
 * corporate actions, publish time for news, fetch time for calendar rows).
 * assessEventRisk(ticker, asOf) only reads rows with announcedAt ≤ asOf, so
 * historical replays cannot see the future. No source ⇒ empty result with the
 * reason stated — absence of event data is reported, not invented.
 */

import axios from "axios";
import { QueryDeepPartialEntity } from "typeorm/query-builder/QueryPartialEntity";
import { AppDataSource } from "../../config/database";
import { StructuredMarketEvent } from "../../entities";
import { fundamentalsService } from "./FundamentalsService";
import { newsService } from "./NewsService";

export const EVENT_ENGINE_VERSION = "event-engine-v1";

const NSE_BASE = "https://www.nseindia.com";
const NSE_TIMEOUT_MS = 8000;
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

export interface EventRiskAssessment {
  version: string;
  asOf: string;
  upcomingEventRisk: boolean;
  reasons: string[];
  /** Events visible at asOf that drove the assessment (≤10, newest first). */
  events: Array<{
    eventType: string;
    eventDate: string;
    sourceTier: number;
    source: string;
    headline: string | null;
  }>;
}

interface IngestReport {
  source: string;
  inserted: number;
  skipped: number;
  error: string | null;
}

/** Deterministic tier-4 headline classifier — keyword rules, no AI, no scores. */
export function classifyHeadline(headline: string): string | null {
  const h = headline.toLowerCase();
  if (/\b(order|contract|loi|letter of intent)\b/.test(h) && /\b(win|wins|won|bag|bags|bagged|secures?|received?|awarded)\b/.test(h))
    return "order_win";
  if (/\b(sebi|rbi|cci|nclt|penalty|fine|show cause|investigation|probe)\b/.test(h)) return "regulatory";
  if (/\b(resign|resigns|resignation|appoints?|appointed|new (ceo|cfo|md|chairman)|steps down)\b/.test(h))
    return "management_change";
  if (/\b(lawsuit|litigation|court|tribunal|arbitration)\b/.test(h)) return "litigation";
  if (/\b(upgrade[ds]?|downgrade[ds]?|rating|target price)\b/.test(h)) return "rating_change";
  if (/\b(q[1-4]\s*(fy)?\d*\s*results?|quarterly results?|earnings|net profit (rises?|falls?|jumps?|drops?))\b/.test(h))
    return "results";
  return null;
}

export class EventService {
  private base(ticker: string): string {
    return ticker.trim().toUpperCase().replace(/\.(NS|BO)$/i, "");
  }

  /** Insert-or-skip on the (ticker, type, date, source) dedupe key. */
  private async upsert(rows: Array<Partial<StructuredMarketEvent>>): Promise<{ inserted: number; skipped: number }> {
    if (rows.length === 0) return { inserted: 0, skipped: 0 };
    const repo = AppDataSource.getRepository(StructuredMarketEvent);
    let inserted = 0;
    let skipped = 0;
    for (const row of rows) {
      const res = await repo
        .createQueryBuilder()
        .insert()
        .values(row as unknown as QueryDeepPartialEntity<StructuredMarketEvent>)
        .orIgnore() // ON CONFLICT DO NOTHING over uq_sme_dedupe
        .returning("id")
        .execute();
      // With orIgnore, PG RETURNING yields a row only when the insert happened.
      if (Array.isArray(res.raw) && res.raw.length > 0) inserted++;
      else skipped++;
    }
    return { inserted, skipped };
  }

  /** Tier 2: splits/dividends persisted on stock_history by the Phase 1 pipeline. */
  async ingestCorporateActions(ticker: string): Promise<IngestReport> {
    const source = "yahoo-corporate-actions";
    try {
      const yahooTicker = /\.(NS|BO)$/i.test(ticker.trim()) ? ticker.trim().toUpperCase() : `${this.base(ticker)}.NS`;
      const rows: Array<{ date: string; split_factor: string | null; dividend: string | null }> =
        await AppDataSource.query(
          `SELECT to_char(h.trading_date, 'YYYY-MM-DD') AS date, h.split_factor, h.dividend
             FROM stock_history h JOIN stocks s ON s.id = h.stock_id
            WHERE s.ticker = $1 AND (h.split_factor IS NOT NULL OR h.dividend IS NOT NULL)
            ORDER BY h.trading_date`,
          [yahooTicker]
        );
      const events: Array<Partial<StructuredMarketEvent>> = [];
      for (const r of rows) {
        // announcedAt = ex-date market open: conservative — the company announced
        // earlier, but this system cannot prove when, so it never claims earlier.
        const announcedAt = new Date(`${r.date}T09:15:00+05:30`);
        if (r.split_factor != null) {
          events.push({
            ticker: this.base(ticker),
            eventType: "split",
            eventDate: r.date,
            announcedAt,
            source,
            sourceTier: 2,
            headline: `Split factor ${r.split_factor} effective ${r.date}`,
            payload: { splitFactor: Number(r.split_factor) },
          });
        }
        if (r.dividend != null) {
          events.push({
            ticker: this.base(ticker),
            eventType: "dividend",
            eventDate: r.date,
            announcedAt,
            source,
            sourceTier: 2,
            headline: `Dividend ₹${r.dividend}/share, ex-date ${r.date}`,
            payload: { amount: Number(r.dividend) },
          });
        }
      }
      const { inserted, skipped } = await this.upsert(events);
      return { source, inserted, skipped, error: null };
    } catch (e) {
      return { source, inserted: 0, skipped: 0, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Tier 2: next earnings date from the Yahoo calendar (announcedAt = fetch time). */
  async ingestEarningsCalendar(ticker: string): Promise<IngestReport> {
    const source = "yahoo-earnings-calendar";
    try {
      const f = await fundamentalsService.getFundamentals(ticker);
      if (!f.nextEarningsDate) return { source, inserted: 0, skipped: 0, error: null };
      const { inserted, skipped } = await this.upsert([
        {
          ticker: this.base(ticker),
          eventType: "earnings",
          eventDate: f.nextEarningsDate,
          announcedAt: new Date(), // knowable to this system from the fetch onward
          source,
          sourceTier: 2,
          headline: `Earnings scheduled ${f.nextEarningsDate}`,
        },
      ]);
      return { source, inserted, skipped, error: null };
    } catch (e) {
      return { source, inserted: 0, skipped: 0, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Tier 4: classified news headlines (announcedAt = publish time). Reads the
   * CACHED news summary only — this ingestor must never add fetch load; no
   * cache means zero rows, honestly reported.
   */
  async ingestClassifiedNews(ticker: string): Promise<IngestReport> {
    const source = "news-classified";
    try {
      const news = newsService.getCachedNews(ticker);
      if (!news) return { source, inserted: 0, skipped: 0, error: null };
      const events: Array<Partial<StructuredMarketEvent>> = [];
      for (const item of news.items) {
        const type = classifyHeadline(item.title);
        if (!type) continue;
        const published = new Date(item.publishedAt);
        if (Number.isNaN(published.getTime())) continue;
        events.push({
          ticker: this.base(ticker),
          eventType: type,
          eventDate: published.toISOString().slice(0, 10),
          announcedAt: published,
          source,
          sourceTier: 4,
          headline: item.title.slice(0, 500),
          url: item.url ?? null,
        });
      }
      const { inserted, skipped } = await this.upsert(events);
      return { source, inserted, skipped, error: null };
    } catch (e) {
      return { source, inserted: 0, skipped: 0, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Tier 1: NSE corporate announcements. NSE requires a browser-like cookie
   * bootstrap and rate-limits aggressively — a failure here is RECORDED and
   * the engine proceeds on lower tiers; it never fabricates tier-1 rows.
   */
  async ingestNseAnnouncements(ticker: string): Promise<IngestReport> {
    const source = "nse-corporate-announcements";
    const symbol = this.base(ticker);
    try {
      const boot = await axios.get(NSE_BASE, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
        timeout: NSE_TIMEOUT_MS,
      });
      const cookies = (boot.headers["set-cookie"] ?? []).map((c: string) => c.split(";")[0]).join("; ");
      const res = await axios.get(
        `${NSE_BASE}/api/corporate-announcements?index=equities&symbol=${encodeURIComponent(symbol)}`,
        {
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "application/json",
            Referer: `${NSE_BASE}/companies-listing/corporate-filings-announcements`,
            Cookie: cookies,
          },
          timeout: NSE_TIMEOUT_MS,
        }
      );
      const rows: Array<Record<string, unknown>> = Array.isArray(res.data) ? res.data : [];
      const events: Array<Partial<StructuredMarketEvent>> = [];
      for (const r of rows.slice(0, 50)) {
        const desc = String(r.desc ?? r.subject ?? "").trim();
        const anDt = String(r.an_dt ?? r.exchdisstime ?? "").trim(); // "DD-MMM-YYYY HH:mm:ss"
        const announcedAt = anDt ? new Date(anDt.replace(/-/g, " ") + " GMT+0530") : null;
        if (!desc || !announcedAt || Number.isNaN(announcedAt.getTime())) continue;
        events.push({
          ticker: symbol,
          eventType: classifyHeadline(desc) ?? "other",
          eventDate: announcedAt.toISOString().slice(0, 10),
          announcedAt,
          source,
          sourceTier: 1,
          headline: desc.slice(0, 500),
          url: typeof r.attchmntFile === "string" ? r.attchmntFile : null,
        });
      }
      const { inserted, skipped } = await this.upsert(events);
      return { source, inserted, skipped, error: null };
    } catch (e) {
      return { source, inserted: 0, skipped: 0, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Run every ingestor; failures are per-source and reported, never hidden. */
  async ingestAll(ticker: string): Promise<IngestReport[]> {
    return [
      await this.ingestNseAnnouncements(ticker),
      await this.ingestCorporateActions(ticker),
      await this.ingestEarningsCalendar(ticker),
      await this.ingestClassifiedNews(ticker),
    ];
  }

  /**
   * Point-in-time event risk at asOf: only rows with announcedAt ≤ asOf.
   *  - earnings within the next 7 calendar days ⇒ high event risk;
   *  - tier ≤ 2 corporate action (split) effective within ±3 days ⇒ high;
   *  - tier ≤ 4 regulatory/litigation published in the last 3 days ⇒ high.
   */
  async assessEventRisk(ticker: string, asOf: Date): Promise<EventRiskAssessment> {
    const symbol = this.base(ticker);
    const rows: StructuredMarketEvent[] = await AppDataSource.getRepository(StructuredMarketEvent)
      .createQueryBuilder("e")
      .where("e.ticker = :symbol", { symbol })
      .andWhere("e.announced_at <= :asOf", { asOf })
      .orderBy("e.announced_at", "DESC")
      .limit(200)
      .getMany();

    const asOfDate = asOf.toISOString().slice(0, 10);
    const plus7 = new Date(asOf.getTime() + 7 * 86400_000).toISOString().slice(0, 10);
    const minus3 = new Date(asOf.getTime() - 3 * 86400_000).toISOString().slice(0, 10);
    const plus3 = new Date(asOf.getTime() + 3 * 86400_000).toISOString().slice(0, 10);

    const reasons: string[] = [];
    for (const e of rows) {
      if (e.eventType === "earnings" && e.eventDate >= asOfDate && e.eventDate <= plus7) {
        reasons.push(`earnings scheduled ${e.eventDate} (within 7 days; ${e.source})`);
      }
      if (e.eventType === "split" && e.sourceTier <= 2 && e.eventDate >= minus3 && e.eventDate <= plus3) {
        reasons.push(`split effective ${e.eventDate} (±3 days; ${e.source})`);
      }
      if (
        (e.eventType === "regulatory" || e.eventType === "litigation") &&
        e.eventDate >= minus3 &&
        e.eventDate <= asOfDate
      ) {
        reasons.push(`${e.eventType} event ${e.eventDate}: ${e.headline?.slice(0, 80) ?? ""} (${e.source})`);
      }
    }

    return {
      version: EVENT_ENGINE_VERSION,
      asOf: asOf.toISOString(),
      upcomingEventRisk: reasons.length > 0,
      reasons: reasons.slice(0, 5),
      events: rows.slice(0, 10).map((e) => ({
        eventType: e.eventType,
        eventDate: e.eventDate,
        sourceTier: e.sourceTier,
        source: e.source,
        headline: e.headline ?? null,
      })),
    };
  }
}

export const eventService = new EventService();
