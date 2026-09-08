/**
 * V8 R1 — RankService: wiring around the pure RankEngine (quant/rank.ts).
 *
 *  - buildRankUniverse(): cross-sectional composite for all 151 universe
 *    stocks from DB bars (momentum), the 24h-cached FundamentalsService
 *    (quality: ROE, labeled operating-margin fallback) and ONLY already-cached
 *    NewsSummaries (sentiment) — never 151 news fetches. 30-min cache,
 *    single-flight.
 *  - persistTodaySnapshot(): idempotent upsert of today's rows into
 *    rank_snapshots (cron calls this after the 08:45 scan).
 *  - getRankUniverse(): API payload with the MEASURED IC when ≥20 snapshot
 *    days have matured 30d forwards, else ic: null + the honest note. IC is
 *    never simulated from ranks backfilled today (that would be lookahead).
 */

import { AppDataSource } from "../config/database";
import { RankSnapshot } from "../entities/RankSnapshot";
import { NSE_UNIVERSE } from "../data/nseUniverse";
import { marketDataService } from "./market/MarketDataService";
import { fundamentalsService } from "./market/FundamentalsService";
import { newsService } from "./market/NewsService";
import {
  IntelligenceRepository,
  StoredTickerIntelligence,
} from "./intelligence/IntelligenceRepository";
import { intelligenceQualityScore } from "./quant/intelligenceQuality";
import {
  computeRankIC,
  IcDaySample,
  momentum60d,
  RankInputRow,
  rankUniverse,
} from "./quant/rank";
import { RankIcBlock, RankUniverseResponse, RankUniverseRow } from "../types";
import { QueryDeepPartialEntity } from "typeorm/query-builder/QueryPartialEntity";

const RANK_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const YAHOO_THROTTLE_MS = 350; // pause after an actual Yahoo fetch
const FUNDAMENTALS_THROTTLE_MS = 250; // pause after an uncached fundamentals fetch
const IC_MIN_DAYS = 20;
const FORWARD_DAYS = 30;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** YYYY-MM-DD in Asia/Kolkata. */
function istDateString(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

interface RankBuild {
  asOf: string;
  rows: RankUniverseRow[];
  /** Real market caps captured during the build (for the options top-30). */
  marketCapByTicker: Map<string, number>;
  /** V10 B1 — universe tickers whose quality pillar used stored intelligence. */
  intelligenceCovered: number;
}

export class RankService {
  private cache: RankBuild | null = null;
  private builtAt = 0;
  private inFlight: Promise<RankBuild> | null = null;
  private readonly intelligenceRepository = new IntelligenceRepository();

  // ── Build ──────────────────────────────────────────────────────────────────

  /** Cached cross-sectional rank build (30-min TTL, single-flight). */
  async buildRankUniverse(force = false): Promise<RankBuild> {
    if (!force && this.cache && Date.now() - this.builtAt < RANK_CACHE_TTL_MS) {
      return this.cache;
    }
    if (this.inFlight) return this.inFlight;
    const run = this.runBuild().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async runBuild(): Promise<RankBuild> {
    const inputs: RankInputRow[] = [];
    const marketCapByTicker = new Map<string, number>();

    // V10 B1: ONE batched read of the latest STORED intelligence metrics for
    // the whole universe (never a per-ticker NSE fetch — that is the rotating
    // nightly refresh's job). A read failure degrades to the V8 fallback.
    let stored = new Map<string, StoredTickerIntelligence>();
    try {
      stored = await this.intelligenceRepository.latestStoredMetrics(
        NSE_UNIVERSE.map((u) => u.ticker)
      );
    } catch (err) {
      console.warn(
        "⚠️ rank intelligence read failed (quoteSummary fallback for all):",
        (err as Error).message
      );
    }

    for (const u of NSE_UNIVERSE) {
      // Momentum: 60-trading-day return from DB bars (Yahoo only when stale).
      let momentum: number | null = null;
      try {
        const { bars, source } = await marketDataService.getDailyBarsWithSource(
          u.ticker,
          "6mo"
        );
        momentum = momentum60d(
          bars.map((b) =>
            b.adjustedClose != null && Number.isFinite(b.adjustedClose) && b.adjustedClose > 0
              ? b.adjustedClose
              : b.close
          )
        );
        if (source === "yahoo") await sleep(YAHOO_THROTTLE_MS);
      } catch (err) {
        console.warn(`⚠️ rank momentum skipped ${u.ticker}:`, (err as Error).message);
      }

      // Quality: ROE %, else operating margin % (labeled fallback). The
      // FundamentalsService caches 24h — throttle only actual Yahoo fetches.
      let quality: number | null = null;
      let qualitySource: RankInputRow["qualitySource"] = null;
      try {
        const wasCached = fundamentalsService.hasFreshCache(u.ticker);
        const f = await fundamentalsService.getFundamentals(u.ticker);
        if (f.returnOnEquityPct !== null && Number.isFinite(f.returnOnEquityPct)) {
          quality = f.returnOnEquityPct;
          qualitySource = "roe";
        } else if (
          f.operatingMarginPct !== null &&
          Number.isFinite(f.operatingMarginPct)
        ) {
          quality = f.operatingMarginPct;
          qualitySource = "operating-margin";
        }
        if (f.marketCap !== null && Number.isFinite(f.marketCap)) {
          marketCapByTicker.set(u.ticker, f.marketCap);
        }
        if (!wasCached) await sleep(FUNDAMENTALS_THROTTLE_MS);
      } catch (err) {
        console.warn(`⚠️ rank quality no-data ${u.ticker}:`, (err as Error).message);
      }

      // Sentiment: ONLY a cached NewsSummary (30-min TTL) — no fetching here.
      const cachedNews = newsService.getCachedNews(u.ticker);
      const sentimentDecay =
        cachedNews && Number.isFinite(cachedNews.sentimentScore)
          ? cachedNews.sentimentScore
          : null;

      // V10 B1: stored-intelligence quality score (null → V8 fallback).
      const s = stored.get(u.ticker.replace(/\.(NS|BO)$/i, "").toUpperCase());
      const intelligenceQuality = s
        ? intelligenceQualityScore({
            roic: s.roic,
            fcf: s.fcf,
            revenue: s.revenue,
            currentRatio: s.currentRatio,
            currentRatioNotMeaningful: s.currentRatioNotMeaningful,
            peg: s.peg,
          })
        : null;

      inputs.push({
        ticker: u.ticker,
        momentum60d: momentum,
        quality,
        qualitySource,
        intelligenceQuality,
        sentimentDecay,
      });
    }

    const ranked = rankUniverse(inputs);
    const meta = new Map(NSE_UNIVERSE.map((u) => [u.ticker, u]));
    const rows: RankUniverseRow[] = ranked
      .map((r) => ({
        ticker: r.ticker,
        name: meta.get(r.ticker)?.name ?? r.ticker,
        sector: meta.get(r.ticker)?.sector ?? "",
        composite: r.composite,
        percentile: r.percentile,
        components: r.components,
        componentStatus: r.componentStatus,
        qualitySource: r.qualitySource,
      }))
      .sort((a, b) => b.composite - a.composite);

    const build: RankBuild = {
      asOf: new Date().toISOString(),
      rows,
      marketCapByTicker,
      intelligenceCovered: inputs.filter((i) => i.intelligenceQuality != null).length,
    };
    this.cache = build;
    this.builtAt = Date.now();
    return build;
  }

  // ── Snapshot persistence (cron + idempotent) ───────────────────────────────

  /**
   * Upsert today's (IST) snapshot rows — one per ranked ticker. Re-running on
   * the same day replaces that day's rows (unique (date, ticker) index), so
   * the cron hook and manual triggers can never double-count.
   */
  async persistTodaySnapshot(): Promise<{ date: string; rowsPersisted: number }> {
    const build = await this.buildRankUniverse();
    const date = istDateString();
    const repo = AppDataSource.getRepository(RankSnapshot);
    const rows: QueryDeepPartialEntity<RankSnapshot>[] = build.rows.map((r) => ({
      date: date as unknown as Date,
      ticker: r.ticker,
      composite: r.composite,
      percentile: r.percentile,
      components: {
        momentum: r.components.momentum,
        quality: r.components.quality,
        sentiment: r.components.sentiment,
        status: r.componentStatus,
        qualitySource: r.qualitySource,
      },
    }));
    await repo.upsert(rows, ["date", "ticker"]);
    return { date, rowsPersisted: rows.length };
  }

  // ── IC (measured only — never backfilled) ──────────────────────────────────

  /**
   * Measured IC from PERSISTED snapshots whose 30d forwards have matured.
   * Returns null (with `since` context) until ≥20 qualifying days exist.
   */
  private async measureIc(): Promise<{ ic: RankIcBlock | null; since: string | null }> {
    const minRow: Array<{ min: string | null }> = await AppDataSource.query(
      `SELECT to_char(MIN(date), 'YYYY-MM-DD') AS min FROM rank_snapshots`
    );
    const since = minRow[0]?.min ?? null;
    if (!since) return { ic: null, since: null };

    const rows: Array<{
      date: string;
      ticker: string;
      composite: string;
      base_close: string | null;
      fwd_close: string | null;
    }> = await AppDataSource.query(
      `SELECT to_char(rs.date, 'YYYY-MM-DD') AS date, rs.ticker, rs.composite,
              base.close_price AS base_close, fwd.close_price AS fwd_close
         FROM rank_snapshots rs
         JOIN stocks s ON s.ticker = rs.ticker
         LEFT JOIN LATERAL (
           SELECT h.close_price FROM stock_history h
            WHERE h.stock_id = s.id AND h.trading_date <= rs.date
            ORDER BY h.trading_date DESC, h.fetch_timestamp DESC LIMIT 1
         ) base ON true
         LEFT JOIN LATERAL (
           SELECT h.close_price FROM stock_history h
            WHERE h.stock_id = s.id
              AND h.trading_date >= rs.date + INTERVAL '${FORWARD_DAYS} days'
            ORDER BY h.trading_date ASC, h.fetch_timestamp DESC LIMIT 1
         ) fwd ON true
        WHERE rs.date <= CURRENT_DATE - INTERVAL '${FORWARD_DAYS} days'`
    );

    const byDate = new Map<string, { composites: number[]; forwardReturns: number[] }>();
    for (const r of rows) {
      const base = r.base_close === null ? NaN : Number.parseFloat(r.base_close);
      const fwd = r.fwd_close === null ? NaN : Number.parseFloat(r.fwd_close);
      const comp = Number.parseFloat(r.composite);
      if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(fwd) || !Number.isFinite(comp)) {
        continue;
      }
      const day = byDate.get(r.date) ?? { composites: [], forwardReturns: [] };
      day.composites.push(comp);
      day.forwardReturns.push(fwd / base - 1);
      byDate.set(r.date, day);
    }

    const days: IcDaySample[] = Array.from(byDate.entries()).map(([date, d]) => ({
      date,
      composites: d.composites,
      forwardReturns: d.forwardReturns,
    }));
    const qualifying = days.filter((d) => d.composites.length >= 10);
    if (qualifying.length < IC_MIN_DAYS) return { ic: null, since };

    const measured = computeRankIC(qualifying);
    if (!measured) return { ic: null, since };
    return { ic: { value: measured.value, samples: measured.samples, since }, since };
  }

  // ── API payload ────────────────────────────────────────────────────────────

  async getRankUniverse(): Promise<RankUniverseResponse> {
    const build = await this.buildRankUniverse();
    const { ic, since } = await this.measureIc().catch((err) => {
      console.warn("⚠️ rank IC measurement failed:", (err as Error).message);
      return { ic: null, since: null as string | null };
    });

    const collectingSince = since ?? istDateString();
    const icNote = ic
      ? `IC is the mean daily Spearman correlation between this composite and the realized forward ` +
        `${FORWARD_DAYS}d return, measured on ${ic.samples} persisted snapshot days since ${ic.since}. ` +
        `An |IC| under ~0.05 is noise — read it before trusting the ordering.`
      : `IC unlocks after ~7 weeks of snapshots — collecting since ${collectingSince}. It is measured ` +
        `only on snapshots persisted in advance and their realized forward ${FORWARD_DAYS}d returns; ` +
        `backfilling ranks computed today would be lookahead, so we don't.`;

    const total = NSE_UNIVERSE.length;
    const covered = build.intelligenceCovered;
    const coverageNote =
      `Quality pillar: ${covered} of ${total} universe tickers currently use STORED NSE-filing ` +
      `intelligence (score 0-100 over ROIC/FCF/FCF-margin/current-ratio/PEG, bank-aware); the rest ` +
      `fall back to quoteSummary ROE/operating margin, labeled per row. Coverage grows via the ` +
      `rotating nightly refresh (the 10 stalest tickers after the 08:45 IST scan) — full universe ` +
      `in ~3 weeks.`;

    return {
      asOf: build.asOf,
      rows: build.rows,
      ic,
      note: `${icNote} ${coverageNote}`,
      methodology:
        "composite = z(60-trading-day return)×0.5 + z(quality)×0.3 + z(decay-weighted news sentiment)×0.2, " +
        "z-scored cross-sectionally across the universe (σ floor 1e-9, clamped ±3). Quality (V10) is the " +
        "stored-intelligence quality score when NSE-filing metrics exist for the ticker, else ROE% with a " +
        "labeled operating-margin fallback — componentStatus.quality states the source per row; sentiment " +
        "uses only already-cached news summaries (missing components contribute a neutral z=0 and are " +
        "flagged 'no-data'). Percentile 100 = strongest composite today. This is RELATIVE ordering, not a " +
        "return forecast — V7 measured no directional edge.",
      intelligenceCoverage: { covered, total, note: coverageNote },
    };
  }

  /**
   * V8 R3 helper — top-N universe tickers by REAL market cap captured from
   * cached fundamentals during the last rank build. Deliberately cache-only
   * (never triggers a build — the skew endpoint must stay cheap); falls back
   * (labeled measured=false) to the first N universe entries, which are the
   * NIFTY-50 core ordering, until a rank build has run.
   */
  topTickersByMarketCap(n: number): { tickers: string[]; measured: boolean } {
    const caps = this.cache?.marketCapByTicker;
    if (caps && caps.size >= n) {
      const tickers = Array.from(caps.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([t]) => t);
      return { tickers, measured: true };
    }
    return { tickers: NSE_UNIVERSE.slice(0, n).map((u) => u.ticker), measured: false };
  }
}

/** Shared singleton — controller and cron reuse the same 30-min build cache. */
export const rankService = new RankService();
export default rankService;
