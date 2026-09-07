/**
 * MarketDataService (Module 1) — Yahoo-Finance-first market data layer.
 *
 * - resolve()/search(): NSE_UNIVERSE first, then Yahoo search filtered to
 *   Indian exchanges only (.NS / .BO). Never returns a non-Indian ticker.
 * - getQuote(): chart-meta quote with a 5-minute in-memory cache.
 * - getDailyBars(): DB-cached daily bars in the existing stock_history table.
 *   Serves from DB when coverage is fresh (latest bar within 3 calendar days
 *   AND span covers the requested range), else fetches Yahoo, upserts
 *   (delete+insert per ticker/date-range — the table's unique key includes
 *   fetch_timestamp, so plain upsert on (stock_id, trading_date) is not
 *   possible), and serves the fresh bars.
 * - getNiftyBars(): ^NSEI in-memory cache (TTL 6h), never stored in the DB.
 * - seedUniverse(): throttled 2y backfill of the whole universe.
 *
 * NEVER fabricates data — on total unavailability it throws; stale (but real)
 * DB bars are served only as a fallback when Yahoo is unreachable.
 */

import { AppDataSource } from "../../config/database";
import { Stock } from "../../entities/Stock";
import { StockHistory } from "../../entities/StockHistory";
import { NSE_UNIVERSE, UniverseStock } from "../../data/nseUniverse";
import {
  fetchChart,
  fetchSearch,
  unixToISTDateString,
  YahooChartMeta,
  YahooSearchQuote,
} from "./yahoo";
import {
  Bar,
  BarsResult,
  DailyRange,
  Quote,
  ResolveResult,
  SearchSuggestion,
  SeedResult,
} from "./types";
import { QueryDeepPartialEntity } from "typeorm/query-builder/QueryPartialEntity";

/** Non-equity quote types this app's stock-analysis engine cannot handle. */
const NON_EQUITY_QUOTE_TYPES = new Set([
  "MUTUALFUND",
  "ETF",
  "INDEX",
  "CURRENCY",
  "CRYPTOCURRENCY",
  "FUTURE",
  "OPTION",
]);

/** Name patterns that flag a fund/index product even when Yahoo mistags quoteType as EQUITY. */
const NON_EQUITY_NAME_RE = /\b(mutual fund|index fund|etf|nifty\s*\d|sensex|liquid fund|debt fund)\b/i;

/**
 * This app analyzes individual NSE/BSE-listed STOCKS only (daily OHLC +
 * technicals + quoteSummary fundamentals). Mutual funds, ETFs and index
 * products are a different asset class (NAV-based, no meaningful RSI/PEG)
 * and are filtered out here rather than surfaced as a confusing "not enough
 * bars" error at analyze time.
 */
function isAnalyzableEquity(s: YahooSearchQuote): boolean {
  if (s.quoteType && NON_EQUITY_QUOTE_TYPES.has(s.quoteType.toUpperCase())) return false;
  const name = s.longname || s.shortname || "";
  if (NON_EQUITY_NAME_RE.test(name)) return false;
  return true;
}

const QUOTE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const RECENT_FETCH_ATTEMPT_TTL_MS = 30 * 60 * 1000; // holiday guard: retry Yahoo at most every 30 min
const NIFTY_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours (shared by all index caches)
const SEED_THROTTLE_MS = 350; // ≥300ms between bulk Yahoo fetches
const FRESHNESS_MAX_AGE_DAYS = 3; // latest DB bar must be within 3 calendar days
const SPAN_SLACK_DAYS = 15; // allowed gap at the start of the range
const INSERT_CHUNK_SIZE = 500;
const NIFTY_TICKER = "^NSEI";
const INDIA_VIX_TICKER = "^INDIAVIX"; // V10 B2 — memory-cached like NIFTY, never DB-stored
// NSE closes 15:30 IST; small buffer so the closing price has settled before
// we treat today's bar as final.
const MARKET_CLOSE_IST_MINUTES = 15 * 60 + 40;

const RANGE_CALENDAR_DAYS: Record<DailyRange, number> = {
  "3mo": 92,
  "6mo": 183,
  "1y": 366,
  "2y": 731,
  "5y": 1827,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Days between two YYYY-MM-DD strings (b - a). */
function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round(
    (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000
  );
}

/** Today's date (YYYY-MM-DD) in Asia/Kolkata. */
function istToday(): string {
  return unixToISTDateString(Date.now() / 1000);
}

/** YYYY-MM-DD in Asia/Kolkata, n calendar days ago. */
function istDaysAgo(n: number): string {
  return unixToISTDateString(Date.now() / 1000 - n * 86_400);
}

/** Minutes since midnight in Asia/Kolkata. */
function istMinutesNow(): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
  const [h, m] = parts.split(":").map(Number);
  return (h % 24) * 60 + m;
}

/**
 * During market hours Yahoo's last "daily" bar for today is the in-progress
 * session (close = last trade so far, not the final close). Persisting it
 * would permanently record a mid-session price as that day's close, so we
 * drop today's bar until the market has closed. Final bars are unaffected.
 */
function dropPartialTodayBar(bars: Bar[]): Bar[] {
  if (bars.length === 0) return bars;
  const last = bars[bars.length - 1];
  if (last.date !== istToday()) return bars;
  if (istMinutesNow() >= MARKET_CLOSE_IST_MINUTES) return bars;
  return bars.slice(0, -1);
}

interface RawHistoryRow {
  date: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export class MarketDataService {
  private quoteCache = new Map<string, { quote: Quote; fetchedAt: number }>();
  private niftyCache = new Map<string, { bars: Bar[]; fetchedAt: number }>();
  private dbInitPromise: Promise<void> | null = null;
  /** ticker → last Yahoo bars-fetch attempt (holiday guard; see getDailyBarsWithSource). */
  private recentBarFetchAttempts = new Map<string, number>();

  // ── Resolution & search ───────────────────────────────────────────────────

  /**
   * Resolve a free-text query (ticker or company name) to an Indian listing.
   * Universe first (ticker with/without .NS, then name match), then Yahoo
   * search filtered to NSE/BSE. Never returns a non-.NS/.BO ticker.
   */
  async resolve(query: string): Promise<ResolveResult | null> {
    const q = (query ?? "").trim();
    if (!q) return null;

    const universeHit = this.matchUniverse(q)[0];
    if (universeHit) {
      return {
        ticker: universeHit.ticker,
        name: universeHit.name,
        exchange: "NSE",
      };
    }

    const quotes = await fetchSearch(q);
    const indian = quotes
      .filter((s) => s.symbol.endsWith(".NS") || s.symbol.endsWith(".BO"))
      .filter((s) => isAnalyzableEquity(s));
    // Prefer NSE listings, then BSE; try each in order until one actually has
    // real daily history (Yahoo sometimes tags non-equity products — mutual
    // funds, index/derivative codes — as quoteType EQUITY with ~0 bars).
    const ordered = [
      ...indian.filter((s) => s.symbol.endsWith(".NS") || s.exchange === "NSI"),
      ...indian.filter((s) => !(s.symbol.endsWith(".NS") || s.exchange === "NSI")),
    ];
    for (const pick of ordered) {
      const hasHistory = await this.hasUsableHistory(pick.symbol);
      if (!hasHistory) continue;
      return {
        ticker: pick.symbol,
        name: pick.longname || pick.shortname || pick.symbol,
        exchange: pick.symbol.endsWith(".NS") ? "NSE" : "BSE",
      };
    }
    return null;
  }

  /** Quick sanity check: does this symbol have enough real daily bars to analyze? */
  private async hasUsableHistory(ticker: string): Promise<boolean> {
    try {
      const bars = await this.getDailyBars(ticker, "3mo");
      return bars.length >= 30;
    } catch {
      return false;
    }
  }

  /** Up to 8 suggestions: universe matches first, then Yahoo (India-only). */
  async search(query: string): Promise<SearchSuggestion[]> {
    const q = (query ?? "").trim();
    if (!q) return [];

    const suggestions: SearchSuggestion[] = [];
    const seen = new Set<string>();
    for (const u of this.matchUniverse(q)) {
      if (suggestions.length >= 8) break;
      if (seen.has(u.ticker)) continue;
      seen.add(u.ticker);
      suggestions.push({ ticker: u.ticker, name: u.name, exchange: "NSE" });
    }

    if (suggestions.length < 8) {
      try {
        const quotes = await fetchSearch(q);
        for (const s of quotes) {
          if (suggestions.length >= 8) break;
          const isNse = s.symbol.endsWith(".NS");
          const isBse = s.symbol.endsWith(".BO");
          if ((!isNse && !isBse) || seen.has(s.symbol) || !isAnalyzableEquity(s)) continue;
          seen.add(s.symbol);
          suggestions.push({
            ticker: s.symbol,
            name: s.longname || s.shortname || s.symbol,
            exchange: isNse ? "NSE" : "BSE",
          });
        }
      } catch (err) {
        // Suggestions are best-effort: if we already have universe matches,
        // a Yahoo outage should not break typeahead.
        if (suggestions.length === 0) throw err;
      }
    }
    return suggestions;
  }

  // ── Quotes ────────────────────────────────────────────────────────────────

  /** Live quote from chart meta. In-memory cache, TTL 5 minutes. */
  async getQuote(ticker: string): Promise<Quote> {
    const t = this.normalizeTicker(ticker);
    const cached = this.quoteCache.get(t);
    if (cached && Date.now() - cached.fetchedAt < QUOTE_CACHE_TTL_MS) {
      return cached.quote;
    }

    const { meta } = await fetchChart(t, "1d");
    // T3 fix (audit §6): when Yahoo omits both previous-close fields, the old
    // code silently used the live price and fabricated a 0.00% change. Fall
    // back to the last stored completed close (real data) first.
    const hasPrev =
      (typeof meta.previousClose === "number" && Number.isFinite(meta.previousClose)) ||
      (typeof meta.chartPreviousClose === "number" && Number.isFinite(meta.chartPreviousClose));
    let fallbackPrev: number | null = null;
    if (!hasPrev) {
      fallbackPrev = await this.lastStoredClose(t).catch(() => null);
    }
    const quote = this.quoteFromMeta(t, meta, fallbackPrev);
    this.quoteCache.set(t, { quote, fetchedAt: Date.now() });
    return quote;
  }

  /** Latest stored completed close for a ticker, or null. */
  private async lastStoredClose(ticker: string): Promise<number | null> {
    const row: Array<{ close: string }> = await AppDataSource.query(
      `SELECT h.close_price::text AS close
         FROM stock_history h JOIN stocks s ON s.id = h.stock_id
        WHERE s.ticker = $1 ORDER BY h.trading_date DESC LIMIT 1`,
      [ticker]
    );
    const v = row.length > 0 ? Number(row[0].close) : NaN;
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  // ── Daily bars (DB-cached) ────────────────────────────────────────────────

  /**
   * Daily bars for the requested range. Served from stock_history when
   * coverage is fresh enough, otherwise fetched from Yahoo and upserted.
   */
  async getDailyBars(ticker: string, range: DailyRange): Promise<Bar[]> {
    return (await this.getDailyBarsWithSource(ticker, range)).bars;
  }

  /**
   * Same as getDailyBars, but also reports where the bars came from:
   *  - "yahoo"    — a fresh Yahoo fetch happened on this call
   *  - "db-fresh" — served from the DB within the freshness window
   *  - "db-stale" — Yahoo failed and stale (but real) DB bars were served
   * Callers use this to throttle actual Yahoo hits and to surface degraded
   * data honestly (dataStatus) — never to fabricate anything.
   */
  async getDailyBarsWithSource(
    ticker: string,
    range: DailyRange
  ): Promise<BarsResult> {
    const t = this.normalizeTicker(ticker);
    if (t.startsWith("^")) {
      // Indices are never stored in the DB.
      const { bars } = await fetchChart(t, range);
      return { bars, source: "yahoo" };
    }

    await this.ensureDb();
    const rangeDays = RANGE_CALENDAR_DAYS[range];
    const since = istDaysAgo(rangeDays);

    const stock = await AppDataSource.getRepository(Stock).findOne({
      where: { ticker: t },
    });
    const dbBars = stock ? await this.readBarsFromDb(stock.id, since) : [];
    if (dbBars.length > 0 && this.isCoverageFresh(dbBars, rangeDays)) {
      return { bars: dbBars, source: "db-fresh" };
    }
    // Holiday guard: a recent Yahoo attempt already confirmed no newer bar
    // exists (exchange holiday / pre-first-bar) — don't refetch on every read.
    if (dbBars.length > 0 && this.isAcceptableAfterRecentAttempt(dbBars, t)) {
      return { bars: dbBars, source: "db-fresh" };
    }

    try {
      const { bars, meta } = await fetchChart(t, range);
      this.recentBarFetchAttempts.set(t, Date.now());
      if (bars.length === 0) {
        throw new Error(`Yahoo returned no bars for ${t} (range ${range})`);
      }
      await this.persistBars(t, bars, meta);
      // T3 fix (risk-spec audit §9.2): the partial-today-bar guard used to run
      // only at persist time, so intraday callers (backtests, prediction logs,
      // forecast issuances, outcome grading) treated a mid-session price as a
      // final close. Analytics callers get COMPLETED bars only.
      const completed = dropPartialTodayBar(bars);
      return { bars: completed.length > 0 ? completed : bars, source: "yahoo" };
    } catch (err) {
      // Stale-but-real DB data beats an error; never fabricate.
      if (dbBars.length > 0) return { bars: dbBars, source: "db-stale" };
      throw err;
    }
  }

  /**
   * NIFTY 50 (^NSEI) bars, in-memory cache TTL 6h per range. Not stored in the
   * DB. V7: longer ranges power the historical stress windows.
   */
  async getNiftyBars(range: "1y" | "2y" | "5y" = "1y"): Promise<Bar[]> {
    return this.getCachedIndexBars(NIFTY_TICKER, range);
  }

  /**
   * V10 B2 — India VIX (^INDIAVIX) bars for the HAR-X volatility regressor.
   * Same memory-cache pattern as NIFTY (TTL 6h, stale-cache fallback on a
   * Yahoo failure) and, like every index, NEVER stored in the DB.
   */
  async getIndiaVixBars(range: "1y" | "2y" | "5y" = "2y"): Promise<Bar[]> {
    return this.getCachedIndexBars(INDIA_VIX_TICKER, range);
  }

  /** Shared 6h in-memory index-bars cache (keyed ticker:range, never DB). */
  private async getCachedIndexBars(ticker: string, range: "1y" | "2y" | "5y"): Promise<Bar[]> {
    const key = `${ticker}:${range}`;
    const cached = this.niftyCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < NIFTY_CACHE_TTL_MS) {
      return cached.bars;
    }
    try {
      const { bars } = await fetchChart(ticker, range);
      if (bars.length === 0) {
        throw new Error(`Yahoo returned no bars for ${ticker}`);
      }
      this.niftyCache.set(key, { bars, fetchedAt: Date.now() });
      return bars;
    } catch (err) {
      // Serve stale (real) cache if we have one; otherwise propagate.
      if (cached) return cached.bars;
      throw err;
    }
  }

  // ── Seeding ───────────────────────────────────────────────────────────────

  /**
   * For every universe stock: upsert its Stock row, fetch 2y of daily bars,
   * and upsert stock_history. Throttled; failures are recorded and skipped.
   */
  async seedUniverse(
    onProgress?: (done: number, total: number, ticker: string) => void
  ): Promise<SeedResult> {
    await this.ensureDb();
    const ok: string[] = [];
    const failed: string[] = [];
    const total = NSE_UNIVERSE.length;

    for (let i = 0; i < total; i++) {
      const u = NSE_UNIVERSE[i];
      try {
        const { bars, meta } = await fetchChart(u.ticker, "2y");
        if (bars.length === 0) {
          throw new Error(`no bars returned for ${u.ticker}`);
        }
        await this.persistBars(u.ticker, bars, meta);
        ok.push(u.ticker);
      } catch {
        failed.push(u.ticker);
      }
      if (onProgress) onProgress(i + 1, total, u.ticker);
      if (i < total - 1) await sleep(SEED_THROTTLE_MS);
    }
    return { ok, failed };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** Uppercase, trim, default to .NS when no exchange suffix is present. */
  private normalizeTicker(ticker: string): string {
    const t = (ticker ?? "").trim().toUpperCase();
    if (!t || t.startsWith("^")) return t;
    if (/\.[A-Z]{1,3}$/.test(t)) return t;
    return `${t}.NS`;
  }

  /**
   * Universe matches ranked best-first:
   * exact ticker > exact name > name starts-with > all tokens in name >
   * name contains > ticker starts-with.
   */
  private matchUniverse(query: string): UniverseStock[] {
    const lower = query.trim().toLowerCase();
    if (!lower) return [];
    const tickerBase = query
      .trim()
      .toUpperCase()
      .replace(/\.(NS|BO)$/, "");
    const tokens = lower.split(/\s+/).filter(Boolean);

    const ranked: Array<{ stock: UniverseStock; rank: number }> = [];
    for (const u of NSE_UNIVERSE) {
      const base = u.ticker.replace(/\.NS$/, "");
      const name = u.name.toLowerCase();
      let rank: number | null = null;
      if (base === tickerBase) rank = 0;
      else if (name === lower) rank = 1;
      else if (name.startsWith(lower)) rank = 2;
      else if (tokens.length > 1 && tokens.every((tk) => name.includes(tk)))
        rank = 3;
      else if (lower.length >= 3 && name.includes(lower)) rank = 4;
      else if (tickerBase.length >= 3 && base.startsWith(tickerBase)) rank = 5;
      if (rank !== null) ranked.push({ stock: u, rank });
    }
    ranked.sort(
      (a, b) =>
        a.rank - b.rank || a.stock.name.length - b.stock.name.length
    );
    return ranked.map((r) => r.stock);
  }

  private quoteFromMeta(ticker: string, meta: YahooChartMeta, fallbackPreviousClose: number | null = null): Quote {
    const price = meta.regularMarketPrice;
    if (typeof price !== "number" || !Number.isFinite(price)) {
      throw new Error(`Yahoo quote for ${ticker} has no regularMarketPrice`);
    }
    const previousCloseRaw =
      typeof meta.previousClose === "number" &&
      Number.isFinite(meta.previousClose)
        ? meta.previousClose
        : typeof meta.chartPreviousClose === "number" &&
            Number.isFinite(meta.chartPreviousClose)
          ? meta.chartPreviousClose
          : null;
    // T3 fix (audit §6): last stored completed close beats fabricating a flat
    // day from the live price; price remains the final fallback (flat, stated).
    const previousClose = previousCloseRaw ?? fallbackPreviousClose ?? price;
    const change = price - previousClose;
    const changePercent =
      previousClose !== 0 ? (change / previousClose) * 100 : 0;
    const opt = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) ? v : null;

    const quote: Quote = {
      ticker,
      price,
      previousClose,
      change,
      changePercent,
      dayHigh: opt(meta.regularMarketDayHigh),
      dayLow: opt(meta.regularMarketDayLow),
      volume: opt(meta.regularMarketVolume),
      fiftyTwoWeekHigh: opt(meta.fiftyTwoWeekHigh),
      fiftyTwoWeekLow: opt(meta.fiftyTwoWeekLow),
      currency: meta.currency || "INR",
      asOf:
        typeof meta.regularMarketTime === "number"
          ? new Date(meta.regularMarketTime * 1000).toISOString()
          : new Date().toISOString(),
    };
    if (typeof meta.marketState === "string") {
      quote.marketState = meta.marketState;
    }
    return quote;
  }

  private async ensureDb(): Promise<void> {
    if (AppDataSource.isInitialized) return;
    if (!this.dbInitPromise) {
      this.dbInitPromise = AppDataSource.initialize().then(() => undefined);
    }
    await this.dbInitPromise;
  }

  /**
   * The last COMPLETED NSE trading day in IST (weekend-aware): weekdays after
   * the 15:40 close → today; weekdays before close → the previous weekday;
   * Sat → Fri; Sun → Fri. (Exchange holidays are handled by the recent-attempt
   * guard in getDailyBarsWithSource, not here.)
   */
  private lastCompletedTradingDate(): string {
    let offset = 0;
    // Day-of-week in IST for "today - offset".
    const dowOf = (off: number): number => {
      const label = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Kolkata",
        weekday: "short",
      }).format(new Date(Date.now() - off * 86_400_000));
      return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(label);
    };
    const todayDow = dowOf(0);
    if (todayDow === 0) offset = 2; // Sun → Fri
    else if (todayDow === 6) offset = 1; // Sat → Fri
    else if (istMinutesNow() < MARKET_CLOSE_IST_MINUTES) {
      // Market not closed yet → yesterday, walking back over the weekend.
      offset = todayDow === 1 ? 3 : 1; // Mon before close → Fri
    }
    return istDaysAgo(offset);
  }

  /**
   * Fresh enough = the latest bar is AT LEAST the last completed trading day
   * (daily data must actually be daily — a 3-day-old close is not "today"),
   * AND the earliest bar (roughly) covers the start of the requested range,
   * AND a sane number of trading days is present. FRESHNESS_MAX_AGE_DAYS
   * remains the hard ceiling for the holiday guard's relaxed path.
   */
  private isCoverageFresh(bars: Bar[], rangeDays: number): boolean {
    const today = istToday();
    const latest = bars[bars.length - 1].date;
    const earliest = bars[0].date;
    if (latest < this.lastCompletedTradingDate()) return false;
    if (daysBetween(earliest, today) < rangeDays - SPAN_SLACK_DAYS)
      return false;
    // NSE has ~0.68 trading days per calendar day; 0.35 is a lenient floor.
    if (bars.length < Math.floor(rangeDays * 0.35)) return false;
    return true;
  }

  /**
   * Holiday guard: when the DB lacks the last-trading-day bar but a Yahoo
   * fetch was already attempted recently (e.g. an exchange holiday means no
   * new bar EXISTS), don't hammer Yahoo on every read — serve the DB copy as
   * fresh for a while, provided it is within the hard age ceiling.
   */
  private isAcceptableAfterRecentAttempt(bars: Bar[], ticker: string): boolean {
    const attemptedAt = this.recentBarFetchAttempts.get(ticker);
    if (!attemptedAt || Date.now() - attemptedAt > RECENT_FETCH_ATTEMPT_TTL_MS) {
      return false;
    }
    const latest = bars[bars.length - 1].date;
    return daysBetween(latest, istToday()) <= FRESHNESS_MAX_AGE_DAYS;
  }

  /** Read bars from stock_history, deduped by trading date (latest fetch wins). */
  private async readBarsFromDb(stockId: string, since: string): Promise<Bar[]> {
    const rows: RawHistoryRow[] = await AppDataSource.getRepository(
      StockHistory
    )
      .createQueryBuilder("h")
      .select("to_char(h.trading_date, 'YYYY-MM-DD')", "date")
      .addSelect("h.open_price", "open")
      .addSelect("h.high_price", "high")
      .addSelect("h.low_price", "low")
      .addSelect("h.close_price", "close")
      .addSelect("h.volume", "volume")
      .where("h.stock_id = :stockId", { stockId })
      .andWhere("h.trading_date >= :since", { since })
      .orderBy("h.trading_date", "ASC")
      .addOrderBy("h.fetch_timestamp", "ASC")
      .getRawMany();

    const byDate = new Map<string, Bar>();
    for (const row of rows) {
      const open = Number.parseFloat(row.open);
      const high = Number.parseFloat(row.high);
      const low = Number.parseFloat(row.low);
      const close = Number.parseFloat(row.close);
      const volume = Number.parseInt(row.volume, 10);
      if (![open, high, low, close].every(Number.isFinite)) continue;
      byDate.set(row.date, {
        date: row.date,
        open,
        high,
        low,
        close,
        volume: Number.isFinite(volume) ? volume : 0,
      });
    }
    return Array.from(byDate.values()).sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : 0
    );
  }

  /** Find-or-create the Stock row for a ticker, enriching from the universe. */
  private async upsertStock(
    ticker: string,
    meta?: YahooChartMeta
  ): Promise<Stock> {
    const repo = AppDataSource.getRepository(Stock);
    const universe = NSE_UNIVERSE.find((u) => u.ticker === ticker);
    const name =
      universe?.name || meta?.longName || meta?.shortName || ticker;
    const exchange = ticker.endsWith(".BO") ? "BSE" : "NSE";

    let stock = await repo.findOne({ where: { ticker } });
    if (!stock) {
      stock = repo.create({
        ticker,
        name,
        exchange,
        sector: universe?.sector,
        isActive: true,
        trackingEnabled: true,
      });
      try {
        await repo.save(stock);
      } catch {
        // Concurrent insert on the unique ticker — re-read.
        stock = await repo.findOne({ where: { ticker } });
        if (!stock) throw new Error(`Failed to upsert stock row for ${ticker}`);
      }
      return stock;
    }

    let dirty = false;
    if (!stock.name && name) {
      stock.name = name;
      dirty = true;
    }
    if (!stock.sector && universe?.sector) {
      stock.sector = universe.sector;
      dirty = true;
    }
    if (!stock.exchange) {
      stock.exchange = exchange;
      dirty = true;
    }
    if (dirty) await repo.save(stock);
    return stock;
  }

  /**
   * Upsert daily bars into stock_history without violating the table's
   * (stock_id, trading_date, fetch_timestamp) unique key: delete the ticker's
   * rows in the fetched date range, then insert fresh rows — atomically.
   *
   * Today's still-in-progress bar (fetched before the 15:30 IST close) is
   * NEVER persisted — otherwise a mid-session price would be recorded as the
   * day's close and later consumed by verification/backtests as final.
   */
  private async persistBars(
    ticker: string,
    bars: Bar[],
    meta?: YahooChartMeta
  ): Promise<void> {
    await this.ensureDb();
    const stock = await this.upsertStock(ticker, meta);
    const finalBars = dropPartialTodayBar(bars);
    if (finalBars.length === 0) return;
    const minDate = finalBars[0].date;
    const maxDate = finalBars[finalBars.length - 1].date;

    const rows: QueryDeepPartialEntity<StockHistory>[] = finalBars.map((bar, i) => {
      const prevClose = i > 0 ? finalBars[i - 1].close : null;
      return {
        stockId: stock.id,
        openPrice: bar.open,
        highPrice: bar.high,
        lowPrice: bar.low,
        closePrice: bar.close,
        previousClose: prevClose ?? undefined,
        volume: bar.volume,
        priceChange:
          prevClose !== null
            ? Number((bar.close - prevClose).toFixed(4))
            : undefined,
        priceChangePercent:
          prevClose !== null && prevClose !== 0
            ? Number((((bar.close - prevClose) / prevClose) * 100).toFixed(4))
            : undefined,
        dataSource: "yahoo",
        // pg 'date' column — pass the YYYY-MM-DD string through unchanged.
        tradingDate: bar.date as unknown as Date,
      };
    });

    await AppDataSource.transaction(async (em) => {
      await em
        .createQueryBuilder()
        .delete()
        .from(StockHistory)
        .where(
          "stock_id = :stockId AND trading_date BETWEEN :minDate AND :maxDate",
          { stockId: stock.id, minDate, maxDate }
        )
        .execute();
      for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
        await em
          .getRepository(StockHistory)
          .insert(rows.slice(i, i + INSERT_CHUNK_SIZE));
      }
    });
  }
}

/** Singleton export (per REBUILD_SPEC Module 1). */
export const marketDataService = new MarketDataService();
export default marketDataService;
