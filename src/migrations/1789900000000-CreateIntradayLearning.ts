import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Intraday learning: persist every graded minute-scale forecast, and version
 * the model parameters so a nightly job can promote a challenger.
 *
 * Why this exists. On 2026-09-23 the intraday forecaster graded 13,806
 * one-minute and 3,171 five-minute forecasts IN MEMORY — the largest
 * prospective dataset this system had ever produced — and every row of it was
 * due to vanish on the next process restart. A system cannot learn from
 * outcomes it does not keep. The aggregate (46.5% hit rate, ~8 standard
 * errors below a coin flip) was captured by hand; the per-forecast detail was
 * not, and the calibration analysis that detail would have supported
 * (which probability buckets fail, whether the anti-signal is uniform across
 * liquidity tiers) is simply lost. That does not happen again.
 *
 * 1. intraday_forecast_outcomes — append-only, one row per GRADED forecast,
 *    written at grading time with the inputs the forecast was built from AND
 *    the round-trip cost prevailing at the time. The cost column is the
 *    important one: the 2026-09-23 session showed predicted 1-minute moves of
 *    ~0.3 bps against a round-trip cost of ~20 bps, so "was the direction
 *    right" is the wrong question — "could this ever have cleared cost" is
 *    the question, and it must be answerable from the stored row alone.
 *
 * 2. intraday_model_params — the forecaster's constants (drift sign,
 *    shrinkage, half-life, probability clamps) as versioned rows with a
 *    governance state. Exactly one row is ACTIVE. The nightly calibration
 *    job may INSERT a CANDIDATE and, only if it beats the incumbent on a
 *    chronological hold-out under pre-registered thresholds, promote it. The
 *    forecaster reads the ACTIVE row at start. Constants no longer live only
 *    in source, so a parameter change is a governed, logged event with a
 *    reason — the same discipline as model_governance.
 *
 * Both tables carry the shared reject_live_history_mutation() trigger from
 * CreateLiveHistory: prospective evidence is immutable, and a parameter
 * version's record of what it was and why it was promoted may not be edited
 * after the fact. State transitions on params are new rows, never updates —
 * except the single allowed UPDATE of `state` (ACTIVE→RETIRED) when a
 * successor is promoted, which the trigger permits via the same admin GUC the
 * promotion job sets for exactly that statement.
 */
export class CreateIntradayLearning1789900000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS intraday_forecast_outcomes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      session_date date NOT NULL,
      security_id varchar(40) NOT NULL,
      ticker varchar(20) NOT NULL,
      horizon_min int NOT NULL,

      -- the forecast, exactly as issued
      made_at timestamptz NOT NULL,
      resolve_at timestamptz NOT NULL,
      base_price numeric(14,4) NOT NULL,
      expected_return_pct numeric(12,6) NOT NULL,
      probability_up numeric(6,4) NOT NULL,
      direction varchar(4) NOT NULL,
      low80_pct numeric(12,6) NOT NULL,
      high80_pct numeric(12,6) NOT NULL,
      bar_vol_pct numeric(12,6) NOT NULL,
      bars_used int NOT NULL,
      model_version varchar(60) NOT NULL,
      params_version varchar(40) NOT NULL,
      /* The constants the forecast was computed with, so a challenger with
         different sign/shrinkage can be re-scored offline from this row. */
      model_params jsonb NOT NULL,

      -- what it cost to act, at the time
      round_trip_cost_pct numeric(10,6) NOT NULL,

      -- the outcome
      graded_at timestamptz NOT NULL,
      actual_price numeric(14,4) NOT NULL,
      actual_return_pct numeric(12,6) NOT NULL,
      actual_direction varchar(4) NOT NULL,
      outcome varchar(8) NOT NULL,
      error_pct numeric(12,6) NOT NULL,
      /* |actual move| > round-trip cost: could a perfect direction call have
         netted anything? False for essentially every 1-minute row so far. */
      clears_cost boolean NOT NULL,

      created_at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT chk_ifo_direction CHECK (direction IN ('UP','DOWN') AND actual_direction IN ('UP','DOWN')),
      CONSTRAINT chk_ifo_outcome CHECK (outcome IN ('CORRECT','WRONG')),
      CONSTRAINT chk_ifo_horizon CHECK (horizon_min > 0),
      CONSTRAINT uq_ifo_identity UNIQUE (security_id, horizon_min, made_at)
    )`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_ifo_session_h ON intraday_forecast_outcomes (session_date, horizon_min)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_ifo_ticker_made ON intraday_forecast_outcomes (ticker, made_at DESC)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_ifo_params ON intraday_forecast_outcomes (params_version, session_date)`);

    await q.query(`CREATE TABLE IF NOT EXISTS intraday_model_params (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      version varchar(40) NOT NULL UNIQUE,
      params jsonb NOT NULL,
      state varchar(12) NOT NULL,
      reason text NOT NULL,
      experiment_run_id uuid,
      /* Hold-out evidence the promotion rested on, copied here so the row is
         self-explaining without a join. Null for the seeded initial version,
         which was chosen BEFORE any live data existed. */
      evidence jsonb,
      promoted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT chk_imp_state CHECK (state IN ('CANDIDATE','ACTIVE','RETIRED'))
    )`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_imp_one_active ON intraday_model_params ((state)) WHERE state = 'ACTIVE'`);

    // Seed the incumbent: the constants intradayForecast.ts shipped with,
    // recorded as chosen before any live result was seen.
    await q.query(`INSERT INTO intraday_model_params (version, params, state, reason, promoted_at)
      VALUES ('ip-v1', $1::jsonb, 'ACTIVE',
        'Initial constants, chosen before any live data (docs: intradayForecast.ts header). EWMA momentum drift, shrunk 0.25x, P(up) clamped to [0.35,0.65]. First live session 2026-09-23 scored 46.5% on n=13,806 at 1m — held here as the incumbent to be BEATEN on hold-out, not edited.',
        now())
      ON CONFLICT (version) DO NOTHING`,
      [JSON.stringify({ driftSign: 1, driftShrinkage: 0.25, driftHalfLifeBars: 10, minProbability: 0.35, maxProbability: 0.65, minBarsForForecast: 10 })]
    );

    // Immutability, reusing the shared trigger function from CreateLiveHistory.
    for (const t of ["intraday_forecast_outcomes", "intraday_model_params"]) {
      await q.query(`DROP TRIGGER IF EXISTS trg_${t}_immutable ON ${t}`);
      await q.query(`CREATE TRIGGER trg_${t}_immutable BEFORE UPDATE OR DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION reject_live_history_mutation()`);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS trg_intraday_model_params_immutable ON intraday_model_params`);
    await q.query(`DROP TRIGGER IF EXISTS trg_intraday_forecast_outcomes_immutable ON intraday_forecast_outcomes`);
    await q.query(`DROP TABLE IF EXISTS intraday_model_params`);
    await q.query(`DROP TABLE IF EXISTS intraday_forecast_outcomes`);
  }
}
