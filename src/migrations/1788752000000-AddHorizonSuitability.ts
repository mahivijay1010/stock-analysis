import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds the risk-character holding-horizon assessment to decision snapshots
 * (owner request 2026-09-06; spec §9's separate horizon evidence). Nullable:
 * snapshots published before this feature simply don't carry one.
 */
export class AddHorizonSuitability1788752000000 implements MigrationInterface {
  name = "AddHorizonSuitability1788752000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "decision_snapshots" ADD COLUMN "horizon_suitability" jsonb`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "decision_snapshots" DROP COLUMN IF EXISTS "horizon_suitability"`
    );
  }
}
