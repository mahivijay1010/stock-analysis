/**
 * GlobalSwingService — a DESCRIPTIVE screen of international (US + ADR + a few
 * home-market) large caps for a 10–15 trading-day swing window.
 *
 * What it measures: how much a stock typically moves day to day (ATR%), whether
 * its longer trend and drawdown look "stable", liquidity, and whether an
 * earnings print falls inside the window (gap risk). It ranks by how well the
 * past-volatility / past-trend profile fits "fluctuates a lot, but has been
 * growing steadily".
 *
 * What it does NOT do: predict direction. Nothing here is a forecast. The
 * academic record at the 2–4 week horizon is short-term REVERSAL, not momentum,
 * and that effect is weak after costs. The UNPROVEN label travels with every
 * number (honesty conventions). Entry/stop/target are ATR geometry, not calls.
 *
 * Data: Yahoo chart (daily bars, works for foreign listings) + Finnhub earnings
 * calendar (free tier). In-memory cache so the dashboard never re-fetches 50
 * charts on every click.
 */

import axios from "axios";
import { fetchChart } from "../market/yahoo";
import { Bar } from "../market/types";

export interface GlobalUniverseEntry {
  ticker: string; // Yahoo symbol
  name: string;
  market: "US" | "ADR" | "EU" | "JP" | "HK" | "KR" | "TW" | "OTHER";
  sector: string;
  /** Finnhub symbol for the earnings calendar when it differs from the Yahoo one. */
  finnhub?: string;
  /** How an Indian resident can buy it (LRS brokers mostly give US + ADR only). */
  access: "US_BROKER" | "ADR_ON_US" | "HOME_MARKET_ONLY";
  /** Manual next-earnings date (YYYY-MM-DD) used ONLY when the calendar API has nothing — from web research dated 2026-10-08; may be stale. */
  earningsHint?: string;
}

/** Curated seed universe. Volatile-but-growing large caps across sectors. */
export const GLOBAL_SWING_UNIVERSE: GlobalUniverseEntry[] = [
  // US semis / AI hardware
  { ticker: "NVDA", name: "NVIDIA", market: "US", sector: "Semiconductors", access: "US_BROKER" },
  { ticker: "AMD", name: "Advanced Micro Devices", market: "US", sector: "Semiconductors", access: "US_BROKER" },
  { ticker: "AVGO", name: "Broadcom", market: "US", sector: "Semiconductors", access: "US_BROKER" },
  { ticker: "MU", name: "Micron Technology", market: "US", sector: "Semiconductors", access: "US_BROKER" },
  { ticker: "AMAT", name: "Applied Materials", market: "US", sector: "Semi equipment", access: "US_BROKER" },
  { ticker: "LRCX", name: "Lam Research", market: "US", sector: "Semi equipment", access: "US_BROKER" },
  { ticker: "KLAC", name: "KLA Corp", market: "US", sector: "Semi equipment", access: "US_BROKER" },
  { ticker: "QCOM", name: "Qualcomm", market: "US", sector: "Semiconductors", access: "US_BROKER" },
  { ticker: "MRVL", name: "Marvell Technology", market: "US", sector: "Semiconductors", access: "US_BROKER" },
  { ticker: "ARM", name: "Arm Holdings (ADR)", market: "ADR", sector: "Semiconductors", access: "ADR_ON_US" },
  { ticker: "TSM", name: "Taiwan Semiconductor (ADR)", market: "ADR", sector: "Semiconductors", finnhub: "TSM", access: "ADR_ON_US" },
  { ticker: "ASML", name: "ASML Holding (ADR)", market: "ADR", sector: "Semi equipment", access: "ADR_ON_US" },
  // US mega-cap tech / software / internet
  { ticker: "MSFT", name: "Microsoft", market: "US", sector: "Software", access: "US_BROKER" },
  { ticker: "AAPL", name: "Apple", market: "US", sector: "Consumer tech", access: "US_BROKER" },
  { ticker: "GOOGL", name: "Alphabet", market: "US", sector: "Internet", access: "US_BROKER" },
  { ticker: "AMZN", name: "Amazon", market: "US", sector: "Internet / cloud", access: "US_BROKER" },
  { ticker: "META", name: "Meta Platforms", market: "US", sector: "Internet", access: "US_BROKER" },
  { ticker: "NFLX", name: "Netflix", market: "US", sector: "Media", access: "US_BROKER" },
  { ticker: "ORCL", name: "Oracle", market: "US", sector: "Software / cloud", access: "US_BROKER" },
  { ticker: "CRM", name: "Salesforce", market: "US", sector: "Software", access: "US_BROKER" },
  { ticker: "NOW", name: "ServiceNow", market: "US", sector: "Software", access: "US_BROKER" },
  { ticker: "PANW", name: "Palo Alto Networks", market: "US", sector: "Cybersecurity", access: "US_BROKER" },
  { ticker: "CRWD", name: "CrowdStrike", market: "US", sector: "Cybersecurity", access: "US_BROKER" },
  { ticker: "UBER", name: "Uber", market: "US", sector: "Platforms", access: "US_BROKER" },
  { ticker: "SHOP", name: "Shopify", market: "US", sector: "E-commerce software", access: "US_BROKER" },
  { ticker: "MELI", name: "MercadoLibre", market: "US", sector: "E-commerce (LatAm)", access: "US_BROKER" },
  { ticker: "TSLA", name: "Tesla", market: "US", sector: "Autos / energy", access: "US_BROKER" },
  { ticker: "PLTR", name: "Palantir", market: "US", sector: "Software / AI", access: "US_BROKER" },
  // US industrials / power / infra
  { ticker: "VRT", name: "Vertiv", market: "US", sector: "Data-centre power", access: "US_BROKER" },
  { ticker: "ETN", name: "Eaton", market: "US", sector: "Electrical", access: "US_BROKER" },
  { ticker: "GE", name: "GE Aerospace", market: "US", sector: "Aerospace", access: "US_BROKER" },
  { ticker: "CAT", name: "Caterpillar", market: "US", sector: "Machinery", access: "US_BROKER" },
  { ticker: "DE", name: "Deere", market: "US", sector: "Machinery", access: "US_BROKER" },
  { ticker: "GEV", name: "GE Vernova", market: "US", sector: "Power equipment", access: "US_BROKER" },
  // US financials / payments
  { ticker: "JPM", name: "JPMorgan Chase", market: "US", sector: "Banks", access: "US_BROKER" },
  { ticker: "GS", name: "Goldman Sachs", market: "US", sector: "Investment banking", access: "US_BROKER" },
  { ticker: "V", name: "Visa", market: "US", sector: "Payments", access: "US_BROKER" },
  { ticker: "MA", name: "Mastercard", market: "US", sector: "Payments", access: "US_BROKER" },
  { ticker: "COIN", name: "Coinbase", market: "US", sector: "Crypto exchange", access: "US_BROKER" },
  // US healthcare / consumer / energy
  { ticker: "LLY", name: "Eli Lilly", market: "US", sector: "Pharma", access: "US_BROKER" },
  { ticker: "ISRG", name: "Intuitive Surgical", market: "US", sector: "Med-tech", access: "US_BROKER" },
  { ticker: "UNH", name: "UnitedHealth", market: "US", sector: "Health insurance", access: "US_BROKER" },
  { ticker: "COST", name: "Costco", market: "US", sector: "Retail", access: "US_BROKER" },
  { ticker: "XOM", name: "ExxonMobil", market: "US", sector: "Energy", access: "US_BROKER" },
  { ticker: "CVX", name: "Chevron", market: "US", sector: "Energy", access: "US_BROKER" },
  { ticker: "ANET", name: "Arista Networks", market: "US", sector: "Networking", access: "US_BROKER" },
  { ticker: "DDOG", name: "Datadog", market: "US", sector: "Software", access: "US_BROKER" },
  { ticker: "PWR", name: "Quanta Services", market: "US", sector: "Infrastructure", access: "US_BROKER" },
  { ticker: "CEG", name: "Constellation Energy", market: "US", sector: "Power", access: "US_BROKER" },
  { ticker: "URI", name: "United Rentals", market: "US", sector: "Industrials", access: "US_BROKER" },
  { ticker: "KKR", name: "KKR", market: "US", sector: "Alt. asset manager", access: "US_BROKER" },
  { ticker: "BX", name: "Blackstone", market: "US", sector: "Alt. asset manager", access: "US_BROKER" },
  { ticker: "SCHW", name: "Charles Schwab", market: "US", sector: "Brokerage", access: "US_BROKER" },
  { ticker: "BKNG", name: "Booking Holdings", market: "US", sector: "Travel", access: "US_BROKER" },
  { ticker: "FSLR", name: "First Solar", market: "US", sector: "Solar", access: "US_BROKER" },
  { ticker: "IFX.DE", name: "Infineon", market: "EU", sector: "Semiconductors", access: "HOME_MARKET_ONLY", earningsHint: "2026-11-10" },
  // ADRs of non-US companies (buyable on a US broker)
  { ticker: "NVO", name: "Novo Nordisk (ADR)", market: "ADR", sector: "Pharma", access: "ADR_ON_US" , earningsHint: "2026-11-04" },
  { ticker: "SAP", name: "SAP (ADR)", market: "ADR", sector: "Software", access: "ADR_ON_US" },
  { ticker: "SONY", name: "Sony Group (ADR)", market: "ADR", sector: "Electronics / media", access: "ADR_ON_US" , earningsHint: "2026-11-05" },
  { ticker: "TM", name: "Toyota (ADR)", market: "ADR", sector: "Autos", access: "ADR_ON_US" , earningsHint: "2026-11-05" },
  { ticker: "BABA", name: "Alibaba (ADR)", market: "ADR", sector: "Internet (China)", access: "ADR_ON_US" },
  { ticker: "PDD", name: "PDD Holdings (ADR)", market: "ADR", sector: "E-commerce (China)", access: "ADR_ON_US" },
  { ticker: "TCEHY", name: "Tencent (ADR, OTC)", market: "ADR", sector: "Internet (China)", access: "ADR_ON_US" , earningsHint: "2026-11-18" },
  { ticker: "TTE", name: "TotalEnergies (ADR)", market: "ADR", sector: "Energy", access: "ADR_ON_US" },
  { ticker: "RIO", name: "Rio Tinto (ADR)", market: "ADR", sector: "Mining", access: "ADR_ON_US" },
  { ticker: "SE", name: "Sea Ltd (ADR)", market: "ADR", sector: "Internet (SE Asia)", access: "ADR_ON_US" },
  { ticker: "SPOT", name: "Spotify", market: "ADR", sector: "Media", access: "ADR_ON_US" },
  // Home-market listings (reference; usually NOT reachable from Indian LRS brokers)
  { ticker: "RHM.DE", name: "Rheinmetall", market: "EU", sector: "Defence", access: "HOME_MARKET_ONLY" , earningsHint: "2026-11-05" },
  { ticker: "SIE.DE", name: "Siemens", market: "EU", sector: "Industrials", access: "HOME_MARKET_ONLY" , earningsHint: "2026-11-12" },
  { ticker: "MC.PA", name: "LVMH", market: "EU", sector: "Luxury", access: "HOME_MARKET_ONLY" , earningsHint: "2026-10-12" },
  { ticker: "SU.PA", name: "Schneider Electric", market: "EU", sector: "Electrical", access: "HOME_MARKET_ONLY" , earningsHint: "2026-10-28" },
  { ticker: "8035.T", name: "Tokyo Electron", market: "JP", sector: "Semi equipment", access: "HOME_MARKET_ONLY" , earningsHint: "2026-10-30" },
  { ticker: "6857.T", name: "Advantest", market: "JP", sector: "Semi test", access: "HOME_MARKET_ONLY" , earningsHint: "2026-10-28" },
  { ticker: "6501.T", name: "Hitachi", market: "JP", sector: "Industrials", access: "HOME_MARKET_ONLY" , earningsHint: "2026-10-28" },
  { ticker: "9984.T", name: "SoftBank Group", market: "JP", sector: "Tech holding", access: "HOME_MARKET_ONLY" , earningsHint: "2026-11-10" },
  { ticker: "0700.HK", name: "Tencent", market: "HK", sector: "Internet (China)", access: "HOME_MARKET_ONLY" , earningsHint: "2026-11-18" },
  { ticker: "1211.HK", name: "BYD", market: "HK", sector: "EVs", access: "HOME_MARKET_ONLY" , earningsHint: "2026-10-30" },
  { ticker: "1810.HK", name: "Xiaomi", market: "HK", sector: "Consumer tech", access: "HOME_MARKET_ONLY" , earningsHint: "2026-11-20" },
  { ticker: "005930.KS", name: "Samsung Electronics", market: "KR", sector: "Semiconductors", access: "HOME_MARKET_ONLY" , earningsHint: "2026-10-28" },
  { ticker: "000660.KS", name: "SK Hynix", market: "KR", sector: "Memory", access: "HOME_MARKET_ONLY" , earningsHint: "2026-10-28" },
];

export type SwingTier = "SHORTLIST" | "WATCH" | "AVOID";

export interface GlobalSwingRow {
  ticker: string;
  name: string;
  market: GlobalUniverseEntry["market"];
  sector: string;
  access: GlobalUniverseEntry["access"];
  currency: string;
  price: number;
  asOf: string; // last bar date
  bars: number;
  // fluctuation
  atrPct20: number; // avg true range / close, %
  dailyVolPct20: number; // sd of daily log returns, %
  typicalMove12dPct: number; // atrPct20 * sqrt(12): size of a TYPICAL 12-day move, not a forecast
  // stability / trend
  ret20Pct: number;
  ret60Pct: number;
  ret120Pct: number;
  sma50: number | null;
  sma200: number | null;
  aboveSma50: boolean | null;
  aboveSma200: boolean | null;
  maxDrawdown120Pct: number; // negative number
  pos52w: number | null; // 0..1 within 52w range
  avgValue20: number; // native currency traded per day (price*volume)
  // events
  earningsDate: string | null;
  earningsInWindow: boolean | null; // null = unknown (no calendar data)
  earningsSource: "finnhub" | "manual" | null;
  // geometry (ATR-based; not a prediction)
  plan: { entry: number; stop: number; target: number; stopPct: number; targetPct: number; rewardRisk: number };
  // verdict
  score: number; // 0..100 descriptive fit
  tier: SwingTier;
  reasons: string[];
  blocks: string[];
  /** Round-trip cost for an Indian LRS investor, % of notional (FX + brokerage), scenario not quote. */
  roundTripCostPct: number;
}

export interface GlobalSwingBoard {
  generatedAt: string;
  windowTradingDays: [number, number];
  earningsWindowEnd: string;
  context: { spy: ContextRow | null; vix: ContextRow | null } ;
  shortlist: GlobalSwingRow[];
  watch: GlobalSwingRow[];
  avoid: GlobalSwingRow[];
  failed: Array<{ ticker: string; error: string }>;
  caveat: string;
  method: string[];
  evidence: { status: "UNPROVEN"; gradedOutcomes: number; note: string };
}

interface ContextRow { symbol: string; last: number; ret5Pct: number; ret20Pct: number; asOf: string }

const WINDOW_DAYS: [number, number] = [10, 15];
const CACHE_TTL_MS = 30 * 60_000;
const EARNINGS_TTL_MS = 12 * 60 * 60_000;
const CONCURRENCY = 5;
/** Scenario for an Indian resident via an LRS broker: FX spread ~0.5% each way + brokerage ~0.1–0.25% each way. */
const ROUND_TRIP_COST_PCT = 1.3;

const CAVEAT =
  "UNPROVEN. This is a descriptive screen of past volatility, trend and liquidity — not a forecast. " +
  "Nothing here has a demonstrated edge; published evidence at the 2–4 week horizon points to weak short-term REVERSAL, not momentum, and it mostly disappears after costs. " +
  "Entry/stop/target are ATR geometry so the loss is defined first; they are not predictions. Earnings inside the window are gap risk. " +
  "An Indian resident pays FX spread, brokerage and 20% TCS cash-flow on LRS remittances above the threshold — a 10–15 day round trip costs roughly " +
  ROUND_TRIP_COST_PCT + "% before any move.";

const METHOD = [
  "Universe: curated large caps (US, ADRs, and home-market listings) — not an exhaustive scan.",
  "Fluctuation: 20-day ATR as % of price. In-band is 1.5%–4.5%; above 5% is treated as too wild for a 'not too risky' profile.",
  "Stability: 120-day return, position vs 50/200-day averages, and the worst 120-day drawdown.",
  "Liquidity: 20-day average traded value in the listing's currency.",
  "Event risk: Finnhub earnings calendar, flagged when the date falls inside the next 15 trading days.",
  "Score = trend 30 + 60-day return 20 + ATR-band fit 20 + drawdown control 15 + liquidity 15, minus 25 for earnings in window. Hard blocks: ATR > 5%, drawdown worse than −40% in 120 days, down > 15% over 120 days, thin volume. SHORTLIST ≥ 65 with no hard block; WATCH ≥ 45; else AVOID.",
  "Earnings dates come from Finnhub; for home-market listings the free calendar is empty, so a manually researched date (2026-10-08) is used and labelled — verify before acting.",
];

function sma(values: number[], n: number): number | null {
  if (values.length < n) return null;
  let s = 0;
  for (let i = values.length - n; i < values.length; i++) s += values[i];
  return s / n;
}
function pctChange(a: number, b: number): number {
  return a > 0 ? ((b - a) / a) * 100 : 0;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function round(v: number, d = 2): number {
  const m = Math.pow(10, d);
  return Math.round(v * m) / m;
}
function addTradingDays(from: Date, n: number): Date {
  const d = new Date(from);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d;
}
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function computeSwingMetrics(entry: GlobalUniverseEntry, bars: Bar[], currency: string, earnings: { date: string | null; known: boolean; source?: "manual" }, earningsWindowEnd: string): GlobalSwingRow {
  const closes = bars.map((b) => b.close);
  const last = bars[bars.length - 1];
  const n = bars.length;
  // ATR 20
  const trs: number[] = [];
  for (let i = Math.max(1, n - 20); i < n; i++) {
    const b = bars[i];
    const pc = bars[i - 1].close;
    trs.push(Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc)));
  }
  const atr = trs.length ? trs.reduce((a, b) => a + b, 0) / trs.length : 0;
  const atrPct20 = (atr / last.close) * 100;
  // daily vol 20
  const rets: number[] = [];
  for (let i = Math.max(1, n - 20); i < n; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length);
  const dailyVolPct20 = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1)) * 100;
  const retN = (k: number) => (n > k ? pctChange(closes[n - 1 - k], closes[n - 1]) : 0);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  // max drawdown over last 120
  let peak = -Infinity;
  let mdd = 0;
  for (let i = Math.max(0, n - 120); i < n; i++) {
    peak = Math.max(peak, closes[i]);
    mdd = Math.min(mdd, ((closes[i] - peak) / peak) * 100);
  }
  const win52 = closes.slice(-252);
  const hi52 = Math.max(...win52);
  const lo52 = Math.min(...win52);
  const pos52w = hi52 > lo52 ? (last.close - lo52) / (hi52 - lo52) : null;
  const vals = bars.slice(-20).map((b) => b.close * b.volume);
  const avgValue20 = vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length);

  const earningsInWindow = earnings.known ? earnings.date != null && earnings.date <= earningsWindowEnd : null;

  // --- scoring (descriptive fit, not probability) ---
  const reasons: string[] = [];
  const blocks: string[] = [];
  let score = 0;
  // trend 30
  const above50 = sma50 != null ? last.close > sma50 : null;
  const above200 = sma200 != null ? last.close > sma200 : null;
  if (above200 === true) { score += 18; reasons.push("above 200-day average"); } else if (above200 === false) reasons.push("below 200-day average");
  if (above50 === true) { score += 12; reasons.push("above 50-day average"); } else if (above50 === false) reasons.push("below 50-day average");
  // 60d return 20 (0 at ≤ -10%, 20 at ≥ +20%)
  const r60 = retN(60);
  score += clamp(((r60 + 10) / 30) * 20, 0, 20);
  if (r60 > 0) reasons.push(`+${round(r60, 1)}% over 60 days`); else reasons.push(`${round(r60, 1)}% over 60 days`);
  // ATR band 20 (peak at 3%, zero at 1% and 5.5%)
  const bandFit = atrPct20 <= 3 ? clamp((atrPct20 - 1) / 2, 0, 1) : clamp((5.5 - atrPct20) / 2.5, 0, 1);
  score += bandFit * 20;
  if (atrPct20 < 1.5) reasons.push(`quiet: ATR ${round(atrPct20, 1)}%/day`);
  else if (atrPct20 > 4.5) reasons.push(`wild: ATR ${round(atrPct20, 1)}%/day`);
  else reasons.push(`ATR ${round(atrPct20, 1)}%/day in band`);
  if (atrPct20 > 5) blocks.push("ATR above 5%/day — too wild for a low-risk profile");
  // drawdown control 15 (15 at ≥ -10%, 0 at ≤ -35%)
  score += clamp(((mdd + 35) / 25) * 15, 0, 15);
  if (mdd < -25) reasons.push(`deep ${round(mdd, 0)}% drawdown in last 120 days`);
  // liquidity 15 (USD-equivalent not computed; use native value with a generous floor)
  const liqScore = avgValue20 >= 5e8 ? 15 : avgValue20 >= 1e8 ? 10 : avgValue20 >= 2e7 ? 5 : 0;
  score += liqScore;
  if (liqScore === 0) blocks.push("thin: under 20M/day traded value");
  // earnings
  if (earningsInWindow === true) { score -= 25; reasons.push(`earnings ${earnings.date}${earnings.source === "manual" ? " (manual date, verify)" : ""} inside window — gap risk`); }
  else if (earningsInWindow === null) reasons.push("earnings date unknown");
  if (mdd < -40) blocks.push(`fell ${round(mdd, 0)}% inside the last 120 days — not a low-risk profile`);
  if (retN(120) <= -15) blocks.push("down more than 15% over 120 days — not a stable grower");
  if (bars.length < 60) blocks.push("fewer than 60 daily bars");

  score = clamp(round(score, 1), 0, 100);
  const tier: SwingTier = blocks.length ? "AVOID" : score >= 65 ? "SHORTLIST" : score >= 45 ? "WATCH" : "AVOID";

  const stop = last.close - 2 * atr;
  const target = last.close + 3 * atr;
  return {
    ticker: entry.ticker,
    name: entry.name,
    market: entry.market,
    sector: entry.sector,
    access: entry.access,
    currency,
    price: round(last.close),
    asOf: last.date,
    bars: n,
    atrPct20: round(atrPct20),
    dailyVolPct20: round(dailyVolPct20),
    typicalMove12dPct: round(atrPct20 * Math.sqrt(12), 1),
    ret20Pct: round(retN(20), 1),
    ret60Pct: round(r60, 1),
    ret120Pct: round(retN(120), 1),
    sma50: sma50 != null ? round(sma50) : null,
    sma200: sma200 != null ? round(sma200) : null,
    aboveSma50: above50,
    aboveSma200: above200,
    maxDrawdown120Pct: round(mdd, 1),
    pos52w: pos52w != null ? round(pos52w, 2) : null,
    avgValue20: Math.round(avgValue20),
    earningsDate: earnings.date,
    earningsInWindow,
    earningsSource: earnings.known ? (earnings.source ?? "finnhub") : null,
    plan: {
      entry: round(last.close),
      stop: round(stop),
      target: round(target),
      stopPct: round(((stop - last.close) / last.close) * 100, 1),
      targetPct: round(((target - last.close) / last.close) * 100, 1),
      rewardRisk: 1.5,
    },
    score,
    tier,
    reasons,
    blocks,
    roundTripCostPct: ROUND_TRIP_COST_PCT,
  };
}

export class GlobalSwingService {
  private cache: { at: number; board: GlobalSwingBoard } | null = null;
  private earningsCache = new Map<string, { at: number; date: string | null; known: boolean; source?: "manual" }>();
  private inflight: Promise<GlobalSwingBoard> | null = null;

  async board(force = false): Promise<GlobalSwingBoard> {
    if (!force && this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.board;
    if (this.inflight) return this.inflight;
    this.inflight = this.build().finally(() => (this.inflight = null));
    const board = await this.inflight;
    this.cache = { at: Date.now(), board };
    return board;
  }

  private async build(): Promise<GlobalSwingBoard> {
    const now = new Date();
    const earningsWindowEnd = isoDate(addTradingDays(now, WINDOW_DAYS[1]));
    const rows: GlobalSwingRow[] = [];
    const failed: Array<{ ticker: string; error: string }> = [];
    const queue = [...GLOBAL_SWING_UNIVERSE];
    const worker = async () => {
      for (;;) {
        const entry = queue.shift();
        if (!entry) return;
        try {
          const chart = await fetchChart(entry.ticker, "1y");
          if (chart.bars.length < 30) throw new Error(`only ${chart.bars.length} bars`);
          let earnings = await this.nextEarnings(entry.finnhub ?? entry.ticker, now);
          if (!earnings.known && entry.earningsHint) earnings = { date: entry.earningsHint, known: true, source: "manual" };
          rows.push(computeSwingMetrics(entry, chart.bars, chart.meta.currency ?? "USD", earnings, earningsWindowEnd));
        } catch (err) {
          failed.push({ ticker: entry.ticker, error: err instanceof Error ? err.message : String(err) });
        }
      }
    };
    const [spy, vix] = await Promise.all([this.context("SPY"), this.context("^VIX")]);
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    const byScore = (a: GlobalSwingRow, b: GlobalSwingRow) => b.score - a.score;
    return {
      generatedAt: now.toISOString(),
      windowTradingDays: WINDOW_DAYS,
      earningsWindowEnd,
      context: { spy, vix },
      shortlist: rows.filter((r) => r.tier === "SHORTLIST").sort(byScore),
      watch: rows.filter((r) => r.tier === "WATCH").sort(byScore),
      avoid: rows.filter((r) => r.tier === "AVOID").sort(byScore),
      failed,
      caveat: CAVEAT,
      method: METHOD,
      evidence: { status: "UNPROVEN", gradedOutcomes: 0, note: "No forward outcomes have been graded for this screen yet. No hit rate is shown below 10 graded outcomes." },
    };
  }

  private async context(symbol: string): Promise<ContextRow | null> {
    try {
      const c = await fetchChart(symbol, "3mo");
      const closes = c.bars.map((b) => b.close);
      const n = closes.length;
      if (n < 21) return null;
      return { symbol, last: round(closes[n - 1]), ret5Pct: round(pctChange(closes[n - 6], closes[n - 1]), 1), ret20Pct: round(pctChange(closes[n - 21], closes[n - 1]), 1), asOf: c.bars[n - 1].date };
    } catch {
      return null;
    }
  }

  private bulkEarnings: { at: number; from: string; map: Map<string, string> } | null = null;

  /** One bulk calendar call (cached 12h) covers most US names; per-symbol fallback for the rest. */
  private async loadBulkEarnings(now: Date, key: string): Promise<Map<string, string>> {
    const from = isoDate(now);
    if (this.bulkEarnings && this.bulkEarnings.from === from && Date.now() - this.bulkEarnings.at < EARNINGS_TTL_MS) return this.bulkEarnings.map;
    const map = new Map<string, string>();
    try {
      const to = isoDate(addTradingDays(now, 60));
      const res = await axios.get("https://finnhub.io/api/v1/calendar/earnings", { params: { from, to, token: key }, timeout: 12000 });
      const list: Array<{ symbol?: string; date?: string }> = Array.isArray(res.data?.earningsCalendar) ? res.data.earningsCalendar : [];
      for (const e of list) {
        if (typeof e.symbol !== "string" || typeof e.date !== "string") continue;
        const prev = map.get(e.symbol);
        if (!prev || e.date < prev) map.set(e.symbol, e.date);
      }
      this.bulkEarnings = { at: Date.now(), from, map };
    } catch {
      /* fall through: per-symbol calls will try */
    }
    return map;
  }

  /** Next earnings date from Finnhub (free tier). known=false when no key or the lookup failed. */
  private async nextEarnings(symbol: string, now: Date): Promise<{ date: string | null; known: boolean; source?: "manual" }> {
    const key = process.env.FINNHUB_API_KEY;
    if (!key) return { date: null, known: false };
    const bulk = await this.loadBulkEarnings(now, key);
    const fromBulk = bulk.get(symbol);
    if (fromBulk) return { date: fromBulk, known: true };
    const hit = this.earningsCache.get(symbol);
    if (hit && Date.now() - hit.at < EARNINGS_TTL_MS) return hit;
    try {
      const res = await axios.get("https://finnhub.io/api/v1/calendar/earnings", {
        params: { from: isoDate(now), to: isoDate(addTradingDays(now, 60)), symbol, token: key },
        timeout: 8000,
      });
      const list: Array<{ date?: string }> = Array.isArray(res.data?.earningsCalendar) ? res.data.earningsCalendar : [];
      const dates = list.map((e) => e.date).filter((d): d is string => typeof d === "string").sort();
      const out = { at: Date.now(), date: dates[0] ?? null, known: true };
      this.earningsCache.set(symbol, out);
      return out;
    } catch {
      return { date: null, known: false };
    }
  }
}

export const globalSwingService = new GlobalSwingService();
