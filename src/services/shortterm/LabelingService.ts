/**
 * LabelingService — generates triple-barrier labels from REAL historical
 * anchors (the radar's shadow predictions) and persists them to trade_labels.
 * This is the training-data foundation: labels accrue now so a meta-label model
 * has something honest to learn from once there are enough matured ones.
 *
 * Uses 2×ATR upper / 1×ATR lower barriers and the horizon's own session cap.
 * Only labels anchors whose full horizon has elapsed (no lookahead). Idempotent
 * via the composite unique key.
 */

import { AppDataSource } from "../../config/database";
import { TradeLabel } from "../../entities";
import { marketDataService } from "../market/MarketDataService";
import { atr as computeAtr } from "../quant/indicators";
import { toAdjustedOhlc } from "./shadowFill";
import { labelTripleBarrier, TRIPLE_BARRIER_VERSION } from "./tripleBarrier";
import { HORIZON_TD, ShortTermHorizon } from "./types";
import { Bar } from "../market/types";

const UPPER_MULT = 2;
const LOWER_MULT = 1;

export interface LabelRunSummary {
  anchorsExamined: number;
  labelsWritten: number;
  notMatured: number;
  noData: number;
  byLabel: Record<string, number>;
}

export class LabelingService {
  /** Label matured shadow-prediction anchors that have no trade_label yet. */
  async generateFromShadowAnchors(limit = 500): Promise<LabelRunSummary> {
    const anchors: Array<{ ticker: string; anchor_date: string; horizon: string }> = await AppDataSource.query(
      `SELECT DISTINCT s.ticker, to_char(s.anchor_date,'YYYY-MM-DD') AS anchor_date, s.horizon
         FROM short_term_shadow_predictions s
        WHERE NOT EXISTS (
          SELECT 1 FROM trade_labels t
           WHERE t.ticker = s.ticker AND t.anchor_date = s.anchor_date
             AND t.label_version = $1
        )
        ORDER BY anchor_date DESC
        LIMIT $2`,
      [TRIPLE_BARRIER_VERSION, limit]
    );

    const summary: LabelRunSummary = { anchorsExamined: anchors.length, labelsWritten: 0, notMatured: 0, noData: 0, byLabel: {} };
    const repo = AppDataSource.getRepository(TradeLabel);
    const barsCache = new Map<string, Bar[]>();

    for (const a of anchors) {
      const horizon = (a.horizon in HORIZON_TD ? a.horizon : "5-10d") as ShortTermHorizon;
      const maxHold = HORIZON_TD[horizon].max;
      let bars = barsCache.get(a.ticker);
      if (!bars) {
        try {
          bars = await marketDataService.getDailyBars(a.ticker, "2y");
          barsCache.set(a.ticker, bars);
        } catch {
          summary.noData++;
          continue;
        }
      }
      // Anchor index = last bar at/before the anchor date; entry at next session.
      let anchorIdx = -1;
      for (let i = bars.length - 1; i >= 0; i--) {
        if (bars[i].date <= a.anchor_date) {
          anchorIdx = i;
          break;
        }
      }
      if (anchorIdx < 0 || anchorIdx + 1 >= bars.length) {
        summary.noData++;
        continue;
      }
      if (anchorIdx + maxHold >= bars.length) {
        summary.notMatured++;
        continue; // full horizon not elapsed — no lookahead
      }

      const atrVal = computeAtr(bars.slice(0, anchorIdx + 1), 14);
      const entryPrice = bars[anchorIdx + 1].open; // enter at next open
      if (atrVal == null || !(atrVal > 0) || !(entryPrice > 0)) {
        summary.noData++;
        continue;
      }
      const forward = toAdjustedOhlc(bars.slice(anchorIdx + 1));
      const out = labelTripleBarrier({ forward, entryPrice, atr: atrVal, upperMult: UPPER_MULT, lowerMult: LOWER_MULT, horizonSessions: maxHold });

      await repo
        .createQueryBuilder()
        .insert()
        .values({
          ticker: a.ticker,
          anchorDate: a.anchor_date,
          horizonSessions: maxHold,
          entryPrice: String(entryPrice),
          atr: String(atrVal),
          upperMult: String(UPPER_MULT),
          lowerMult: String(LOWER_MULT),
          upperBarrier: String(out.upper),
          lowerBarrier: String(out.lower),
          label: out.label,
          realizedR: out.realizedR != null ? String(out.realizedR) : null,
          conservativeR: out.conservativeR != null ? String(out.conservativeR) : null,
          mfeR: String(out.mfeR),
          maeR: String(out.maeR),
          holdingDays: out.holdingDays,
          ambiguous: out.ambiguous,
          featureHash: null,
          labelVersion: TRIPLE_BARRIER_VERSION,
        } as never)
        .orIgnore()
        .execute();
      summary.labelsWritten++;
      summary.byLabel[out.label] = (summary.byLabel[out.label] ?? 0) + 1;
    }
    return summary;
  }

  /** Distribution of the labels generated so far — the honest base rates. */
  async distribution(): Promise<{ total: number; byLabel: Record<string, number>; meanRealizedR: number | null }> {
    const rows: Array<{ label: string; n: string }> = await AppDataSource.query(
      `SELECT label, COUNT(*)::text AS n FROM trade_labels WHERE label_version = $1 GROUP BY label`,
      [TRIPLE_BARRIER_VERSION]
    );
    const [agg]: Array<{ total: string; mean_r: string | null }> = await AppDataSource.query(
      `SELECT COUNT(*)::text AS total,
              AVG(realized_r) FILTER (WHERE realized_r IS NOT NULL)::text AS mean_r
         FROM trade_labels WHERE label_version = $1`,
      [TRIPLE_BARRIER_VERSION]
    );
    const byLabel: Record<string, number> = {};
    for (const r of rows) byLabel[r.label] = Number(r.n);
    return { total: Number(agg?.total ?? 0), byLabel, meanRealizedR: agg?.mean_r != null ? Math.round(Number(agg.mean_r) * 1000) / 1000 : null };
  }
}

export const labelingService = new LabelingService();
