/**
 * AnnouncementIngestService — Milestone 3: universe-wide corporate
 * announcements and the forthcoming results calendar from NSE's bulk
 * endpoints (cookie bootstrap, no key), written point-in-time into
 * structured_market_events:
 *   - announcements: announcedAt = the exchange's publication timestamp
 *   - calendar rows: eventDate = the scheduled meeting date, announcedAt = when WE observed it
 * Symbols are mapped through the security master; unknown symbols are counted,
 * never guessed. Every run is recorded in universe_sync_runs.
 */

import { AppDataSource } from "../../config/database";
import { StructuredMarketEvent, UniverseSyncRun } from "../../entities";
import { classifyHeadline } from "../market/EventService";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const NSE = "https://www.nseindia.com";
export const BULK_ANNOUNCEMENTS_SOURCE = "nse-bulk-announcements";
export const EVENT_CALENDAR_SOURCE = "nse-event-calendar";

export interface ParsedAnnouncement {
  symbol: string;
  headline: string;
  announcedAt: Date;
  url: string | null;
  eventType: string;
}
export interface ParsedCalendarRow {
  symbol: string;
  purpose: string;
  meetingDate: string; // YYYY-MM-DD
  eventType: "results_calendar" | "board_meeting";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "08-Oct-2026 17:03:46" (IST) → Date; "09-Oct-2026" → YYYY-MM-DD. */
export function parseNseStamp(s: string | undefined): Date | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d{2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?$/);
  if (!m) return null;
  const mon = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
  if (mon < 0) return null;
  const iso = `${m[3]}-${String(mon + 1).padStart(2, "0")}-${m[1]}T${m[4] ?? "00"}:${m[5] ?? "00"}:${m[6] ?? "00"}+05:30`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseBulkAnnouncements(rows: unknown): ParsedAnnouncement[] {
  if (!Array.isArray(rows)) return [];
  const out: ParsedAnnouncement[] = [];
  for (const raw of rows as Array<Record<string, unknown>>) {
    const symbol = typeof raw.symbol === "string" && raw.symbol.trim() ? raw.symbol.trim().toUpperCase() : null;
    const desc = String(raw.desc ?? raw.subject ?? "").trim();
    const announcedAt = parseNseStamp(String(raw.an_dt ?? raw.exchdisstime ?? ""));
    if (!symbol || !desc || !announcedAt) continue;
    const text = String(raw.attchmntText ?? "").trim();
    out.push({
      symbol,
      headline: (text || desc).slice(0, 500),
      announcedAt,
      url: typeof raw.attchmntFile === "string" && raw.attchmntFile.startsWith("http") ? raw.attchmntFile : null,
      eventType: classifyHeadline(`${desc} ${text}`) ?? "other",
    });
  }
  return out;
}

/** "09-Oct-2026" → "2026-10-09" (the IST calendar date itself — never shifted through UTC). */
export function parseNseDateOnly(s: string | undefined): string | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d{2})-([A-Za-z]{3})-(\d{4})/);
  if (!m) return null;
  const mon = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
  return mon < 0 ? null : `${m[3]}-${String(mon + 1).padStart(2, "0")}-${m[1]}`;
}

export function parseEventCalendar(rows: unknown): ParsedCalendarRow[] {
  if (!Array.isArray(rows)) return [];
  const out: ParsedCalendarRow[] = [];
  for (const raw of rows as Array<Record<string, unknown>>) {
    const symbol = typeof raw.symbol === "string" && raw.symbol.trim() ? raw.symbol.trim().toUpperCase() : null;
    const purpose = String(raw.purpose ?? "").trim();
    const meetingDate = parseNseDateOnly(String(raw.date ?? ""));
    if (!symbol || !purpose || !meetingDate) continue;
    out.push({
      symbol,
      purpose: purpose.slice(0, 300),
      meetingDate,
      eventType: /result/i.test(purpose) ? "results_calendar" : "board_meeting",
    });
  }
  return out;
}

export class AnnouncementIngestService {
  private async json(path: string, referer: string): Promise<unknown> {
    const boot = await fetch(`${NSE}/`, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(25_000) });
    const cookie = (boot.headers.get("set-cookie") ?? "").split(/,(?=\s*\w+=)/).map((c) => c.split(";")[0]).join("; ");
    const res = await fetch(`${NSE}${path}`, { headers: { "User-Agent": UA, Accept: "application/json", Referer: `${NSE}${referer}`, Cookie: cookie }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return res.json();
  }

  /** Ingest the last `daysBack` days of announcements plus the forthcoming calendar. Idempotent (ON CONFLICT DO NOTHING). */
  async sync(daysBack = 3): Promise<Record<string, unknown>> {
    const runRepo = AppDataSource.getRepository(UniverseSyncRun);
    const run = await runRepo.save(runRepo.create({ job: "syncAnnouncements", source: "nse-bulk", status: "running", counts: {} }));
    try {
      const fmt = (d: Date) => {
        const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric" }).formatToParts(d);
        const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
        return `${g("day")}-${g("month")}-${g("year")}`;
      };
      const now = new Date();
      const from = new Date(now.getTime() - daysBack * 86_400_000);
      const master: Array<{ symbol: string; yahoo_ticker: string }> = await AppDataSource.query(`SELECT symbol, yahoo_ticker FROM security_master`);
      const yahooBy = new Map(master.map((m) => [m.symbol, m.yahoo_ticker]));

      const annRaw = await this.json(`/api/corporate-announcements?index=equities&from_date=${fmt(from)}&to_date=${fmt(now)}`, "/companies-listing/corporate-filings-announcements").catch((e) => {
        throw new Error(`announcements: ${e instanceof Error ? e.message : e}`);
      });
      const announcements = parseBulkAnnouncements(annRaw);
      let calendar: ParsedCalendarRow[] = [];
      let calendarError: string | null = null;
      try {
        calendar = parseEventCalendar(await this.json(`/api/event-calendar?index=equities`, "/companies-listing/corporate-filings-event-calendar"));
      } catch (e) {
        calendarError = e instanceof Error ? e.message : String(e);
      }

      const repo = AppDataSource.getRepository(StructuredMarketEvent);
      let inserted = 0;
      let unknownSymbols = 0;
      const insert = async (rows: Array<Partial<StructuredMarketEvent>>) => {
        for (let k = 0; k < rows.length; k += 200) {
          const chunk = rows.slice(k, k + 200);
          const r = await repo.createQueryBuilder().insert().values(chunk as never).orIgnore().execute();
          inserted += r.identifiers.filter(Boolean).length;
        }
      };
      const annRows: Array<Partial<StructuredMarketEvent>> = [];
      for (const a of announcements) {
        const yahoo = yahooBy.get(a.symbol);
        if (!yahoo) {
          unknownSymbols += 1;
          continue;
        }
        annRows.push({ ticker: yahoo, eventType: a.eventType, eventDate: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(a.announcedAt), announcedAt: a.announcedAt, source: BULK_ANNOUNCEMENTS_SOURCE, sourceTier: 1, headline: a.headline, url: a.url });
      }
      const calRows: Array<Partial<StructuredMarketEvent>> = [];
      for (const c of calendar) {
        const yahoo = yahooBy.get(c.symbol);
        if (!yahoo) {
          unknownSymbols += 1;
          continue;
        }
        calRows.push({ ticker: yahoo, eventType: c.eventType, eventDate: c.meetingDate, announcedAt: now, source: EVENT_CALENDAR_SOURCE, sourceTier: 1, headline: c.purpose, url: null });
      }
      await insert(annRows);
      await insert(calRows);
      const counts = { announcementsFetched: announcements.length, calendarFetched: calendar.length, inserted, unknownSymbols, daysBack, calendarError };
      run.status = "success";
      run.finishedAt = new Date();
      run.counts = counts;
      await runRepo.save(run);
      return counts;
    } catch (err) {
      run.status = "failed";
      run.finishedAt = new Date();
      run.error = (err instanceof Error ? err.message : String(err)).slice(0, 4000);
      await runRepo.save(run);
      throw err;
    }
  }
}

export const announcementIngestService = new AnnouncementIngestService();
