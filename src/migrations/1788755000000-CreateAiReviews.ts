import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Risk-spec T4 reviewed migration ("AI API DESIGN") — append-only audit trail
 * for every AI-committee call: prompt version, model, input hash, full
 * request/response, clamp record, latency, token usage. down() drops only
 * this table.
 */
export class CreateAiReviews1788755000000 implements MigrationInterface {
  name = "CreateAiReviews1788755000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "ai_reviews" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "ticker" character varying(20) NOT NULL,
        "prompt_version" character varying(40) NOT NULL,
        "model_name" character varying(60) NOT NULL,
        "provider" character varying(20) NOT NULL,
        "input_hash" character varying(64) NOT NULL,
        "request_context" jsonb NOT NULL,
        "response" jsonb NOT NULL,
        "clamped" boolean NOT NULL DEFAULT false,
        "clamp_notes" jsonb,
        "latency_ms" integer NOT NULL,
        "tokens_in" integer,
        "tokens_out" integer,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ai_reviews" PRIMARY KEY ("id")
      )`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ai_reviews_ticker_created" ON "ai_reviews" ("ticker", "created_at" DESC)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_reviews"`);
  }
}
