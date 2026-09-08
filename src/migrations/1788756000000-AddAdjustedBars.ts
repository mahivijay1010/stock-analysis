import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Completion Phase 1 reviewed migration — corporate-action-aware bar storage.
 * stock_history gains the Yahoo adjusted close plus per-date split factor and
 * dividend amount (nullable: rows persisted before this feature stay null and
 * heal on the next fetch of their range — persistBars delete/reinserts the
 * whole fetched window). Completed-session-only storage is already guaranteed
 * by dropPartialTodayBar at persist time. down() drops only these columns.
 */
export class AddAdjustedBars1788756000000 implements MigrationInterface {
  name = "AddAdjustedBars1788756000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "stock_history" ADD COLUMN "adjusted_close" numeric(12,4)`);
    await queryRunner.query(`ALTER TABLE "stock_history" ADD COLUMN "split_factor" numeric(12,6)`);
    await queryRunner.query(`ALTER TABLE "stock_history" ADD COLUMN "dividend" numeric(12,4)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "stock_history" DROP COLUMN IF EXISTS "dividend"`);
    await queryRunner.query(`ALTER TABLE "stock_history" DROP COLUMN IF EXISTS "split_factor"`);
    await queryRunner.query(`ALTER TABLE "stock_history" DROP COLUMN IF EXISTS "adjusted_close"`);
  }
}
