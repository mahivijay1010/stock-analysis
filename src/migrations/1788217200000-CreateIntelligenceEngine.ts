import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateIntelligenceEngine1788217200000 implements MigrationInterface {
  name = "CreateIntelligenceEngine1788217200000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`CREATE TABLE "intelligence_sources" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "ticker" varchar(20), "provider" varchar(40) NOT NULL,
      "source_level" smallint NOT NULL, "document_type" varchar(60) NOT NULL, "source_url" text NOT NULL,
      "source_document" text, "content_hash" varchar(64) NOT NULL, "media_type" varchar(120), "cache_path" text,
      "raw_payload" jsonb, "published_at" timestamptz, "retrieved_at" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "PK_intelligence_sources" PRIMARY KEY ("id"), CONSTRAINT "UQ_intelligence_sources_hash" UNIQUE ("content_hash"))`);
    await queryRunner.query(`CREATE INDEX "IDX_intelligence_sources_ticker_provider_date" ON "intelligence_sources" ("ticker", "provider", "published_at")`);
    await queryRunner.query(`CREATE TABLE "financial_facts" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "ticker" varchar(20) NOT NULL, "concept" varchar(80) NOT NULL,
      "raw_concept" varchar(255) NOT NULL, "context_id" varchar(255) NOT NULL, "value" numeric(30,6) NOT NULL,
      "currency" varchar(20), "unit" varchar(80), "period_start" date, "period_end" date NOT NULL,
      "period_type" varchar(20) NOT NULL, "consolidation" varchar(20) NOT NULL DEFAULT 'UNKNOWN',
      "status" varchar(24) NOT NULL, "confidence" varchar(10) NOT NULL, "source_id" uuid NOT NULL,
      "source_url" text NOT NULL, "validation_notes" jsonb, "created_at" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "PK_financial_facts" PRIMARY KEY ("id"),
      CONSTRAINT "UQ_financial_fact_source_concept_context" UNIQUE ("source_id", "raw_concept", "context_id"),
      CONSTRAINT "FK_financial_fact_source" FOREIGN KEY ("source_id") REFERENCES "intelligence_sources"("id") ON DELETE RESTRICT)`);
    await queryRunner.query(`CREATE INDEX "IDX_financial_facts_lookup" ON "financial_facts" ("ticker", "concept", "period_end", "consolidation")`);
    await queryRunner.query(`CREATE TABLE "intelligence_metrics" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "ticker" varchar(20), "metric" varchar(80) NOT NULL,
      "value" numeric(30,8), "value_json" jsonb, "period" varchar(40) NOT NULL, "formula" text,
      "input_values" jsonb NOT NULL DEFAULT '{}', "methodology" varchar(80) NOT NULL DEFAULT 'STANDARD',
      "sources" jsonb NOT NULL DEFAULT '[]', "status" varchar(24) NOT NULL, "confidence" varchar(10) NOT NULL,
      "reason" text, "published_at" timestamptz, "calculated_at" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "PK_intelligence_metrics" PRIMARY KEY ("id"))`);
    await queryRunner.query(`CREATE INDEX "IDX_intelligence_metrics_lookup" ON "intelligence_metrics" ("ticker", "metric", "period", "methodology")`);
    await queryRunner.query(`CREATE TABLE "intelligence_evidence" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "ticker" varchar(20), "category" varchar(60) NOT NULL,
      "label" varchar(120), "value" numeric(30,6), "currency" varchar(20), "excerpt" text NOT NULL,
      "as_of_date" date, "source_id" uuid, "source_url" text NOT NULL, "status" varchar(24) NOT NULL,
      "confidence" varchar(10) NOT NULL, "metadata" jsonb NOT NULL DEFAULT '{}', "created_at" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "PK_intelligence_evidence" PRIMARY KEY ("id"),
      CONSTRAINT "FK_intelligence_evidence_source" FOREIGN KEY ("source_id") REFERENCES "intelligence_sources"("id") ON DELETE RESTRICT)`);
    await queryRunner.query(`CREATE INDEX "IDX_intelligence_evidence_lookup" ON "intelligence_evidence" ("ticker", "category", "as_of_date")`);
    await queryRunner.query(`CREATE TABLE "macro_observations" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "indicator" varchar(100) NOT NULL, "value" numeric(30,8) NOT NULL,
      "unit" varchar(30), "period" varchar(40) NOT NULL, "provider" varchar(40) NOT NULL, "source_url" text NOT NULL,
      "publication_date" date, "status" varchar(24) NOT NULL DEFAULT 'RAW', "confidence" varchar(10) NOT NULL DEFAULT 'HIGH',
      "metadata" jsonb NOT NULL DEFAULT '{}', "retrieved_at" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "PK_macro_observations" PRIMARY KEY ("id"),
      CONSTRAINT "UQ_macro_observation" UNIQUE ("indicator", "period", "source_url"))`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "macro_observations"`);
    await queryRunner.query(`DROP TABLE "intelligence_evidence"`);
    await queryRunner.query(`DROP TABLE "intelligence_metrics"`);
    await queryRunner.query(`DROP TABLE "financial_facts"`);
    await queryRunner.query(`DROP TABLE "intelligence_sources"`);
  }
}
