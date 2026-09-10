import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Reviewer follow-up (post batch #2), two corrections in one migration:
 *
 *  (1) IDENTITY TIGHTENING — the ORIGINAL table migration (1789100000000)
 *      created `uq_st_shadow` on only (ticker, anchor_date, setup_type,
 *      horizon) — narrower even than model_version, so a re-run under a bumped
 *      MODEL, policy, or feature definition was SUPPRESSED by the `.orIgnore()`
 *      insert (correcting the batch-#2 note that claimed there was no conflict
 *      target: there was, and it was too narrow). We drop both the original
 *      4-col index and the batch-#2 5-col `uq_shadow_identity`, replacing them
 *      with a single 7-col identity spanning ALL THREE version axes that change
 *      what a prediction MEANS — model, policy, feature/setup definition.
 *      (A future branch replaces this composite with a decision_snapshot_id.)
 *
 *  (2) LEGACY R SEMANTIC SPLIT — before the realized/conservative split, an
 *      AMBIGUOUS_INTRABAR row stored its synthetic ADVERSE value in
 *      `netRMultiple`. New realized-expectancy queries COALESCE(realizedNetR,
 *      netRMultiple), so such a legacy row could leak back in as a REALIZED
 *      observation. We rewrite historical outcome JSON to the explicit split:
 *        ambiguous → realizedNetR=null, conservativeNetR=old netR, netRMultiple=null
 *        other filled scored → realized=conservative=bestCase=old netR
 *      so no synthetic number is ever read as realized, with or without the
 *      COALESCE fallback.
 *
 *  NOTE: rows written BEFORE the AMBIGUOUS_INTRABAR label existed recorded a
 *  same-bar straddle as STOP_FIRST and are unrecoverable (we cannot tell which
 *  historical stops were really straddles). In this deployment no such
 *  prospective rows have accumulated yet, so the backfill is effectively a
 *  no-op guard rather than a lossy repair.
 */
export class ShadowIdentityVersionsAndLegacyRSplit1789400000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    // (1) version axes — defaults backfill existing rows to the current constants.
    await q.query(`ALTER TABLE short_term_shadow_predictions
      ADD COLUMN IF NOT EXISTS policy_version varchar(40) NOT NULL DEFAULT 'st-policy-v1'`);
    await q.query(`ALTER TABLE short_term_shadow_predictions
      ADD COLUMN IF NOT EXISTS feature_version varchar(40) NOT NULL DEFAULT 'st-features-v1'`);

    // Collapse any duplicates under the WIDENED identity before re-indexing.
    await q.query(`
      DELETE FROM short_term_shadow_predictions a
      USING short_term_shadow_predictions b
      WHERE a.ticker = b.ticker AND a.anchor_date = b.anchor_date
        AND a.setup_type = b.setup_type AND a.horizon = b.horizon
        AND a.model_version = b.model_version AND a.policy_version = b.policy_version
        AND a.feature_version = b.feature_version
        AND (
          (a.outcome IS NULL AND b.outcome IS NOT NULL)
          OR (((a.outcome IS NULL) = (b.outcome IS NULL)) AND a.id > b.id)
        )`);
    await q.query(`DROP INDEX IF EXISTS uq_st_shadow`); // original 4-col culprit
    await q.query(`DROP INDEX IF EXISTS uq_shadow_identity`); // batch-#2 5-col
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_shadow_identity
        ON short_term_shadow_predictions
        (ticker, anchor_date, setup_type, horizon, model_version, policy_version, feature_version)`);

    // (2a) legacy AMBIGUOUS rows: null realized + alias, keep the adverse value
    // ONLY as the conservative (safety) number.
    await q.query(`
      UPDATE short_term_shadow_predictions
      SET outcome = outcome || jsonb_build_object(
            'realizedNetR', NULL::numeric,
            'conservativeNetR', (outcome->>'netRMultiple')::numeric,
            'bestCaseNetR', NULL::numeric,
            'netRMultiple', NULL::numeric,
            'resolutionSource', 'CONSERVATIVE_ASSUMPTION')
      WHERE outcome IS NOT NULL
        AND (outcome->>'outcome') = 'AMBIGUOUS_INTRABAR'
        AND NOT (outcome ? 'realizedNetR')`);

    // (2b) legacy OBSERVED filled rows: realized == conservative == best-case.
    await q.query(`
      UPDATE short_term_shadow_predictions
      SET outcome = outcome || jsonb_build_object(
            'realizedNetR', (outcome->>'netRMultiple')::numeric,
            'conservativeNetR', (outcome->>'netRMultiple')::numeric,
            'bestCaseNetR', (outcome->>'netRMultiple')::numeric,
            'resolutionSource', 'DAILY_BAR')
      WHERE outcome IS NOT NULL
        AND (outcome->>'outcome') NOT IN ('AMBIGUOUS_INTRABAR', 'DATA_INVALID')
        AND (outcome->>'filled')::boolean IS TRUE
        AND (outcome ? 'netRMultiple') AND (outcome->>'netRMultiple') IS NOT NULL
        AND NOT (outcome ? 'realizedNetR')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    // Restore the prior (narrower) indexes; the outcome-JSON rewrite is not
    // reversed (the pre-split shape is ambiguous by construction — that was the
    // bug). Recreating uq_st_shadow may fail if data now violates the 4-col
    // uniqueness — acceptable for a rollback of an intentional widening.
    await q.query(`DROP INDEX IF EXISTS uq_shadow_identity`);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_shadow_identity
        ON short_term_shadow_predictions
        (ticker, anchor_date, setup_type, horizon, model_version)`);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_st_shadow
        ON short_term_shadow_predictions (ticker, anchor_date, setup_type, horizon)`);
    await q.query(`ALTER TABLE short_term_shadow_predictions DROP COLUMN IF EXISTS feature_version`);
    await q.query(`ALTER TABLE short_term_shadow_predictions DROP COLUMN IF EXISTS policy_version`);
  }
}
