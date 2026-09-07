/**
 * PortfolioOverviewService (owner request 2026-09-06) — ONE response powering
 * the unified Watchlist: every instrument the account follows OR holds, each
 * with its held state, observed price + freshness, THIS calendar month's
 * forecast summary (from the stored monthly issuance — rolls automatically at
 * month change via the renewal job), and the latest published decision +
 * horizon-suitability snapshot.
 *
 * Read-only: composes STORED records (ledger replay, forecast issuances,
 * decision snapshots) plus cached price quotes. Never issues or publishes.
 */

import { AppDataSource } from "../../config/database";
import { LedgerService, PositionView } from "../ledger/LedgerService";
import { WatchlistService } from "../watchlist/WatchlistService";
import { marketDataService } from "../market/MarketDataService";
import { istDateString, monthKey } from "../forecast/dates";

export interface OverviewRow {
  instrumentId: string;
  ticker: string;
  name: string;
  /** Watchlist membership (null when the stock is held but not followed). */
  watch: { itemId: string; userHorizon: string; note: string | null } | null;
  /** Open position (null when watch-only). Values from the immutable ledger. */
  held: {
    qty: number;
    costBasis: number;
    avgCostPerShare: number | null;
    unrealizedGrossPnl: number | null;
    realizedPnl: number;
  } | null;
  price: { current: number; asOf: string | null; source: string | null } | null;
  /** THIS month's stored forecast (original snapshot unless a refresh exists). */
  monthForecast: {
    period: string;
    monthEnd: string; // last expected session's target date
    anchorPrice: number;
    anchorDate: string;
    medianPrice: number;
    p10: number;
    p90: number;
    medianReturnPct: number | null;
    issuedAt: string;
    revision: number;
  } | null;
  decision: {
    status: string;
    evidenceStatus: string;
    riskLevel: string;
    asOf: string;
    validUntil: string;
    expired: boolean;
    topReason: string | null;
    /** Rule 14: the SEPARATE existing-position decision — shown on held rows. */
    existingHolderAction: string | null;
    holderReason: string | null;
    horizon: {
      label: string | null;
      reasons: string[];
      evidenceStatus: string;
    } | null;
  } | null;
}

export interface PortfolioOverview {
  asOf: string;
  period: string; // current IST calendar month, e.g. "2026-09"
  rows: OverviewRow[];
  totals: {
    followed: number;
    held: number;
    costBasis: number;
    unrealizedGrossPnl: number | null;
    realizedPnl: number;
  };
  notes: string[];
}

export class PortfolioOverviewService {
  private readonly ledger = new LedgerService();
  private readonly watchlist = new WatchlistService();

  async overview(accountId: string): Promise<PortfolioOverview> {
    const period = monthKey(istDateString(new Date()));

    const [items, holdings] = await Promise.all([
      this.watchlist.list(accountId),
      this.ledger.getPositions(accountId, async (yahooTicker) => {
        const q = await marketDataService.getQuote(yahooTicker);
        return {
          current: q.price,
          asOf: q.asOf,
          marketState: q.marketState ?? null,
          source: "yahoo-quote (may be a cached prior close outside market hours)",
        };
      }),
    ]);

    const open = holdings.positions.filter((p) => p.status === "OPEN" && p.qty > 0);
    const heldById = new Map<string, PositionView>(open.map((p) => [p.instrumentId, p]));

    // Union of instruments, watchlist order first, then held-only.
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const i of items) {
      if (!seen.has(i.instrumentId)) {
        ids.push(i.instrumentId);
        seen.add(i.instrumentId);
      }
    }
    for (const p of open) {
      if (!seen.has(p.instrumentId)) {
        ids.push(p.instrumentId);
        seen.add(p.instrumentId);
      }
    }

    const [monthByInstrument, decisionByInstrument] = ids.length
      ? await Promise.all([this.monthSummaries(ids, period), this.latestDecisions(ids)])
      : [new Map(), new Map()];

    const watchById = new Map(items.map((i) => [i.instrumentId, i]));
    const rows: OverviewRow[] = [];
    for (const id of ids) {
      const w = watchById.get(id) ?? null;
      const h = heldById.get(id) ?? null;
      const ticker = w?.ticker ?? h?.ticker ?? "(unknown)";
      const name = w?.name ?? h?.name ?? ticker;

      // Held rows already carry an observed price from the ledger's quote
      // lookup; watch-only rows get one cached quote (failure ⇒ null, stated).
      let price: OverviewRow["price"] = null;
      if (h && h.price.status === "AVAILABLE" && h.price.current != null) {
        price = { current: h.price.current, asOf: h.price.asOf, source: h.price.source };
      } else if (!h) {
        try {
          const q = await marketDataService.getQuote(ticker);
          price = {
            current: q.price,
            asOf: q.asOf,
            source: "yahoo-quote (may be a cached prior close outside market hours)",
          };
        } catch {
          price = null;
        }
      }

      rows.push({
        instrumentId: id,
        ticker,
        name,
        watch: w ? { itemId: w.id, userHorizon: w.horizon, note: w.notes ?? null } : null,
        held: h
          ? {
              qty: h.qty,
              costBasis: Number(h.costBasisExact),
              avgCostPerShare: h.avgCostPerShare != null ? Number(h.avgCostPerShare) : null,
              unrealizedGrossPnl: h.unrealizedGrossPnl != null ? Number(h.unrealizedGrossPnl) : null,
              realizedPnl: Number(h.realizedPnl),
            }
          : null,
        price,
        monthForecast: monthByInstrument.get(id) ?? null,
        decision: decisionByInstrument.get(id) ?? null,
      });
    }

    return {
      asOf: new Date().toISOString(),
      period,
      rows,
      totals: {
        followed: items.length,
        held: open.length,
        costBasis: Number(holdings.totals.costBasis),
        unrealizedGrossPnl:
          holdings.totals.unrealizedGrossPnl != null ? Number(holdings.totals.unrealizedGrossPnl) : null,
        realizedPnl: Number(holdings.totals.realizedPnl),
      },
      notes: [
        "Following records no purchase and creates no P&L; held rows come from replaying the immutable ledger.",
        `Month forecast = the stored ${period} issuance's last expected session (median + 80% interval); it rolls automatically when the month changes.`,
        "Decision and horizon labels are the latest nightly published snapshots — identical on every screen.",
      ],
    };
  }

  /** Latest month run per instrument for the period + its final session point. */
  private async monthSummaries(
    instrumentIds: string[],
    period: string
  ): Promise<Map<string, OverviewRow["monthForecast"]>> {
    const rows: Array<{
      instrument_id: string;
      revision: number;
      anchor_price: string;
      anchor_session_date: string;
      issued_at: string;
      target_date: string;
      p10: string;
      p50: string;
      p90: string;
      median_return_pct: string | null;
    }> = await AppDataSource.query(
      `SELECT r.instrument_id, r.revision, r.anchor_price::text AS anchor_price,
              r.anchor_session_date::text AS anchor_session_date,
              r.issued_at::text AS issued_at,
              p.target_date::text AS target_date,
              p.price_p10::text AS p10, p.price_p50::text AS p50, p.price_p90::text AS p90,
              p.median_return_pct::text AS median_return_pct
         FROM forecast_runs r
         JOIN LATERAL (
            SELECT * FROM forecast_points fp
             WHERE fp.run_id = r.id AND fp.price_p50 IS NOT NULL
             ORDER BY fp.target_date DESC LIMIT 1
         ) p ON true
        WHERE r.view_kind = 'month' AND r.period_key = $1
          AND r.instrument_id = ANY($2::uuid[])
          AND r.revision = (
            SELECT max(r2.revision) FROM forecast_runs r2
             WHERE r2.instrument_id = r.instrument_id
               AND r2.view_kind = 'month' AND r2.period_key = $1
          )`,
      [period, instrumentIds]
    );
    const out = new Map<string, OverviewRow["monthForecast"]>();
    for (const r of rows) {
      out.set(r.instrument_id, {
        period,
        monthEnd: r.target_date,
        anchorPrice: Number(r.anchor_price),
        anchorDate: r.anchor_session_date,
        medianPrice: Number(r.p50),
        p10: Number(r.p10),
        p90: Number(r.p90),
        medianReturnPct: r.median_return_pct != null ? Number(r.median_return_pct) : null,
        issuedAt: r.issued_at,
        revision: r.revision,
      });
    }
    return out;
  }

  /** Latest decision snapshot per instrument. */
  private async latestDecisions(instrumentIds: string[]): Promise<Map<string, OverviewRow["decision"]>> {
    const rows: Array<{
      instrument_id: string;
      decision_status: string;
      evidence_status: string;
      risk_level: string;
      as_of: string;
      valid_until: string;
      reasons: string[];
      horizon_suitability: {
        label?: string | null;
        reasons?: string[];
        evidenceStatus?: string;
      } | null;
      existing_holder_action: string | null;
      holder_reasons: string[] | null;
    }> = await AppDataSource.query(
      `SELECT DISTINCT ON (instrument_id)
              instrument_id, decision_status, evidence_status, risk_level,
              as_of::text AS as_of, valid_until::text AS valid_until,
              reasons, horizon_suitability, existing_holder_action, holder_reasons
         FROM decision_snapshots
        WHERE instrument_id = ANY($1::uuid[])
        ORDER BY instrument_id, as_of DESC`,
      [instrumentIds]
    );
    const now = Date.now();
    const out = new Map<string, OverviewRow["decision"]>();
    for (const r of rows) {
      out.set(r.instrument_id, {
        status: r.decision_status,
        evidenceStatus: r.evidence_status,
        riskLevel: r.risk_level,
        asOf: r.as_of,
        validUntil: r.valid_until,
        expired: new Date(r.valid_until).getTime() < now,
        topReason: Array.isArray(r.reasons) && r.reasons.length > 0 ? String(r.reasons[0]) : null,
        existingHolderAction: r.existing_holder_action ?? null,
        holderReason:
          Array.isArray(r.holder_reasons) && r.holder_reasons.length > 0 ? String(r.holder_reasons[0]) : null,
        horizon: r.horizon_suitability
          ? {
              label: (r.horizon_suitability.label as string | null) ?? null,
              reasons: Array.isArray(r.horizon_suitability.reasons)
                ? (r.horizon_suitability.reasons as string[])
                : [],
              evidenceStatus: String(r.horizon_suitability.evidenceStatus ?? "INSUFFICIENT"),
            }
          : null,
      });
    }
    return out;
  }
}

export const portfolioOverviewService = new PortfolioOverviewService();
export default portfolioOverviewService;
