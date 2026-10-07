/**
 * PortfolioRiskService — computes the portfolio risk engine for a set of
 * tickers (default: a hypothetical equal-risk book of the sub-₹100 names that
 * pass the screen), pulling daily returns from bars for the VaR/correlation
 * math and the regime for the size overlay.
 */

import { marketDataService } from "../market/MarketDataService";
import { computePortfolioRisk, PortfolioPosition, PortfolioRisk } from "./portfolioRisk";
import { regimeService } from "./RegimeService";
import { regimeGateFor } from "./regimeGates";
import { Bar } from "../market/types";

export interface PortfolioRiskReport {
  risk: PortfolioRisk;
  regime: { regime: string; sizeMultiplier: number; note: string } | null;
  positions: Array<{ ticker: string; sector: string | null; valueInr: number }>;
  note: string;
}

function dailyReturns(bars: Bar[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].adjustedClose ?? bars[i - 1].close;
    const cur = bars[i].adjustedClose ?? bars[i].close;
    if (prev > 0) out.push(cur / prev - 1);
  }
  return out;
}

export class PortfolioRiskService {
  /** Risk for an explicit book: [{ticker, sector, valueInr}]. Returns null
   *  series for names with no bars (excluded from the correlation math). */
  async forPositions(input: Array<{ ticker: string; sector?: string | null; valueInr: number; beta?: number | null }>, capitalInr: number): Promise<PortfolioRiskReport> {
    const positions: PortfolioPosition[] = [];
    for (const p of input) {
      let returns: number[] = [];
      try {
        const bars = await marketDataService.getDailyBars(p.ticker, "6mo");
        returns = dailyReturns(bars).slice(-90);
      } catch {
        returns = [];
      }
      positions.push({ ticker: p.ticker, sector: p.sector ?? null, valueInr: p.valueInr, beta: p.beta ?? null, returns });
    }
    const risk = computePortfolioRisk({ positions, capitalInr });
    const reg = await regimeService.detect().catch(() => null);
    const gate = reg ? regimeGateFor(reg.regime) : null;
    return {
      risk,
      regime: gate ? { regime: gate.regime, sizeMultiplier: gate.sizeMultiplier, note: gate.note } : null,
      positions: input.map((p) => ({ ticker: p.ticker, sector: p.sector ?? null, valueInr: p.valueInr })),
      note:
        "Portfolio risk is measured on observed 90-day co-movement, scaled to deployed capital. The regime size multiplier is the recommended haircut on NEW entries, not a forecast.",
    };
  }
}

export const portfolioRiskService = new PortfolioRiskService();
