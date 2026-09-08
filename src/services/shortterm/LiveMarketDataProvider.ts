/**
 * LiveMarketDataProvider (S2) — replaceable market-data abstraction with an
 * HONEST freshness contract.
 *
 * The current implementation wraps the existing Yahoo-backed services. Yahoo
 * NSE quotes are typically delayed — so this provider NEVER reports "LIVE"
 * unless the quote timestamp is provably within the live window during an
 * open session. The UI shows LIVE / DELAYED / STALE + lastUpdate everywhere.
 *
 * subscribeTicks/subscribeBars are POLLING adapters (the free provider has no
 * push feed); the interface exists so a real feed can replace it without
 * touching consumers. Completed DAILY bars confirm signals; quotes and
 * partial bars are display/monitoring only.
 */

import { marketDataService } from "../market/MarketDataService";
import { sessionCalendarService } from "../forecast/SessionCalendarService";
import { istDateString } from "../forecast/dates";
import { Bar } from "../market/types";
import { DataFreshness, FreshnessReport } from "./types";

export interface MarketStatus {
  session: "OPEN" | "CLOSED" | "PRE_OPEN";
  istTime: string;
  tradingDay: boolean;
  lastCompletedSession: string | null;
}

export interface LiveQuote {
  ticker: string;
  price: number;
  previousClose: number | null;
  changePercent: number | null;
  volume: number | null;
  asOf: string;
  freshness: FreshnessReport;
}

export interface TickHandle {
  stop: () => void;
  capability: "polling"; // honest: no push feed on the free provider
  intervalMs: number;
}

export interface LiveMarketDataProvider {
  readonly name: string;
  getQuote(ticker: string): Promise<LiveQuote>;
  getBars(ticker: string, range: "6mo" | "1y" | "2y" | "5y"): Promise<Bar[]>;
  /** Completed daily bars only — the signal-confirmation series. */
  getCompletedBars(ticker: string, range: "6mo" | "1y" | "2y" | "5y"): Promise<Bar[]>;
  subscribeTicks(ticker: string, onTick: (q: LiveQuote) => void, intervalMs?: number): TickHandle;
  getMarketStatus(): Promise<MarketStatus>;
  getDataFreshness(asOf: string | Date | null): Promise<FreshnessReport>;
}

const LIVE_MAX_AGE_S = 120;
const DELAYED_MAX_AGE_S = 30 * 60;

export class YahooLiveProvider implements LiveMarketDataProvider {
  readonly name = "yahoo-polling (free, delayed)";

  async getMarketStatus(): Promise<MarketStatus> {
    const now = new Date();
    const today = istDateString(now);
    const istTime = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now);
    const lastObserved = await sessionCalendarService.lastObservedSession(today).catch(() => null);
    const tradingDay = lastObserved === today;
    let session: MarketStatus["session"] = "CLOSED";
    if (tradingDay) {
      if (istTime >= "09:00" && istTime < "09:15") session = "PRE_OPEN";
      else if (istTime >= "09:15" && istTime < "15:30") session = "OPEN";
    }
    return { session, istTime, tradingDay, lastCompletedSession: lastObserved };
  }

  async getDataFreshness(asOf: string | Date | null): Promise<FreshnessReport> {
    const providerNote = "Yahoo polling — NSE quotes are typically delayed; never assume real-time.";
    if (!asOf) return { state: "STALE", lastUpdate: null, ageSeconds: null, providerNote };
    const ts = typeof asOf === "string" ? new Date(asOf) : asOf;
    const ageSeconds = Math.max(0, Math.floor((Date.now() - ts.getTime()) / 1000));
    const status = await this.getMarketStatus();
    let state: DataFreshness;
    if (status.session === "OPEN") {
      state = ageSeconds <= LIVE_MAX_AGE_S ? "LIVE" : ageSeconds <= DELAYED_MAX_AGE_S ? "DELAYED" : "STALE";
    } else {
      // Market closed: data as-of the last completed session is DELAYED-by-design, not stale.
      state = ageSeconds <= 26 * 3600 ? "DELAYED" : "STALE";
    }
    return { state, lastUpdate: ts.toISOString(), ageSeconds, providerNote };
  }

  async getQuote(ticker: string): Promise<LiveQuote> {
    const q = await marketDataService.getQuote(ticker);
    const freshness = await this.getDataFreshness(q.asOf);
    return {
      ticker: q.ticker,
      price: q.price,
      previousClose: q.previousClose ?? null,
      changePercent: q.changePercent ?? null,
      volume: q.volume ?? null,
      asOf: q.asOf,
      freshness,
    };
  }

  getBars(ticker: string, range: "6mo" | "1y" | "2y" | "5y"): Promise<Bar[]> {
    return marketDataService.getDailyBars(ticker, range);
  }

  /** Completed sessions only: drops any bar dated today while the session is open. */
  async getCompletedBars(ticker: string, range: "6mo" | "1y" | "2y" | "5y"): Promise<Bar[]> {
    const [bars, status] = await Promise.all([this.getBars(ticker, range), this.getMarketStatus()]);
    if (status.session === "OPEN" || status.session === "PRE_OPEN") {
      const today = istDateString(new Date());
      return bars.filter((b) => b.date < today);
    }
    return bars;
  }

  subscribeTicks(ticker: string, onTick: (q: LiveQuote) => void, intervalMs = 60_000): TickHandle {
    const timer = setInterval(() => {
      this.getQuote(ticker)
        .then(onTick)
        .catch(() => undefined); // polling errors are transient; freshness decays honestly
    }, Math.max(15_000, intervalMs));
    return { stop: () => clearInterval(timer), capability: "polling", intervalMs: Math.max(15_000, intervalMs) };
  }
}

export const liveMarketDataProvider: LiveMarketDataProvider = new YahooLiveProvider();
