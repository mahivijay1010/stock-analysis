import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Risk-spec Stage THIRD (T1) reviewed migration — decision snapshots gain the
 * separated ScoreCard, the after-cost expected-value report, and the SEPARATE
 * existing-holder decision (Rules 1, 8, 14). All nullable: snapshots published
 * before this feature simply don't carry them. down() drops only these columns.
 */
export class AddDecisionScorecard1788753000000 implements MigrationInterface {
  name = "AddDecisionScorecard1788753000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "decision_snapshots" ADD COLUMN "score_card" jsonb`);
    await queryRunner.query(`ALTER TABLE "decision_snapshots" ADD COLUMN "expected_value" jsonb`);
    await queryRunner.query(`ALTER TABLE "decision_snapshots" ADD COLUMN "existing_holder_action" character varying(20)`);
    await queryRunner.query(`ALTER TABLE "decision_snapshots" ADD COLUMN "holder_reasons" jsonb`);
    await queryRunner.query(`ALTER TABLE "decision_snapshots" ADD COLUMN "unmet_gates" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "decision_snapshots" DROP COLUMN IF EXISTS "unmet_gates"`);
    await queryRunner.query(`ALTER TABLE "decision_snapshots" DROP COLUMN IF EXISTS "holder_reasons"`);
    await queryRunner.query(`ALTER TABLE "decision_snapshots" DROP COLUMN IF EXISTS "existing_holder_action"`);
    await queryRunner.query(`ALTER TABLE "decision_snapshots" DROP COLUMN IF EXISTS "expected_value"`);
    await queryRunner.query(`ALTER TABLE "decision_snapshots" DROP COLUMN IF EXISTS "score_card"`);
  }
}
