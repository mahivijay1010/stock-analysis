import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Reviewer P0 #2 — the reconciliation identity (total = resolved + pending)
 * cannot detect a DUPLICATED shadow row: 101 = 90 + 11 still "balances" while
 * the ledger is corrupt. The durable guard is a DB-level uniqueness constraint
 * on the shadow prediction's natural identity, which also makes the existing
 * `.orIgnore()` insert genuinely idempotent (it had no conflict target before).
 *
 * Identity: one prediction per (ticker, anchor_date, setup_type, horizon,
 * model_version). Any re-scan of the same session is a no-op, not a second
 * prospective observation.
 */
export class ShadowPredictionUniqueIdentity1789300000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    // Collapse any pre-existing duplicates, keeping the earliest (a resolved
    // outcome, if any, survives because we prefer the row with an outcome then
    // the lowest id) before the unique index can be built.
    await q.query(`
      DELETE FROM short_term_shadow_predictions a
      USING short_term_shadow_predictions b
      WHERE a.ticker = b.ticker
        AND a.anchor_date = b.anchor_date
        AND a.setup_type = b.setup_type
        AND a.horizon = b.horizon
        AND a.model_version = b.model_version
        AND (
          (a.outcome IS NULL AND b.outcome IS NOT NULL)          -- drop the unresolved dup
          OR (((a.outcome IS NULL) = (b.outcome IS NULL)) AND a.id > b.id) -- else drop the newer id
        )`);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_shadow_identity
        ON short_term_shadow_predictions (ticker, anchor_date, setup_type, horizon, model_version)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS uq_shadow_identity`);
  }
}
