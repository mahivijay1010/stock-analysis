import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Phase D reviewed migration — the experiment registry (spec §8).
 * Append-only evaluation runs with dataset hashes and baseline comparisons;
 * distinct from the legacy `model_registry` table (untouched artifact).
 * down() drops only this table.
 */
export class CreateExperimentRuns1788751000000 implements MigrationInterface {
  name = "CreateExperimentRuns1788751000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "experiment_runs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying(120) NOT NULL,
        "kind" character varying(20) NOT NULL,
        "model_version" character varying(60) NOT NULL,
        "config" jsonb NOT NULL,
        "splits" jsonb NOT NULL,
        "dataset_manifest" jsonb NOT NULL,
        "dataset_hash" character varying(64) NOT NULL,
        "metrics" jsonb,
        "baselines" jsonb,
        "segments_used" jsonb NOT NULL,
        "used_final_test" boolean NOT NULL DEFAULT false,
        "status" character varying(12) NOT NULL,
        "error" text,
        "notes" text,
        "started_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "finished_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_experiment_runs" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_experiment_runs_status" CHECK ("status" IN ('completed','failed'))
      )`
    );
    await queryRunner.query(`CREATE INDEX "IDX_experiment_runs_name" ON "experiment_runs" ("name")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_experiment_runs_model" ON "experiment_runs" ("model_version", "created_at" DESC)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "experiment_runs"`);
  }
}
