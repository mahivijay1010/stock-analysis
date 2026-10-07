/**
 * RiskControlService — the capital-protection surface. Feeds the circuit
 * breaker from the system's REAL resolved-trade stream (realized R across the
 * shadow ledgers) plus the current regime, and stress-tests a book against
 * historical small-cap crashes using betas estimated from bars.
 */

import { AppDataSource } from "../../config/database";
import { marketDataService } from "../market/MarketDataService";
import { assessCircuitBreaker, CircuitBreakerResult, ClosedTrade } from "./circuitBreaker";
import { stressTestBook, StressPosition, StressReport } from "./stressTest";
import { regimeService } from "./RegimeService";
import { Bar } from "../market/types";

function dailyReturns(bars: Bar[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].adjustedClose ?? bars[i - 1].close;
    const cur = bars[i].adjustedClose ?? bars[i].close;
    if (prev > 0) out.push(cur / prev - 1);
  }
  return out;
}

function beta(stock: number[], index: number[]): number | null {
  const n = Math.min(stock.length, index.length);
  if (n < 20) return null;
  const s = stock.slice(-n);
  const m = index.slice(-n);
  const ms = s.reduce((a, b) => a + b, 0) / n;
  const mm = m.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let varm = 0;
  for (let i = 0; i < n; i++) {
    cov += (s[i] - ms) * (m[i] - mm);
    varm += (m[i] - mm) ** 2;
  }
  return varm > 0 ? cov / varm : null;
}

export class RiskControlService {
  /** Circuit-breaker state from the resolved shadow-ledger realized-R stream. */
  async circuitBreaker(): Promise<CircuitBreakerResult> {
    const rows: Array<{ d: string; r: string }> = await AppDataSource.query(
      `SELECT to_char(resolved_at,'YYYY-MM-DD') AS d, (outcome->>'realizedNetR') AS r
         FROM wide_shadow_predictions
        WHERE outcome IS NOT NULL AND (outcome->>'realizedNetR') IS NOT NULL
      UNION ALL
       SELECT to_char(resolved_at,'YYYY-MM-DD') AS d, (outcome->>'realizedNetR') AS r
         FROM short_term_shadow_predictions
        WHERE outcome IS NOT NULL AND (outcome->>'realizedNetR') IS NOT NULL`
    ).catch(() => []);
    const trades: ClosedTrade[] = rows
      .map((x) => ({ date: x.d, realizedR: Number(x.r) }))
      .filter((t) => t.date && Number.isFinite(t.realizedR));
    const regime = await regimeService.detect().catch(() => null);
    return assessCircuitBreaker(trades, regime?.regime ?? null);
  }

  /** Stress a book against historical small-cap crashes. Betas are estimated
   *  from 6-month bars vs NIFTY; unavailable ⇒ the pure default (1.2). */
  async stressTest(positions: Array<{ ticker: string; sector?: string | null; valueInr: number; stopPct?: number | null }>, capitalInr: number): Promise<StressReport> {
    let indexReturns: number[] = [];
    try {
      indexReturns = dailyReturns(await marketDataService.getNiftyBars("1y")).slice(-120);
    } catch {
      indexReturns = [];
    }
    const book: StressPosition[] = [];
    for (const p of positions) {
      let b: number | null = null;
      if (indexReturns.length >= 20) {
        try {
          const r = dailyReturns(await marketDataService.getDailyBars(p.ticker, "6mo")).slice(-120);
          b = beta(r, indexReturns);
        } catch {
          b = null;
        }
      }
      // CONSERVATIVE: beta here is vs NIFTY (the only index fetched), but the
      // scenarios are SMALL-CAP crashes — a sub-₹100 name rarely dodges a
      // small-cap sell-off, so we floor the stress beta at 1.0. A stress test
      // must never understate the tail. null ⇒ the pure default (1.2).
      book.push({ ticker: p.ticker, sector: p.sector ?? null, valueInr: p.valueInr, beta: b != null ? Math.max(b, 1.0) : null, stopPct: p.stopPct ?? null });
    }
    return stressTestBook(book, capitalInr);
  }
}

export const riskControlService = new RiskControlService();
