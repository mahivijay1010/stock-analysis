import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Completion Phase 7 reviewed migration — the calibrator registry.
 * Append-only: every fit is recorded with its held-out verdict; only
 * `promoted` rows ever reach the product. down() drops only this table.
 */
export class CreateCalibrators1788757000000 implements MigrationInterface {
  name = "CreateCalibrators1788757000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "calibrators" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "model_name" character varying(60) NOT NULL,
        "horizon_days" integer NOT NULL,
        "calibrator_type" character varying(12),
        "version" character varying(20),
        "params" jsonb,
        "training_start" date,
        "training_end" date,
        "effective_samples" integer NOT NULL,
        "brier_before" numeric(8,4) NOT NULL,
        "brier_after" numeric(8,4),
        "ece_before" numeric(8,4) NOT NULL,
        "ece_after" numeric(8,4),
        "promoted" boolean NOT NULL DEFAULT false,
        "verdict" text NOT NULL,
        "experiment_run_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_calibrators" PRIMARY KEY ("id")
      )`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_calibrators_model_horizon" ON "calibrators" ("model_name", "horizon_days", "created_at" DESC)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "calibrators"`);
  }
}
