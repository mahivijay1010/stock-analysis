import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * daily_direction_policy — the governed direction policy for each daily
 * horizon (1/3/7/15/30), mirroring intraday_model_params.
 *
 * quant-v1 keeps logging its raw call to prediction_logs; a policy is a
 * transform of that call (incumbent / reversal / market-neutral / null) that
 * governs what direction is SHOWN. The nightly daily challenger
 * (dailyChallengerRun.ts) may replace a horizon's ACTIVE row only under the
 * rule pre-registered there on 2026-10-01. Exactly one ACTIVE row per
 * horizon. Rows are append-only (shared reject_live_history_mutation()
 * trigger); the single ACTIVE→RETIRED state change at promotion runs under
 * the admin GUC, as for intraday params.
 */
export class CreateDailyDirectionPolicy1790200000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS daily_direction_policy (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      horizon_days int NOT NULL,
      version varchar(60) NOT NULL UNIQUE,
      policy varchar(20) NOT NULL,
      state varchar(12) NOT NULL,
      reason text NOT NULL,
      experiment_run_id uuid,
      /* Prospective evidence the promotion rested on. Null for the seeded
         incumbents, which predate any prospective result. */
      evidence jsonb,
      promoted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT chk_ddp_state CHECK (state IN ('CANDIDATE','ACTIVE','RETIRED')),
      CONSTRAINT chk_ddp_policy CHECK (policy IN ('incumbent','reversal','market-neutral','null'))
    )`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_ddp_one_active ON daily_direction_policy (horizon_days) WHERE state = 'ACTIVE'`);

    for (const h of [1, 3, 7, 15, 30]) {
      await q.query(
        `INSERT INTO daily_direction_policy (horizon_days, version, policy, state, reason, promoted_at)
         VALUES ($1, $2, 'incumbent', 'ACTIVE', $3, now())
         ON CONFLICT (version) DO NOTHING`,
        [
          h,
          `dp-${h}d-v1-incumbent`,
          "Seed: quant-v1 direction as logged, held as the incumbent to be BEATEN prospectively. Measured 2026-10-01 in-sample " +
            "(2026-09-17..29): it lost to a constant always-DOWN at 1/3/7d and its picks scored 47–49% against the cohort median.",
        ]
      );
    }

    await q.query(`DROP TRIGGER IF EXISTS trg_daily_direction_policy_immutable ON daily_direction_policy`);
    await q.query(
      `CREATE TRIGGER trg_daily_direction_policy_immutable BEFORE UPDATE OR DELETE ON daily_direction_policy FOR EACH ROW EXECUTE FUNCTION reject_live_history_mutation()`
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS trg_daily_direction_policy_immutable ON daily_direction_policy`);
    await q.query(`DROP TABLE IF EXISTS daily_direction_policy`);
  }
}
