import { MigrationInterface, QueryRunner } from "typeorm";

/** OpenAI-first upgrade (Part 1): full audit trail on ai_reviews. */
export class ExtendAiReviews1789000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE ai_reviews
        ADD COLUMN IF NOT EXISTS role varchar(40) NOT NULL DEFAULT 'risk_committee',
        ADD COLUMN IF NOT EXISTS response_id text,
        ADD COLUMN IF NOT EXISTS schema_version varchar(60),
        ADD COLUMN IF NOT EXISTS validation_result varchar(12),
        ADD COLUMN IF NOT EXISTS meta jsonb
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_ai_reviews_role ON ai_reviews (role)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_ai_reviews_input_hash ON ai_reviews (input_hash)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE ai_reviews
        DROP COLUMN IF EXISTS role,
        DROP COLUMN IF EXISTS response_id,
        DROP COLUMN IF EXISTS schema_version,
        DROP COLUMN IF EXISTS validation_result,
        DROP COLUMN IF EXISTS meta
    `);
  }
}
