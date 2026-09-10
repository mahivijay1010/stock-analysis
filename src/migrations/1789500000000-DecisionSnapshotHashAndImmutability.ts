import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Immutable DecisionSnapshot branch (reviewer #29). Two additions to the
 * existing decision_snapshots table:
 *
 *  (1) HASH PINNING — input_manifest_hash (sha256 over {versionManifest,
 *      gateInputs}) and decision_hash (sha256 over the gate output). These make
 *      a snapshot a verifiable, replayable evidence object: same sealed inputs
 *      + same policy version ⇒ same decision_hash. The shadow ledger and AI
 *      grounding can later reference a snapshot by input_manifest_hash instead
 *      of the temporary 7-column composite identity.
 *
 *  (2) APPEND-ONLY ENFORCEMENT — a BEFORE UPDATE OR DELETE trigger REJECTS any
 *      mutation. A snapshot is a historical fact; editing or deleting one
 *      corrupts the audit trail. An explicit administrative override exists
 *      (set the GUC `stocksense.allow_snapshot_mutation = 'on'` inside a
 *      deliberate transaction) so a retention/GDPR process is still possible —
 *      but ordinary code physically cannot alter a published decision.
 */
export class DecisionSnapshotHashAndImmutability1789500000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS input_manifest_hash varchar(64)`);
    await q.query(`ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS decision_hash varchar(64)`);
    // Reference snapshots by their pinned identity.
    await q.query(`CREATE INDEX IF NOT EXISTS idx_decision_snapshots_input_hash ON decision_snapshots (input_manifest_hash)`);

    await q.query(`
      CREATE OR REPLACE FUNCTION reject_decision_snapshot_mutation() RETURNS trigger AS $func$
      BEGIN
        IF current_setting('stocksense.allow_snapshot_mutation', true) IS DISTINCT FROM 'on' THEN
          RAISE EXCEPTION 'decision_snapshots is append-only: % is blocked. A published decision is an immutable historical fact. To run an explicit retention operation, SET stocksense.allow_snapshot_mutation = ''on'' within the transaction.', TG_OP;
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END;
      $func$ LANGUAGE plpgsql`);
    await q.query(`DROP TRIGGER IF EXISTS trg_decision_snapshots_immutable ON decision_snapshots`);
    await q.query(`
      CREATE TRIGGER trg_decision_snapshots_immutable
        BEFORE UPDATE OR DELETE ON decision_snapshots
        FOR EACH ROW EXECUTE FUNCTION reject_decision_snapshot_mutation()`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS trg_decision_snapshots_immutable ON decision_snapshots`);
    await q.query(`DROP FUNCTION IF EXISTS reject_decision_snapshot_mutation()`);
    await q.query(`DROP INDEX IF EXISTS idx_decision_snapshots_input_hash`);
    await q.query(`ALTER TABLE decision_snapshots DROP COLUMN IF EXISTS decision_hash`);
    await q.query(`ALTER TABLE decision_snapshots DROP COLUMN IF EXISTS input_manifest_hash`);
  }
}
