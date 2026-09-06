import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Phase C reviewed migration — canonical decision snapshots (spec §9).
 * Append-only publications from the ONE DecisionService; every surface reads
 * the same snapshot. down() drops only this table.
 */
export class CreateDecisionSnapshots1788750000000 implements MigrationInterface {
  name = "CreateDecisionSnapshots1788750000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "decision_snapshots" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "instrument_id" uuid NOT NULL,
        "ticker" character varying(20) NOT NULL,
        "decision_status" character varying(25) NOT NULL,
        "evidence_status" character varying(15) NOT NULL,
        "risk_level" character varying(10) NOT NULL,
        "intended_horizon" character varying(10) NOT NULL,
        "reasons" jsonb NOT NULL,
        "risks" jsonb NOT NULL,
        "holdings_review_note" text NOT NULL,
        "inputs" jsonb NOT NULL,
        "as_of" TIMESTAMP WITH TIME ZONE NOT NULL,
        "valid_until" TIMESTAMP WITH TIME ZONE NOT NULL,
        "model_version" character varying(40) NOT NULL,
        "decision_policy_version" character varying(40) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_decision_snapshots" PRIMARY KEY ("id"),
        CONSTRAINT "FK_decision_snapshots_instrument" FOREIGN KEY ("instrument_id")
          REFERENCES "instruments"("id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_decision_snapshots_status" CHECK
          ("decision_status" IN ('BUY_CANDIDATE','WAIT','AVOID_NEW_ENTRY','INSUFFICIENT_EVIDENCE')),
        CONSTRAINT "CHK_decision_snapshots_evidence" CHECK
          ("evidence_status" IN ('VALIDATED','PARTIAL','INSUFFICIENT'))
      )`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_decision_snapshots_instrument_asof"
        ON "decision_snapshots" ("instrument_id", "as_of" DESC)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "decision_snapshots"`);
  }
}
