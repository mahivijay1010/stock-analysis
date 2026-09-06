/**
 * LedgerController (Phase B2) — thin HTTP handlers over LedgerService and
 * WatchlistService. Every route here sits behind requireAuth; the account is
 * ALWAYS req.account (server-side identity), never a client-supplied id.
 */
import { NextFunction, Request, Response } from "express";
import { LedgerService, PriceLookup, RecordTransactionInput } from "../services/ledger/LedgerService";
import { WatchlistService } from "../services/watchlist/WatchlistService";
import { marketDataService } from "../services/market/MarketDataService";
import { HttpError } from "../types";

function ok(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ success: true, data });
}

/** Observed-quote lookup with explicit freshness fields (spec §6: no "live" labels here). */
const quoteLookup: PriceLookup = async (yahooTicker) => {
  const q = await marketDataService.getQuote(yahooTicker);
  return {
    current: q.price,
    asOf: q.asOf,
    marketState: q.marketState ?? null,
    source: "yahoo-quote (may be a cached prior close outside market hours)",
  };
};

/** Closing-price lookup for explicit estimated-price purchases. */
async function closeOnOrBefore(ticker: string, date: string): Promise<{ close: number; date: string } | null> {
  const bars = await marketDataService.getDailyBars(ticker, "5y");
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].date <= date) return { close: bars[i].close, date: bars[i].date };
  }
  return null;
}

export class LedgerController {
  private readonly ledger = new LedgerService(undefined, closeOnOrBefore);
  private readonly watchlist = new WatchlistService();

  // ── Watchlist ────────────────────────────────────────────────────────────

  /** GET /api/watchlist */
  listWatchlist = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      ok(res, { items: await this.watchlist.list(req.account!.accountId) });
    } catch (err) {
      next(err);
    }
  };

  /** POST /api/watchlist { ticker | instrumentId, notes?, horizon? } */
  addWatchlist = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = (req.body ?? {}) as { ticker?: string; instrumentId?: string; notes?: string; horizon?: string };
      ok(res, { item: await this.watchlist.add(req.account!.accountId, body) }, 201);
    } catch (err) {
      next(err);
    }
  };

  /** DELETE /api/watchlist/:id — removes ONLY the watchlist row, never holdings. */
  removeWatchlist = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      ok(res, await this.watchlist.remove(req.account!.accountId, String(req.params.id)));
    } catch (err) {
      next(err);
    }
  };

  // ── Holdings (derived positions) ─────────────────────────────────────────

  /** GET /api/holdings — positions derived from the ledger + observed prices. */
  holdings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      ok(res, await this.ledger.getPositions(req.account!.accountId, quoteLookup));
    } catch (err) {
      next(err);
    }
  };

  // ── Transactions ─────────────────────────────────────────────────────────

  /** GET /api/transactions?ticker=&limit=&offset= */
  listTransactions = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { ticker, limit, offset } = req.query as Record<string, string | undefined>;
      ok(
        res,
        await this.ledger.listTransactions(req.account!.accountId, {
          ticker: ticker || undefined,
          limit: limit ? Number(limit) : undefined,
          offset: offset ? Number(offset) : undefined,
        })
      );
    } catch (err) {
      next(err);
    }
  };

  /** POST /api/transactions — record one immutable ledger transaction. */
  recordTransaction = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = (req.body ?? {}) as Partial<RecordTransactionInput>;
      if (!body.type || !body.tradeDate) {
        throw new HttpError(
          400,
          'Body needs at least { "type": "BUY|SELL|DIVIDEND|SPLIT|BONUS|CHARGE_ADJUST", "ticker": "...", "tradeDate": "YYYY-MM-DD" } ' +
            'plus type-specific fields (BUY/SELL: qty and price or grossAmount; SPLIT/BONUS: ratioNumerator/ratioDenominator; DIVIDEND/CHARGE_ADJUST: grossAmount).'
        );
      }
      const result = await this.ledger.recordTransaction(req.account!.accountId, body as RecordTransactionInput);
      ok(res, result, result.duplicate ? 200 : 201);
    } catch (err) {
      next(err);
    }
  };

  /** POST /api/transactions/:id/correct { note? } — reversal entry; original stays immutable. */
  correctTransaction = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { note } = (req.body ?? {}) as { note?: string };
      ok(res, await this.ledger.correctTransaction(req.account!.accountId, String(req.params.id), note), 201);
    } catch (err) {
      next(err);
    }
  };

  /** POST /api/transactions/import { rows: [...], dryRun? } */
  importTransactions = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = (req.body ?? {}) as { rows?: RecordTransactionInput[]; dryRun?: boolean };
      ok(res, await this.ledger.importRows(req.account!.accountId, body.rows ?? [], body.dryRun === true));
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/transactions/export.csv — formula-injection-safe CSV. */
  exportCsv = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const csv = await this.ledger.exportCsv(req.account!.accountId);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="ledger_transactions.csv"');
      res.status(200).send(csv);
    } catch (err) {
      next(err);
    }
  };
}

export default LedgerController;
