/**
 * HoldingsService — stateless "what profit can I book" calculator.
 *
 * Given a stock, a buy price (or a buy date, resolved to the nearest
 * trading-day close), and a quantity (or a ₹ amount), computes the profit
 * you could book right now (net of real delivery fees), how that compares
 * to NIFTY over the same period, and — using the SAME quant predictions the
 * rest of the app relies on — what booking later at each horizon (1/3/7/15/30
 * days) would look like instead. No persistence: every call is a fresh
 * what-if against live data.
 */

import { marketDataService } from "../market/MarketDataService";
import { analyzeBars } from "../quant/engine";
import { estimateBuyFees, estimateSellFees } from "../framework/fees";
import { Bar, HoldingCalcRequest, HoldingCalcResponse, HttpError } from "../../types";

function round2(x: number): number {
  const r = Math.round(x * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

/** YYYY-MM-DD in Asia/Kolkata. */
function istDateString(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function calendarDaysBetween(fromDate: string, toDate: string): number {
  const [fy, fm, fd] = fromDate.split("-").map(Number);
  const [ty, tm, td] = toDate.split("-").map(Number);
  const from = Date.UTC(fy, fm - 1, fd);
  const to = Date.UTC(ty, tm - 1, td);
  return Math.round((to - from) / 86_400_000);
}

/** Latest bar with date <= targetDate, or null if none (targetDate predates all bars). */
function barOnOrBefore(bars: Bar[], targetDate: string): Bar | null {
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].date <= targetDate) return bars[i];
  }
  return null;
}

export class HoldingsService {
  async calculate(req: HoldingCalcRequest): Promise<HoldingCalcResponse> {
    if (!req.ticker || typeof req.ticker !== "string" || !req.ticker.trim()) {
      throw new HttpError(400, '"ticker" is required, e.g. { "ticker": "SBIN", "buyPrice": 10, "amount": 10000 }.');
    }
    const resolved = await marketDataService.resolve(req.ticker.trim());
    if (!resolved) {
      throw new HttpError(404, `Could not resolve "${req.ticker}" to an Indian (NSE/BSE) listing.`);
    }
    const ticker = resolved.ticker;

    if (req.buyPrice === undefined && !req.buyDate) {
      throw new HttpError(400, 'Provide either "buyPrice" (₹) or "buyDate" (YYYY-MM-DD).');
    }
    if (req.quantity === undefined && req.amount === undefined) {
      throw new HttpError(400, 'Provide either "quantity" (shares) or "amount" (₹ invested).');
    }

    const today = istDateString(new Date());
    let buyDateRequested: string | null = null;

    // 5y bars cover both quant scoring (needs ≥60, ideally ≥200 for SMA200)
    // and buy-date resolution far back in time — one fetch serves everything.
    const bars = await marketDataService.getDailyBars(ticker, "5y");
    if (bars.length < 60) {
      throw new HttpError(502, `Not enough price history for ${ticker} to run an analysis (only ${bars.length} bars).`);
    }

    let buyPrice: number;
    let buyDateUsed: string | null = null;
    if (req.buyPrice !== undefined) {
      const p = Number(req.buyPrice);
      if (!Number.isFinite(p) || p <= 0) {
        throw new HttpError(400, '"buyPrice" must be a positive number.');
      }
      buyPrice = p;
    } else {
      const dateStr = String(req.buyDate);
      if (!DATE_RE.test(dateStr) || Number.isNaN(new Date(`${dateStr}T00:00:00Z`).getTime())) {
        throw new HttpError(400, '"buyDate" must be in YYYY-MM-DD format.');
      }
      if (dateStr > today) {
        throw new HttpError(400, '"buyDate" cannot be in the future.');
      }
      buyDateRequested = dateStr;
      const bar = barOnOrBefore(bars, dateStr);
      if (!bar) {
        throw new HttpError(
          400,
          `No price history for ${ticker} on or before ${dateStr} (earliest available: ${bars[0].date}).`
        );
      }
      buyPrice = bar.close;
      buyDateUsed = bar.date;
    }

    let quantity: number;
    if (req.quantity !== undefined) {
      const q = Math.floor(Number(req.quantity));
      if (!Number.isFinite(q) || q <= 0) {
        throw new HttpError(400, '"quantity" must be a positive integer.');
      }
      quantity = q;
    } else {
      const amt = Number(req.amount);
      if (!Number.isFinite(amt) || amt <= 0) {
        throw new HttpError(400, '"amount" must be a positive number.');
      }
      quantity = Math.floor(amt / buyPrice);
    }

    // Live price, with a same-day-close fallback if the quote endpoint is down.
    let currentPrice: number;
    let asOf: string;
    let dataStatus: "live" | "cached";
    try {
      const quote = await marketDataService.getQuote(ticker);
      currentPrice = quote.price;
      asOf = quote.asOf;
      dataStatus = "live";
    } catch {
      const last = bars[bars.length - 1];
      currentPrice = last.close;
      asOf = new Date(`${last.date}T15:30:00+05:30`).toISOString();
      dataStatus = "cached";
    }

    const analysis = analyzeBars(bars);

    const invested = round2(quantity * buyPrice);
    const currentValue = round2(quantity * currentPrice);
    const grossProfit = round2(currentValue - invested);
    const grossProfitPct = buyPrice > 0 ? round2((currentPrice / buyPrice - 1) * 100) : 0;

    const buyFees = estimateBuyFees(invested);
    const sellFees = estimateSellFees(currentValue);
    const roundTripFees = round2(buyFees + sellFees);
    const netProfit = round2(grossProfit - roundTripFees);
    const netProfitPct = invested > 0 ? round2((netProfit / invested) * 100) : 0;

    let daysHeld: number | null = null;
    let annualizedReturnPct: number | null = null;
    if (buyDateUsed) {
      daysHeld = Math.max(0, calendarDaysBetween(buyDateUsed, today));
      if (daysHeld > 0 && buyPrice > 0) {
        annualizedReturnPct = round2((Math.pow(currentPrice / buyPrice, 365 / daysHeld) - 1) * 100);
      }
    }

    let niftyComparison: { returnPct: number; outperformancePct: number } | null = null;
    if (buyDateUsed) {
      try {
        const niftyBars = await marketDataService.getNiftyBars("1y");
        const niftyBuy = barOnOrBefore(niftyBars, buyDateUsed);
        const niftyNow = niftyBars[niftyBars.length - 1] ?? null;
        if (niftyBuy && niftyNow && niftyBuy.close > 0) {
          const niftyReturnPct = round2((niftyNow.close / niftyBuy.close - 1) * 100);
          niftyComparison = {
            returnPct: niftyReturnPct,
            outperformancePct: round2(grossProfitPct - niftyReturnPct),
          };
        }
      } catch {
        niftyComparison = null; // honest degrade — never fabricate
      }
    }

    const forwardProjections = analysis.predictions.map((p) => {
      const expectedValue = round2(quantity * p.expectedPrice);
      const lowValue = round2(quantity * p.lowPrice);
      const highValue = round2(quantity * p.highPrice);
      const expectedProfit = round2(expectedValue - invested);
      return {
        horizonDays: p.horizonDays,
        expectedValue,
        lowValue,
        highValue,
        expectedProfit,
        expectedProfitPct: invested > 0 ? round2((expectedProfit / invested) * 100) : 0,
      };
    });

    const note = this.buildNote({
      quantity,
      netProfit,
      netProfitPct,
      recommendation: analysis.recommendation,
      score: analysis.score,
      forwardProjections,
    });

    return {
      ticker,
      name: resolved.name,
      buyPrice: round2(buyPrice),
      buyDateRequested,
      buyDateUsed,
      currentPrice: round2(currentPrice),
      dataStatus,
      asOf,
      quantity,
      invested,
      currentValue,
      grossProfit,
      grossProfitPct,
      fees: { buy: buyFees, sell: sellFees, roundTrip: roundTripFees },
      netProfit,
      netProfitPct,
      daysHeld,
      annualizedReturnPct,
      niftyComparison,
      recommendation: analysis.recommendation,
      score: analysis.score,
      forwardProjections,
      note,
    };
  }

  private buildNote(args: {
    quantity: number;
    netProfit: number;
    netProfitPct: number;
    recommendation: "BUY" | "HOLD" | "AVOID";
    score: number;
    forwardProjections: HoldingCalcResponse["forwardProjections"];
  }): string {
    const { quantity, netProfit, netProfitPct, recommendation, score, forwardProjections } = args;
    const inr = (x: number) =>
      `₹${Math.abs(x).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    if (quantity <= 0) {
      return "The amount entered is too small to buy even 1 share at this price — no position, no profit to book.";
    }

    const bookNow =
      netProfit >= 0
        ? `Booking now locks in a net profit of ${inr(netProfit)} (+${netProfitPct.toFixed(2)}%) after fees.`
        : `Booking now realizes a net loss of ${inr(netProfit)} (${netProfitPct.toFixed(2)}%) after fees.`;

    const h7 = forwardProjections.find((p) => p.horizonDays === 7);
    const holdView = h7
      ? `The model currently rates this stock ${recommendation} (score ${score}/100); ` +
        `if you hold, its 7-day forecast expects ${h7.expectedProfit >= 0 ? "+" : "-"}${inr(
          h7.expectedProfit
        )} vs your cost (range ${inr(h7.lowValue)}–${inr(h7.highValue)} total value).`
      : `The model currently rates this stock ${recommendation} (score ${score}/100).`;

    const caution =
      recommendation === "AVOID"
        ? " An AVOID rating plus a measured ~51% 1-day direction accuracy across the universe both argue for booking rather than waiting."
        : recommendation === "BUY" && netProfit >= 0
          ? " Note: even a BUY rating has historically been right only slightly more than half the time on short horizons — this is a lean, not a guarantee."
          : "";

    return `${bookNow} ${holdView}${caution}`;
  }
}

export const holdingsService = new HoldingsService();
export default holdingsService;
