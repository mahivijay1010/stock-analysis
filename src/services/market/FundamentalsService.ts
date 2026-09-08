/**
 * FundamentalsService (Module V2-A) — free Yahoo quoteSummary fundamentals.
 *
 * Flow (verified working 2026-08-30):
 *   1. GET https://fc.yahoo.com            → capture cookies from set-cookie (response is a 404 — that's fine)
 *   2. GET /v1/test/getcrumb (with cookie) → crumb string
 *   3. GET /v10/finance/quoteSummary/{T}?modules=financialData,defaultKeyStatistics,summaryDetail&crumb={C}
 *
 * Cookie+crumb are cached in memory and refreshed ONCE on 401/"Invalid Crumb".
 * EVERY field is nullable — Yahoo omits many per ticker (e.g. RELIANCE has no
 * returnOnEquity/freeCashflow/currentRatio). Missing modules/fields never
 * throw; we return whatever real data exists. Fractions (margins, growth,
 * yields, holdings) are converted to percentages per the V2 spec.
 *
 * 24h in-memory cache per ticker. On a fetch failure a stale (but real) cached
 * value is served if present; otherwise the error propagates for the caller
 * to handle honestly (analyze marks framework phases as no-data).
 */

import axios, { AxiosError } from "axios";
import { Fundamentals } from "./types";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const COOKIE_URL = "https://fc.yahoo.com";
const CRUMB_URL = "https://query1.finance.yahoo.com/v1/test/getcrumb";
const QUOTE_SUMMARY_BASE =
  "https://query1.finance.yahoo.com/v10/finance/quoteSummary";
const MODULES = "financialData,defaultKeyStatistics,summaryDetail,calendarEvents";
const REQUEST_TIMEOUT_MS = 10_000;
const FUNDAMENTALS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CrumbCredentials {
  cookie: string;
  crumb: string;
}

/** Yahoo wraps most numbers as { raw, fmt } and empty fields as {}. */
function rawNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object") {
    const raw = (v as { raw?: unknown }).raw;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  }
  return null;
}

/** Fraction (0.338) → percentage (33.8), preserving null. */
function toPct(v: number | null): number | null {
  return v === null ? null : Number((v * 100).toFixed(4));
}

export class FundamentalsService {
  private cache = new Map<string, { data: Fundamentals; fetchedAt: number }>();
  private creds: CrumbCredentials | null = null;
  private credsPromise: Promise<CrumbCredentials> | null = null;

  /** V8 R1 — true when a fresh (≤24h) cached value exists (no fetch). Lets
   *  bulk consumers (RankEngine) throttle only the calls that actually hit Yahoo. */
  hasFreshCache(ticker: string): boolean {
    const cached = this.cache.get(this.normalizeTicker(ticker));
    return !!cached && Date.now() - cached.fetchedAt < FUNDAMENTALS_CACHE_TTL_MS;
  }

  /** Fundamentals for a ticker (24h cache, all fields nullable). */
  async getFundamentals(ticker: string): Promise<Fundamentals> {
    const t = this.normalizeTicker(ticker);
    const cached = this.cache.get(t);
    if (cached && Date.now() - cached.fetchedAt < FUNDAMENTALS_CACHE_TTL_MS) {
      return cached.data;
    }

    try {
      const result = await this.fetchQuoteSummary(t);
      const data = this.parseFundamentals(result);
      this.cache.set(t, { data, fetchedAt: Date.now() });
      return data;
    } catch (err) {
      // Stale-but-real cached fundamentals beat an error; never fabricate.
      if (cached) return cached.data;
      throw err;
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private normalizeTicker(ticker: string): string {
    const t = (ticker ?? "").trim().toUpperCase();
    if (!t || t.startsWith("^")) return t;
    if (/\.[A-Z]{1,3}$/.test(t)) return t;
    return `${t}.NS`;
  }

  /**
   * quoteSummary result[0], with a single crumb refresh + retry on
   * 401 / "Invalid Crumb".
   */
  private async fetchQuoteSummary(ticker: string): Promise<Record<string, unknown>> {
    let creds = await this.getCredentials(false);
    try {
      return await this.requestQuoteSummary(ticker, creds);
    } catch (err) {
      if (!this.isInvalidCrumbError(err)) throw err;
      creds = await this.getCredentials(true); // refresh once and retry
      return this.requestQuoteSummary(ticker, creds);
    }
  }

  private async requestQuoteSummary(
    ticker: string,
    creds: CrumbCredentials
  ): Promise<Record<string, unknown>> {
    const url =
      `${QUOTE_SUMMARY_BASE}/${encodeURIComponent(ticker)}` +
      `?modules=${MODULES}&crumb=${encodeURIComponent(creds.crumb)}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await axios.get<any>(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        Cookie: creds.cookie,
      },
      timeout: REQUEST_TIMEOUT_MS,
    });
    const summary = res.data?.quoteSummary;
    if (summary?.error) {
      const desc =
        summary.error.description || summary.error.code || "unknown error";
      throw new Error(`Yahoo quoteSummary error for ${ticker}: ${desc}`);
    }
    const result = summary?.result?.[0];
    if (!result || typeof result !== "object") {
      throw new Error(`Yahoo quoteSummary returned no result for ${ticker}`);
    }
    return result as Record<string, unknown>;
  }

  private isInvalidCrumbError(err: unknown): boolean {
    if (!axios.isAxiosError(err)) return false;
    const e = err as AxiosError<{
      quoteSummary?: { error?: { description?: string } };
      finance?: { error?: { description?: string } };
    }>;
    if (e.response?.status === 401) return true;
    const desc =
      e.response?.data?.quoteSummary?.error?.description ??
      e.response?.data?.finance?.error?.description ??
      "";
    return typeof desc === "string" && /invalid crumb/i.test(desc);
  }

  /** Cookie+crumb handshake, cached in memory. Single-flight. */
  private async getCredentials(forceRefresh: boolean): Promise<CrumbCredentials> {
    if (!forceRefresh && this.creds) return this.creds;
    if (!this.credsPromise) {
      this.credsPromise = this.performHandshake().finally(() => {
        this.credsPromise = null;
      });
    }
    const creds = await this.credsPromise;
    this.creds = creds;
    return creds;
  }

  private async performHandshake(): Promise<CrumbCredentials> {
    // Step 1: fc.yahoo.com responds 404 but sets the session cookie we need.
    const cookieRes = await axios.get(COOKIE_URL, {
      headers: { "User-Agent": USER_AGENT },
      timeout: REQUEST_TIMEOUT_MS,
      maxRedirects: 0,
      validateStatus: () => true, // 404 is expected — we only want set-cookie
    });
    const setCookies = cookieRes.headers["set-cookie"];
    if (!Array.isArray(setCookies) || setCookies.length === 0) {
      throw new Error("Yahoo crumb handshake failed: no set-cookie from fc.yahoo.com");
    }
    const cookie = setCookies.map((c) => c.split(";")[0]).join("; ");

    // Step 2: exchange the cookie for a crumb.
    const crumbRes = await axios.get<string>(CRUMB_URL, {
      headers: { "User-Agent": USER_AGENT, Cookie: cookie },
      timeout: REQUEST_TIMEOUT_MS,
      responseType: "text",
      transformResponse: [(d) => d],
    });
    const crumb = typeof crumbRes.data === "string" ? crumbRes.data.trim() : "";
    if (!crumb || crumb.includes("{") || crumb.length > 64) {
      throw new Error(`Yahoo crumb handshake failed: unusable crumb "${crumb.slice(0, 40)}"`);
    }
    return { cookie, crumb };
  }

  private parseFundamentals(result: Record<string, unknown>): Fundamentals {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fin = (result.financialData ?? {}) as Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = (result.defaultKeyStatistics ?? {}) as Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const detail = (result.summaryDetail ?? {}) as Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calendar = (result.calendarEvents ?? {}) as Record<string, any>;
    // earningsDate: array of {raw: epochSeconds} (a window when Yahoo shows a range).
    const earningsRaw = rawNum(calendar.earnings?.earningsDate?.[0]);
    const nextEarningsDate =
      earningsRaw != null && earningsRaw > 0
        ? new Date(earningsRaw * 1000).toISOString().slice(0, 10)
        : null;

    return {
      trailingPE: rawNum(detail.trailingPE) ?? rawNum(stats.trailingPE),
      pegRatio: rawNum(stats.pegRatio) ?? rawNum(stats.trailingPegRatio),
      priceToBook: rawNum(stats.priceToBook),
      enterpriseToEbitda: rawNum(stats.enterpriseToEbitda),
      grossMarginPct: toPct(rawNum(fin.grossMargins)),
      operatingMarginPct: toPct(rawNum(fin.operatingMargins)),
      netMarginPct: toPct(rawNum(fin.profitMargins) ?? rawNum(stats.profitMargins)),
      revenueGrowthPct: toPct(rawNum(fin.revenueGrowth)),
      earningsGrowthPct: toPct(rawNum(fin.earningsGrowth)),
      returnOnEquityPct: toPct(rawNum(fin.returnOnEquity)),
      returnOnAssetsPct: toPct(rawNum(fin.returnOnAssets)),
      totalDebt: rawNum(fin.totalDebt),
      totalCash: rawNum(fin.totalCash),
      freeCashflow: rawNum(fin.freeCashflow),
      currentRatio: rawNum(fin.currentRatio),
      dividendYieldPct: toPct(rawNum(detail.dividendYield)),
      payoutRatioPct: toPct(rawNum(detail.payoutRatio)),
      marketCap: rawNum(detail.marketCap),
      insiderHoldingPct: toPct(rawNum(stats.heldPercentInsiders)),
      beta: rawNum(detail.beta) ?? rawNum(stats.beta),
      nextEarningsDate,
      asOf: new Date().toISOString(),
      source: "yahoo",
    };
  }
}

/** Singleton export. */
export const fundamentalsService = new FundamentalsService();
export default fundamentalsService;
