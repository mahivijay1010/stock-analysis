/**
 * LiquidityService — the DB side of the liquidity/tradeability truth layer.
 * Reads nse_delivery (recent sessions) and today's exchange surveillance from
 * stock_knowledge, and returns the pure LiquidityProfile + TradeabilityVerdict
 * per symbol. Batched so the Conviction Board can gate its whole candidate set
 * in two queries.
 */

import { AppDataSource } from "../../config/database";
import { computeLiquidityProfile, LiquidityDailyRow, LiquidityProfile } from "./liquidityProfile";
import { checkTradeabilityGate, TradeabilityVerdict } from "./tradeabilityGate";

export interface SymbolLiquidity {
  profile: LiquidityProfile;
  gate: TradeabilityVerdict;
}

export class LiquidityService {
  /** Liquidity profile + tradeability verdict for each symbol (bare NSE symbol,
   *  no .NS). Symbols with no delivery history get an empty profile that the
   *  gate treats as "unknown" (not a hard block on missing data alone). */
  async profilesFor(symbols: string[]): Promise<Map<string, SymbolLiquidity>> {
    const out = new Map<string, SymbolLiquidity>();
    if (symbols.length === 0) return out;

    // Up to ~70 sessions per symbol — enough for the 60d windows.
    const rows: Array<{ symbol: string; d: string; c: string; t: string | null; n: string | null; p: string | null; series: string }> = await AppDataSource.query(
      `SELECT symbol, to_char(trade_date,'YYYY-MM-DD') d, close_price c, turnover_lacs t, no_of_trades n, deliv_pct p, series
         FROM nse_delivery
        WHERE series = 'EQ' AND symbol = ANY($1) AND trade_date > (SELECT max(trade_date) FROM nse_delivery) - interval '110 days'
        ORDER BY symbol, trade_date`,
      [symbols]
    );
    const bySymbol = new Map<string, LiquidityDailyRow[]>();
    for (const r of rows) {
      const row: LiquidityDailyRow = { date: r.d, close: Number(r.c), turnoverLacs: r.t == null ? null : Number(r.t), trades: r.n == null ? null : Number(r.n), delivPct: r.p == null ? null : Number(r.p) };
      const g = bySymbol.get(r.symbol);
      if (g) g.push(row);
      else bySymbol.set(r.symbol, [row]);
    }

    // Latest surveillance observation per symbol (ASM/GSM/ESM/IBC).
    const survRows: Array<{ symbol: string; code: string }> = await AppDataSource.query(
      `SELECT symbol, detail->>'code' AS code
         FROM stock_knowledge
        WHERE kind = 'SURVEILLANCE' AND symbol = ANY($1)
          AND observed_at = (SELECT max(observed_at) FROM stock_knowledge WHERE kind = 'SURVEILLANCE')`,
      [symbols]
    );
    const survBySymbol = new Map<string, string[]>();
    for (const s of survRows) {
      const g = survBySymbol.get(s.symbol) ?? [];
      if (s.code) g.push(s.code);
      survBySymbol.set(s.symbol, g);
    }

    for (const symbol of symbols) {
      const profile = computeLiquidityProfile(bySymbol.get(symbol) ?? []);
      const gate = checkTradeabilityGate({
        surveillanceCodes: survBySymbol.get(symbol) ?? [],
        series: "EQ",
        medianDailyValueInr20d: profile.medianDailyValueInr20d,
        inferredCircuitBandPct: profile.inferredCircuitBandPct,
        daysToExitAt1crore: profile.daysToExitAt1crore,
        delivPct20d: profile.delivPct20d,
        bigMoveDays20d: profile.bigMoveDays20d,
      });
      out.set(symbol, { profile, gate });
    }
    return out;
  }
}

export const liquidityService = new LiquidityService();
