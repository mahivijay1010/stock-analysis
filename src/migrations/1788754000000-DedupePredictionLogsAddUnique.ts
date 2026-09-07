import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Risk-spec T3 reviewed migration (audit §5) — prediction_logs had NO
 * database-level uniqueness on its identity (ticker, model_version,
 * prediction_date, horizon_days); the "append-only-if-absent" guarantee was a
 * race-prone application-level count-then-save. Concurrent analyzes could
 * double-log a day's prediction.
 *
 * 1. Deletes EXACT-identity duplicate rows, keeping the EARLIEST
 *    (created_at, id) — the first logged prediction is the honest one; later
 *    duplicates were bookkeeping accidents. As of 2026-09-07 the only
 *    duplicates are 14 surplus legacy "v1.0.0" rows from 2025-11 with NULL
 *    horizon_days (the audit's known orphans); the live "quant-v1" path has
 *    none. A verified pre-upgrade backup exists (backups/).
 * 2. Adds a partial UNIQUE index over the identity for rows with a horizon —
 *    every row the live writer creates — closing the race permanently.
 *
 * down(): drops the index. Deleted duplicate rows are NOT restorable by
 * down() — restore from backup if ever needed (they carried no verified
 * outcomes).
 */
export class DedupePredictionLogsAddUnique1788754000000 implements MigrationInterface {
  name = "DedupePredictionLogsAddUnique1788754000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM prediction_logs a
        USING prediction_logs b
        WHERE a.ticker = b.ticker
          AND a.model_version = b.model_version
          AND a.prediction_date = b.prediction_date
          AND a.horizon_days IS NOT DISTINCT FROM b.horizon_days
          AND (a.created_at, a.id) > (b.created_at, b.id)`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_prediction_logs_identity"
         ON "prediction_logs" ("ticker", "model_version", "prediction_date", "horizon_days")
        WHERE "horizon_days" IS NOT NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_prediction_logs_identity"`);
  }
}
