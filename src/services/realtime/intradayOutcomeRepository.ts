/**
 * IntradayOutcomeRepository — the persistence half of the intraday learning
 * loop (migration 1789900000000-CreateIntradayLearning).
 *
 * Two responsibilities, kept deliberately small:
 *
 *  1. Write every GRADED forecast to `intraday_forecast_outcomes`, together
 *     with the parameters it was computed under and the round-trip cost that
 *     applied at the time. On 2026-09-23 the forecaster graded 13,806
 *     one-minute forecasts and held every one of them only in process memory;
 *     that dataset was one hot-reload from oblivion. Nothing here is ever
 *     updated or deleted — the table carries the shared immutability trigger.
 *
 *  2. Read and promote `intraday_model_params`. The forecaster's constants are
 *     no longer only source code: the ACTIVE row is what runs, and changing it
 *     is a governed, logged event with evidence attached. Promotion is a
 *     single transaction — retire the incumbent, insert the successor, record
 *     the transition — under the same admin GUC the other immutable tables use
 *     for the one mutation they permit.
 *
 * Cost travels ON each forecast (computed when the call was issued, from the
 * live schedule — see intradayRoundTripCostPct in intradayForecast.ts), so
 * the stored row answers "could this call have netted anything at the cost
 * that applied when it was made" forever. Re-deriving cost later from a
 * schedule that may have changed would quietly rewrite history.
 */

import { AppDataSource } from "../../config/database";
import { GradedForecast, IntradayModelParams, intradayRoundTripCostPct, COST_REFERENCE_ORDER_INR } from "./intradayForecast";

export type { IntradayModelParams };
export { intradayRoundTripCostPct, COST_REFERENCE_ORDER_INR };

export interface ActiveParams {
  version: string;
  params: IntradayModelParams;
  promotedAt: string | null;
  reason: string;
}

export interface StoredOutcomeRow {
  id: string;
  session_date: string;
  security_id: string;
  ticker: string;
  horizon_min: number;
  made_at: Date;
  base_price: string;
  expected_return_pct: string;
  probability_up: string;
  direction: "UP" | "DOWN";
  low80_pct: string;
  high80_pct: string;
  bar_vol_pct: string;
  bars_used: number;
  params_version: string;
  model_params: IntradayModelParams;
  round_trip_cost_pct: string;
  actual_return_pct: string;
  actual_direction: "UP" | "DOWN";
  outcome: "CORRECT" | "WRONG";
  clears_cost: boolean;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function istDate(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export class IntradayOutcomeRepository {
  constructor(private readonly ds = AppDataSource) {}

  async activeParams(): Promise<ActiveParams> {
    const [row]: Array<{ version: string; params: IntradayModelParams; promoted_at: Date | null; reason: string }> =
      await this.ds.query(`SELECT version, params, promoted_at, reason FROM intraday_model_params WHERE state = 'ACTIVE' LIMIT 1`);
    if (!row) throw new Error("intraday_model_params has no ACTIVE row — run migration 1789900000000");
    return { version: row.version, params: row.params, promotedAt: row.promoted_at ? row.promoted_at.toISOString() : null, reason: row.reason };
  }

  /**
   * Persist one graded forecast. Idempotent on (security, horizon, made_at):
   * a re-delivered grade is ignored rather than duplicated.
   */
  async persistGraded(g: GradedForecast, paramsVersion: string, params: IntradayModelParams): Promise<void> {
    // Cost travels ON the graded forecast (computed when the call was issued),
    // so the stored row reflects what acting on it would have cost at the time.
    const cost = g.roundTripCostPct;
    await this.ds.query(
      `INSERT INTO intraday_forecast_outcomes
         (session_date, security_id, ticker, horizon_min, made_at, resolve_at, base_price,
          expected_return_pct, probability_up, direction, low80_pct, high80_pct, bar_vol_pct, bars_used,
          model_version, params_version, model_params, round_trip_cost_pct,
          graded_at, actual_price, actual_return_pct, actual_direction, outcome, error_pct, clears_cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20,$21,$22,$23,$24,$25)
       ON CONFLICT ON CONSTRAINT uq_ifo_identity DO NOTHING`,
      [
        istDate(g.madeAt), g.securityId, g.ticker, g.horizonMin, new Date(g.madeAt), new Date(g.resolveAt), g.basePrice,
        g.expectedReturnPct, g.probabilityUp, g.direction, g.low80Pct, g.high80Pct, g.barVolPct, g.barsUsed,
        g.modelVersion, paramsVersion, JSON.stringify(params), cost,
        new Date(g.gradedAt), g.actualPrice, g.actualReturnPct, g.actualDirection, g.outcome, g.errorPct,
        g.clearsCost,
      ]
    );
  }

  /** Batch variant for the 15-second grade cycle; one statement per row keeps the idempotency simple. */
  async persistManyGraded(rows: GradedForecast[], paramsVersion: string, params: IntradayModelParams): Promise<number> {
    let n = 0;
    for (const g of rows) {
      await this.persistGraded(g, paramsVersion, params);
      n++;
    }
    return n;
  }

  /** A session's graded rows for one horizon, in the order they were made. */
  async outcomesForSession(sessionDate: string, horizonMin: number): Promise<StoredOutcomeRow[]> {
    return this.ds.query(
      `SELECT id, session_date::text AS session_date, security_id, ticker, horizon_min, made_at, base_price,
              expected_return_pct, probability_up, direction, low80_pct, high80_pct, bar_vol_pct, bars_used,
              params_version, model_params, round_trip_cost_pct, actual_return_pct, actual_direction, outcome, clears_cost
         FROM intraday_forecast_outcomes
        WHERE session_date = $1 AND horizon_min = $2
        ORDER BY made_at ASC, ticker ASC`,
      [sessionDate, horizonMin]
    );
  }

  /** Session dates that have any graded rows, newest first. */
  async sessionsWithData(limit = 30): Promise<string[]> {
    const rows: Array<{ session_date: string }> = await this.ds.query(
      `SELECT DISTINCT session_date::text AS session_date FROM intraday_forecast_outcomes ORDER BY session_date DESC LIMIT $1`,
      [limit]
    );
    return rows.map((r) => r.session_date);
  }

  /**
   * Promote a successor parameter set. One transaction:
   *   incumbent ACTIVE → RETIRED (the single UPDATE the trigger permits, under the GUC),
   *   insert successor as ACTIVE with its evidence,
   *   record the transition in model_governance_transitions.
   * Throws if the successor version already exists — a version is a fact, not a slot.
   */
  async promote(opts: {
    version: string;
    params: IntradayModelParams;
    reason: string;
    evidence: Record<string, unknown>;
    experimentRunId: string | null;
  }): Promise<void> {
    await this.ds.transaction(async (m) => {
      await m.query(`SET LOCAL stocksense.allow_snapshot_mutation = 'on'`);
      const [incumbent]: Array<{ version: string }> = await m.query(`SELECT version FROM intraday_model_params WHERE state = 'ACTIVE' FOR UPDATE`);
      await m.query(`UPDATE intraday_model_params SET state = 'RETIRED' WHERE state = 'ACTIVE'`);
      await m.query(
        `INSERT INTO intraday_model_params (version, params, state, reason, experiment_run_id, evidence, promoted_at)
         VALUES ($1, $2::jsonb, 'ACTIVE', $3, $4, $5::jsonb, now())`,
        [opts.version, JSON.stringify(opts.params), opts.reason, opts.experimentRunId, JSON.stringify(opts.evidence)]
      );
      await m.query(
        `INSERT INTO model_governance_transitions (model_key, from_state, to_state, reason, evidence_run_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [`intraday-params:${incumbent?.version ?? "none"}→${opts.version}`, "ACTIVE", "RETIRED", opts.reason, opts.experimentRunId]
      );
    });
  }
}

export const intradayOutcomeRepository = new IntradayOutcomeRepository();
