import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Phase C reviewed migration — session calendar + immutable forecast issuances
 * (docs/upgrade-spec.md §5; docs/implementation-plan.md §4).
 *
 * Tables:
 *  - trading_sessions: one row per IST calendar date the calendar resolves;
 *    real sessions derived from observed bars, futures provisionally projected.
 *  - forecast_runs: APPEND-ONLY forecast issuances (issuedAt, featureCutoffAt,
 *    anchor session/price, versions, input manifest + sha256). No UPDATE path.
 *  - forecast_points: one row per calendar day in a run's window; immutable;
 *    closed days carry NULL quantiles (never a fabricated prediction).
 *  - forecast_outcomes: the separate observation/evaluation records — reality
 *    is graded here, never written back onto the forecast.
 *
 * Seeds NOTHING: the calendar backfills from observed stock_history at service
 * start (real data only; no invented holiday list).
 *
 * down(): drops ONLY the four tables created here, FK-safe order.
 */
export class CreateForecastTables1788748000000 implements MigrationInterface {
  name = "CreateForecastTables1788748000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── trading_sessions ─────────────────────────────────────────────────────
    await queryRunner.query(
      `CREATE TABLE "trading_sessions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "session_date" date NOT NULL,
        "status" character varying(10) NOT NULL,
        "basis" character varying(20) NOT NULL,
        "label" character varying(120),
        "confirmed_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_trading_sessions" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_trading_sessions_status" CHECK ("status" IN ('session','closed')),
        CONSTRAINT "CHK_trading_sessions_basis" CHECK
          ("basis" IN ('observed','weekend','no_data','weekday_projection','official_calendar'))
      )`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_trading_sessions_date" ON "trading_sessions" ("session_date")`
    );

    // ── forecast_runs (append-only) ──────────────────────────────────────────
    await queryRunner.query(
      `CREATE TABLE "forecast_runs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "instrument_id" uuid NOT NULL,
        "ticker" character varying(20) NOT NULL,
        "view_kind" character varying(10) NOT NULL,
        "period_key" character varying(7),
        "revision" integer NOT NULL DEFAULT 0,
        "issued_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "feature_cutoff_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "anchor_session_date" date NOT NULL,
        "anchor_price" numeric(14,4) NOT NULL,
        "price_basis" character varying(12) NOT NULL DEFAULT 'close',
        "model_version" character varying(40) NOT NULL,
        "calibration_version" character varying(40) NOT NULL,
        "policy_version" character varying(40) NOT NULL,
        "input_manifest" jsonb NOT NULL,
        "input_hash" character varying(64) NOT NULL,
        "window_start" date NOT NULL,
        "window_end" date NOT NULL,
        "target_session_count" integer NOT NULL,
        "notes" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_forecast_runs" PRIMARY KEY ("id"),
        CONSTRAINT "FK_forecast_runs_instrument" FOREIGN KEY ("instrument_id")
          REFERENCES "instruments"("id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_forecast_runs_view_kind" CHECK ("view_kind" IN ('next30','month')),
        CONSTRAINT "CHK_forecast_runs_month_period" CHECK
          ("view_kind" <> 'month' OR "period_key" IS NOT NULL)
      )`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_forecast_runs_instrument" ON "forecast_runs" ("instrument_id")`
    );
    // next30: one issuance per (instrument, anchor session) — seeded engine
    // over the same inputs is bit-identical, so re-requests reuse the run.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_forecast_runs_next30_anchor" ON "forecast_runs"
        ("instrument_id", "anchor_session_date") WHERE "view_kind" = 'next30'`
    );
    // month: original snapshot (revision 0) + numbered outlook refreshes.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_forecast_runs_month_rev" ON "forecast_runs"
        ("instrument_id", "period_key", "revision") WHERE "view_kind" = 'month'`
    );

    // ── forecast_points (immutable, written with the run) ────────────────────
    await queryRunner.query(
      `CREATE TABLE "forecast_points" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "run_id" uuid NOT NULL,
        "target_date" date NOT NULL,
        "market_state" character varying(20) NOT NULL,
        "trading_day_offset" integer,
        "price_p05" numeric(14,4),
        "price_p10" numeric(14,4),
        "price_p25" numeric(14,4),
        "price_p50" numeric(14,4),
        "price_p75" numeric(14,4),
        "price_p90" numeric(14,4),
        "price_p95" numeric(14,4),
        "price_mean" numeric(14,4),
        "median_return_pct" numeric(9,4),
        "pop" numeric(6,4),
        "carries_forward_from" date,
        CONSTRAINT "PK_forecast_points" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_forecast_points_run_date" UNIQUE ("run_id", "target_date"),
        CONSTRAINT "FK_forecast_points_run" FOREIGN KEY ("run_id")
          REFERENCES "forecast_runs"("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_forecast_points_state" CHECK
          ("market_state" IN ('expected_session','weekend','expected_closed'))
      )`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_forecast_points_run" ON "forecast_points" ("run_id")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_forecast_points_target" ON "forecast_points" ("target_date")`
    );

    // ── forecast_outcomes (observations/evaluations, versioned) ──────────────
    await queryRunner.query(
      `CREATE TABLE "forecast_outcomes" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "point_id" uuid NOT NULL,
        "revision" integer NOT NULL DEFAULT 0,
        "state" character varying(15) NOT NULL,
        "observed_close" numeric(14,4),
        "observed_session_date" date,
        "realized_return_pct" numeric(9,4),
        "inside_band_80" boolean,
        "inside_band_90" boolean,
        "verified_at" TIMESTAMP WITH TIME ZONE,
        "note" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_forecast_outcomes" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_forecast_outcomes_point_rev" UNIQUE ("point_id", "revision"),
        CONSTRAINT "FK_forecast_outcomes_point" FOREIGN KEY ("point_id")
          REFERENCES "forecast_points"("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_forecast_outcomes_state" CHECK
          ("state" IN ('pending','verified','no_session','missing_data'))
      )`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_forecast_outcomes_point" ON "forecast_outcomes" ("point_id")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_forecast_outcomes_state" ON "forecast_outcomes" ("state")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "forecast_outcomes"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "forecast_points"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "forecast_runs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "trading_sessions"`);
  }
}
