import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Barrier-first outcome columns on intraday_forecast_outcomes (spec §5/§6/§11).
 *
 * Adds, for every graded intraday forecast:
 *   - the model's EX-ANTE bracket probabilities (P target-first, P stop-first,
 *     P neither) from its own drift/vol, computed when the call was issued;
 *   - what ACTUALLY happened along the 1-minute bar path within the horizon:
 *     which barrier hit first, minutes to hit, maximum favourable and adverse
 *     excursion, and close-to-base return at 5/10/15/30/60 minutes;
 *   - whether the recorded path was complete (a cut-short path is data, not a
 *     "no hit").
 *
 * Why columns on the existing row rather than a new table: the bracket is a
 * property of the same forecast, graded at the same instant (when its horizon
 * elapses), by the same code path. A second table keyed by the same identity
 * would only add a join. All columns are nullable — rows graded before this
 * migration have no path data, and saying so is more honest than backfilling
 * from bars we may no longer hold.
 *
 * ALTER TABLE is DDL and is not blocked by the row-immutability trigger; the
 * rows themselves remain append-only.
 */
export class AddIntradayBarrierOutcomes1790000000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE intraday_forecast_outcomes
      ADD COLUMN IF NOT EXISTS barrier_target_pct numeric(8,4),
      ADD COLUMN IF NOT EXISTS barrier_stop_pct numeric(8,4),
      ADD COLUMN IF NOT EXISTS p_target_first numeric(6,4),
      ADD COLUMN IF NOT EXISTS p_stop_first numeric(6,4),
      ADD COLUMN IF NOT EXISTS p_neither numeric(6,4),
      ADD COLUMN IF NOT EXISTS first_hit varchar(6),
      ADD COLUMN IF NOT EXISTS minutes_to_hit int,
      ADD COLUMN IF NOT EXISTS mfe_pct numeric(12,6),
      ADD COLUMN IF NOT EXISTS mae_pct numeric(12,6),
      ADD COLUMN IF NOT EXISTS returns_at_pct jsonb,
      ADD COLUMN IF NOT EXISTS path_bars_seen int,
      ADD COLUMN IF NOT EXISTS path_complete boolean`);
    await q.query(`ALTER TABLE intraday_forecast_outcomes
      DROP CONSTRAINT IF EXISTS chk_ifo_first_hit`);
    await q.query(`ALTER TABLE intraday_forecast_outcomes
      ADD CONSTRAINT chk_ifo_first_hit CHECK (first_hit IS NULL OR first_hit IN ('TARGET','STOP','NONE'))`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_ifo_first_hit ON intraday_forecast_outcomes (session_date, horizon_min, first_hit) WHERE first_hit IS NOT NULL`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS idx_ifo_first_hit`);
    await q.query(`ALTER TABLE intraday_forecast_outcomes DROP CONSTRAINT IF EXISTS chk_ifo_first_hit`);
    await q.query(`ALTER TABLE intraday_forecast_outcomes
      DROP COLUMN IF EXISTS barrier_target_pct, DROP COLUMN IF EXISTS barrier_stop_pct,
      DROP COLUMN IF EXISTS p_target_first, DROP COLUMN IF EXISTS p_stop_first, DROP COLUMN IF EXISTS p_neither,
      DROP COLUMN IF EXISTS first_hit, DROP COLUMN IF EXISTS minutes_to_hit,
      DROP COLUMN IF EXISTS mfe_pct, DROP COLUMN IF EXISTS mae_pct, DROP COLUMN IF EXISTS returns_at_pct,
      DROP COLUMN IF EXISTS path_bars_seen, DROP COLUMN IF EXISTS path_complete`);
  }
}
