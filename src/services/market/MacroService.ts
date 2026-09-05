/**
 * MacroService (Module V2-A) — India market regime from free Yahoo data:
 *
 *   - NIFTY 50 (^NSEI)      — reuses marketDataService.getNiftyBars (6h cache)
 *   - India VIX (^INDIAVIX) — chart API (verified: 10.68)
 *   - USDINR (INR=X)        — chart API (verified: 95.38)
 *
 * Regime score 0..100 (see scoreRegime): NIFTY above 200DMA +20, above 50DMA
 * +20 (half credit within 2% below), VIX zone 0..35, INR stability 0..25.
 * risk-on ≥ 65, risk-off ≤ 35, else neutral. Every note quotes real numbers.
 *
 * Result cached 6h in memory; on a fetch failure a stale (real) snapshot is
 * served if present, else the error propagates (callers degrade honestly).
 */

import { fetchChart } from "./yahoo";
import { marketDataService } from "./MarketDataService";
import { Bar, MarketRegime } from "./types";

const REGIME_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const VIX_TICKER = "^INDIAVIX";
const USDINR_TICKER = "INR=X";

function round2(x: number): number {
  const r = Math.round(x * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

/** Simple moving average of the last `period` values (null if too few). */
function sma(values: number[], period: number): number | null {
  if (values.length < period || period <= 0) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

function trailingReturnPct(closes: number[], k: number): number | null {
  if (closes.length < k + 1) return null;
  const past = closes[closes.length - 1 - k];
  if (past <= 0) return null;
  return (closes[closes.length - 1] / past - 1) * 100;
}

function vixZone(value: number): MarketRegime["vix"]["zone"] {
  if (value < 13) return "calm";
  if (value <= 17) return "normal";
  if (value <= 25) return "elevated";
  return "fear";
}

export class MacroService {
  private cache: { regime: MarketRegime; fetchedAt: number } | null = null;
  private inFlight: Promise<MarketRegime> | null = null;

  /** Market regime snapshot, cached 6h. */
  async getMarketRegime(): Promise<MarketRegime> {
    if (this.cache && Date.now() - this.cache.fetchedAt < REGIME_CACHE_TTL_MS) {
      return this.cache.regime;
    }
    if (!this.inFlight) {
      this.inFlight = this.buildRegime().finally(() => {
        this.inFlight = null;
      });
    }
    try {
      const regime = await this.inFlight;
      this.cache = { regime, fetchedAt: Date.now() };
      return regime;
    } catch (err) {
      // Serve a stale (real) snapshot over an error; never fabricate.
      if (this.cache) return this.cache.regime;
      throw err;
    }
  }

  /**
   * V10 B4 — cache-only regime peek: returns the fresh cached snapshot or
   * null, NEVER fetches. The buy-path entry-context snapshot uses this so
   * recording a trade adds zero extra network calls (honest null when cold).
   */
  peekRegime(): MarketRegime | null {
    return this.cache && Date.now() - this.cache.fetchedAt < REGIME_CACHE_TTL_MS
      ? this.cache.regime
      : null;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async buildRegime(): Promise<MarketRegime> {
    const [niftyBars, vixChart, inrChart] = await Promise.all([
      marketDataService.getNiftyBars("1y"),
      fetchChart(VIX_TICKER, "3mo"),
      fetchChart(USDINR_TICKER, "6mo"),
    ]);

    // ── NIFTY ──
    if (niftyBars.length < 50) {
      throw new Error(`Too few NIFTY bars (${niftyBars.length}) to compute the regime`);
    }
    const closes = niftyBars.map((b: Bar) => b.close);
    const price = closes[closes.length - 1];
    const sma50 = sma(closes, 50);
    const sma200 = sma(closes, 200);
    const vs50dmaPct = sma50 !== null && sma50 > 0 ? (price / sma50 - 1) * 100 : 0;
    const vs200dmaPct = sma200 !== null && sma200 > 0 ? (price / sma200 - 1) * 100 : 0;
    const r20dPct = trailingReturnPct(closes, 20) ?? 0;
    let trend: MarketRegime["nifty"]["trend"] = "sideways";
    if (sma50 !== null && sma200 !== null) {
      if (price > sma50 && sma50 > sma200) trend = "up";
      else if (price < sma50 && sma50 < sma200) trend = "down";
    } else if (sma50 !== null) {
      trend = price > sma50 ? "up" : price < sma50 ? "down" : "sideways";
    }

    // ── India VIX ──
    const vixValue =
      vixChart.meta.regularMarketPrice ??
      (vixChart.bars.length ? vixChart.bars[vixChart.bars.length - 1].close : null);
    if (vixValue === null || !Number.isFinite(vixValue)) {
      throw new Error("India VIX (^INDIAVIX) returned no usable value");
    }
    const zone = vixZone(vixValue);

    // ── USDINR ──
    const inrCloses = inrChart.bars.map((b) => b.close);
    const inrValue =
      inrChart.meta.regularMarketPrice ??
      (inrCloses.length ? inrCloses[inrCloses.length - 1] : null);
    if (inrValue === null || !Number.isFinite(inrValue)) {
      throw new Error("USDINR (INR=X) returned no usable value");
    }
    // INR=X quotes rupees per USD: a RISING value = WEAKENING rupee.
    const k = Math.min(60, Math.max(1, inrCloses.length - 1));
    const r60dPct = trailingReturnPct(inrCloses, k) ?? 0;
    const inrTrend: MarketRegime["usdinr"]["trend"] =
      r60dPct > 1.5 ? "weakening-inr" : r60dPct < -1.5 ? "strengthening-inr" : "stable";

    // ── Score (max 100 = 20 + 20 + 35 + 25) ──
    let score = 0;
    score += vs200dmaPct > 0 ? 20 : vs200dmaPct > -2 ? 10 : 0;
    score += vs50dmaPct > 0 ? 20 : vs50dmaPct > -2 ? 10 : 0;
    score += zone === "calm" ? 35 : zone === "normal" ? 25 : zone === "elevated" ? 12 : 0;
    score += inrTrend === "strengthening-inr" ? 25 : inrTrend === "stable" ? 18 : 5;
    score = Math.round(Math.min(100, Math.max(0, score)));

    const regime: MarketRegime["regime"] =
      score >= 65 ? "risk-on" : score <= 35 ? "risk-off" : "neutral";

    const fmtSigned = (x: number): string => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;
    const notes: string[] = [
      `NIFTY 50 at ${price.toFixed(0)}: ${fmtSigned(vs50dmaPct)} vs 50DMA, ` +
        `${fmtSigned(vs200dmaPct)} vs 200DMA, 20d return ${fmtSigned(r20dPct)} — trend ${trend}`,
      `India VIX ${vixValue.toFixed(2)} — ${zone} ` +
        `(zones: <13 calm, 13–17 normal, 17–25 elevated, >25 fear)`,
      `USDINR ${inrValue.toFixed(2)}, ${fmtSigned(r60dPct)} over ~${k} sessions — ${
        inrTrend === "stable"
          ? "rupee stable"
          : inrTrend === "weakening-inr"
            ? "rupee weakening (headwind for foreign flows)"
            : "rupee strengthening (supportive)"
      }`,
      `Regime score ${score}/100 → ${regime} (risk-on ≥65, risk-off ≤35)`,
    ];

    return {
      regime,
      score,
      nifty: {
        price: round2(price),
        vs50dmaPct: round2(vs50dmaPct),
        vs200dmaPct: round2(vs200dmaPct),
        trend,
        r20dPct: round2(r20dPct),
      },
      vix: { value: round2(vixValue), zone },
      usdinr: { value: round2(inrValue), r60dPct: round2(r60dPct), trend: inrTrend },
      notes,
      asOf: new Date().toISOString(),
    };
  }
}

/** Singleton export. */
export const macroService = new MacroService();
export default macroService;
