/**
 * V8 R3 — OptionsSkewRadar over the NSE option-chain API.
 *
 * LIVE PROBE VERDICT (measured 2026-09-01 from this machine, per SPEC_V8 R3):
 *   1. warm-up GET https://www.nseindia.com (browser UA)      → HTTP 403,
 *      server: AkamaiGHost, body "<TITLE>Access Denied</TITLE> …
 *      Reference #18.2ffed417…" — no nsit/nseappid session cookies granted
 *      (only Akamai's own AKA_A2 / bm_sz / _abck bot-manager cookies).
 *   2. GET /api/option-chain-equities?symbol=RELIANCE with those cookies
 *      (Referer + Accept headers set)                          → HTTP 200 with
 *      an EMPTY JSON body "{}" (2 bytes) on every attempt, including retries
 *      after a 200 warm-up of /option-chain.
 *
 * NSE's Akamai bot management withholds data from this environment, so the
 * endpoint honestly reports status NOT_AVAILABLE with the evidence measured
 * at probe time. The probe re-runs (cached 30 min) so the radar self-heals if
 * NSE ever serves this machine; the parse/PCR path below only activates on a
 * REAL option chain. We never scrape mirrors and never fabricate numbers.
 */

import axios from "axios";
import { OptionsSkewResponse } from "../../types";
import { rankService } from "../RankService";

const COVERAGE_SIZE = 30; // top-30 universe tickers by market cap (spec)

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const WARMUP_URL = "https://www.nseindia.com";
const API_BASE = "https://www.nseindia.com/api/option-chain-equities";
const TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes (spec)
const PCR_HISTORY_DAYS = 5;

/** Minimal slice of the NSE option-chain payload we consume. */
interface NseOptionLeg {
  openInterest?: number;
  impliedVolatility?: number;
}
interface NseOptionRow {
  strikePrice?: number;
  expiryDate?: string;
  PE?: NseOptionLeg;
  CE?: NseOptionLeg;
}
interface NseOptionChain {
  records?: {
    expiryDates?: string[];
    underlyingValue?: number;
    data?: NseOptionRow[];
  };
}

interface ProbeOutcome {
  ok: boolean;
  chain: NseOptionChain | null;
  evidence: string; // measured HTTP evidence, verbatim-worthy
  probedAt: string;
}

interface PcrPoint {
  date: string; // YYYY-MM-DD
  pcr: number;
}

export class OptionsRadar {
  private resultCache = new Map<string, { data: OptionsSkewResponse; at: number }>();
  private probeCache: { outcome: ProbeOutcome; at: number } | null = null;
  private probeInFlight: Promise<ProbeOutcome> | null = null;
  /** In-memory 5-day PCR history per ticker (only populated when data flows). */
  private pcrHistory = new Map<string, PcrPoint[]>();

  /**
   * Option skew for a symbol ("RELIANCE.NS" → NSE symbol "RELIANCE").
   * 30-min cache; NOT_AVAILABLE responses carry the measured probe evidence.
   */
  async getSkew(ticker: string): Promise<OptionsSkewResponse> {
    const key = ticker.toUpperCase();
    const cached = this.resultCache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

    // Coverage gate FIRST (keeps NSE load bounded even if the API unblocks):
    // top-30 by market cap from the last rank build (cache-only, labeled
    // NIFTY-50-core fallback before the first build).
    const coverage = rankService.topTickersByMarketCap(COVERAGE_SIZE);
    if (!coverage.tickers.includes(key)) {
      const outOfScope: OptionsSkewResponse = {
        ticker: key,
        status: "NOT_AVAILABLE",
        pcr: null,
        pcr5dAvg: null,
        ivSkewPct: null,
        signal: null,
        expiry: null,
        asOf: new Date().toISOString(),
        note:
          `The options radar covers only the top ${COVERAGE_SIZE} universe tickers by market cap ` +
          `(${coverage.measured ? "measured from cached fundamentals" : "NIFTY-50-core fallback until the first rank build"}) ` +
          `to keep NSE load bounded. This ticker is outside that coverage.`,
        reason: `outside top-${COVERAGE_SIZE} coverage`,
        probedAt: null,
      };
      this.resultCache.set(key, { data: outOfScope, at: Date.now() });
      return outOfScope;
    }

    const symbol = key.replace(/\.(NS|BO)$/, "");
    const probe = await this.probe(symbol);

    let response: OptionsSkewResponse;
    if (!probe.ok || !probe.chain) {
      response = {
        ticker: key,
        status: "NOT_AVAILABLE",
        pcr: null,
        pcr5dAvg: null,
        ivSkewPct: null,
        signal: null,
        expiry: null,
        asOf: new Date().toISOString(),
        note:
          "NSE's option-chain API is blocked from this server by Akamai bot management " +
          "(measured evidence in `reason`). No mirror is scraped and nothing is fabricated — " +
          "this widget stays hidden until a probe succeeds. The probe re-runs at most every 30 minutes.",
        reason: probe.evidence,
        probedAt: probe.probedAt,
      };
    } else {
      response = this.computeSkew(key, probe.chain, probe.probedAt);
    }

    this.resultCache.set(key, { data: response, at: Date.now() });
    return response;
  }

  // ── Live probe (cookie warm-up + API attempt), cached 30 min ──────────────

  private async probe(symbol: string): Promise<ProbeOutcome> {
    if (this.probeCache && Date.now() - this.probeCache.at < CACHE_TTL_MS) {
      // A blocked probe answers for every ticker; a working probe is per-symbol
      // data, so only reuse cached BLOCKED outcomes globally.
      if (!this.probeCache.outcome.ok) return this.probeCache.outcome;
    }
    if (this.probeInFlight) {
      const shared = await this.probeInFlight;
      if (!shared.ok) return shared;
    }
    const run = this.runProbe(symbol).finally(() => {
      this.probeInFlight = null;
    });
    this.probeInFlight = run;
    const outcome = await run;
    if (!outcome.ok) this.probeCache = { outcome, at: Date.now() };
    return outcome;
  }

  private async runProbe(symbol: string): Promise<ProbeOutcome> {
    const probedAt = new Date().toISOString();
    const evidence: string[] = [];

    // Step 1 — cookie warm-up with a browser UA (Akamai wants a session).
    let cookieHeader = "";
    try {
      const warm = await axios.get<string>(WARMUP_URL, {
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        timeout: TIMEOUT_MS,
        responseType: "text",
        transformResponse: [(d): string => String(d)],
        validateStatus: () => true,
      });
      const setCookies = warm.headers["set-cookie"];
      cookieHeader = Array.isArray(setCookies)
        ? setCookies.map((c) => c.split(";")[0]).join("; ")
        : "";
      const server = String(warm.headers["server"] ?? "unknown");
      const marker = /access denied/i.test(warm.data ?? "") ? ", body 'Access Denied'" : "";
      const cookieNames = Array.isArray(setCookies)
        ? setCookies.map((c) => c.split("=")[0]).join(",")
        : "none";
      evidence.push(
        `warm-up GET ${WARMUP_URL} → HTTP ${warm.status} (server: ${server}${marker}; ` +
          `cookies granted: ${cookieNames || "none"})`
      );
    } catch (err) {
      evidence.push(`warm-up GET ${WARMUP_URL} failed: ${(err as Error).message}`);
    }

    // Step 2 — the option-chain API itself, reusing whatever cookies we got.
    try {
      const res = await axios.get(`${API_BASE}?symbol=${encodeURIComponent(symbol)}`, {
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "application/json",
          "Accept-Language": "en-US,en;q=0.9",
          Referer: "https://www.nseindia.com/option-chain",
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
        timeout: TIMEOUT_MS,
        validateStatus: () => true,
      });
      const body = res.data as NseOptionChain | string | null;
      const rows =
        body && typeof body === "object" ? body.records?.data ?? null : null;
      if (res.status === 200 && Array.isArray(rows) && rows.length > 0) {
        evidence.push(
          `option-chain API → HTTP 200 with ${rows.length} strike rows (usable data)`
        );
        return { ok: true, chain: body as NseOptionChain, evidence: evidence.join("; "), probedAt };
      }
      const size =
        typeof body === "string" ? body.length : JSON.stringify(body ?? {}).length;
      evidence.push(
        `option-chain API ${API_BASE}?symbol=${symbol} → HTTP ${res.status} with ` +
          `${Array.isArray(rows) ? `${rows.length} strike rows` : `no records.data (body ≈${size} bytes` +
            `${size <= 4 ? ", empty JSON — Akamai session withheld" : ""})`}`
      );
      return { ok: false, chain: null, evidence: evidence.join("; "), probedAt };
    } catch (err) {
      evidence.push(`option-chain API request failed: ${(err as Error).message}`);
      return { ok: false, chain: null, evidence: evidence.join("; "), probedAt };
    }
  }

  // ── Skew math (activates ONLY on a real option chain) ─────────────────────

  private computeSkew(
    ticker: string,
    chain: NseOptionChain,
    probedAt: string
  ): OptionsSkewResponse {
    const expiries = chain.records?.expiryDates ?? [];
    const underlying = chain.records?.underlyingValue ?? null;
    const all = chain.records?.data ?? [];
    const expiry = expiries.length > 0 ? expiries[0] : null;
    const rows = expiry ? all.filter((r) => r.expiryDate === expiry) : all;

    let putOi = 0;
    let callOi = 0;
    const putIvs: number[] = [];
    const callIvs: number[] = [];
    for (const r of rows) {
      const strike = r.strikePrice ?? null;
      if (r.PE?.openInterest && r.PE.openInterest > 0) putOi += r.PE.openInterest;
      if (r.CE?.openInterest && r.CE.openInterest > 0) callOi += r.CE.openInterest;
      if (strike !== null && underlying !== null && underlying > 0) {
        // ~25-delta proxy per spec: strikes ≥5% OTM (greeks are not served).
        if (strike <= underlying * 0.95 && r.PE?.impliedVolatility && r.PE.impliedVolatility > 0) {
          putIvs.push(r.PE.impliedVolatility);
        }
        if (strike >= underlying * 1.05 && r.CE?.impliedVolatility && r.CE.impliedVolatility > 0) {
          callIvs.push(r.CE.impliedVolatility);
        }
      }
    }

    const pcr = callOi > 0 ? Number((putOi / callOi).toFixed(3)) : null;
    const mean = (xs: number[]): number | null =>
      xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    const meanPutIv = mean(putIvs);
    const meanCallIv = mean(callIvs);
    const ivSkewPct =
      meanPutIv !== null && meanCallIv !== null
        ? Number((meanPutIv - meanCallIv).toFixed(2))
        : null;

    // 5-day PCR average kept in memory (today's value replaces same-day entry).
    let pcr5dAvg: number | null = null;
    let signal: OptionsSkewResponse["signal"] = null;
    if (pcr !== null) {
      const today = new Date().toISOString().slice(0, 10);
      const hist = (this.pcrHistory.get(ticker) ?? []).filter((p) => p.date !== today);
      hist.push({ date: today, pcr });
      while (hist.length > PCR_HISTORY_DAYS) hist.shift();
      this.pcrHistory.set(ticker, hist);
      pcr5dAvg = Number(
        (hist.reduce((s, p) => s + p.pcr, 0) / hist.length).toFixed(3)
      );
      signal = pcr > 1.2 && pcr5dAvg > 0 && pcr > 1.5 * pcr5dAvg ? "HEDGING_SPIKE" : "NEUTRAL";
    }

    return {
      ticker,
      status: "ok",
      pcr,
      pcr5dAvg,
      ivSkewPct,
      signal,
      expiry,
      asOf: new Date().toISOString(),
      note:
        "PCR = Σ put OI / Σ call OI for the nearest expiry; IV skew = mean IV of ≥5% OTM puts − " +
        "≥5% OTM calls (a ~25-delta proxy — NSE serves IVs, not greeks). HEDGING_SPIKE fires when " +
        "PCR > 1.2 AND > 1.5× its in-memory 5-day average. 30-min cache; live NSE data.",
      reason: null,
      probedAt,
    };
  }
}

/** Singleton export. */
export const optionsRadar = new OptionsRadar();
export default optionsRadar;
