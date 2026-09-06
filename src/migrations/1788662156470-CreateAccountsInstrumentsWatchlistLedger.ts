import { MigrationInterface, QueryRunner } from "typeorm";
import * as bcrypt from "bcrypt";
import { randomBytes } from "crypto";
import { NSE_UNIVERSE } from "../data/nseUniverse";

/**
 * Phase B2 reviewed migration — accounts, canonical instruments + aliases,
 * per-item watchlist, immutable transaction ledger + FIFO lot allocations
 * (docs/implementation-plan.md §2 dispositions; docs/upgrade-spec.md §3/§4/§11).
 *
 * Table names deliberately avoid the dead legacy tables (users, watchlists,
 * positions), which stay untouched as artifacts (plan §8 Q3).
 *
 * Seeds (idempotent — ON CONFLICT DO NOTHING):
 *  1. ONE owner account. Credentials come from env OWNER_USER / OWNER_PASS;
 *     when OWNER_PASS is absent a random password is generated and PRINTED
 *     ONCE to the console (it is bcrypt-hashed in the DB and cannot be
 *     recovered later — set OWNER_PASS in .env before running to control it).
 *     Registration stays disabled (plan §8 Q1 option b).
 *  2. `instruments` from the 151-symbol NSE_UNIVERSE (canonical ids for the
 *     supported universe — the actual coverage, not "all NSE").
 *  3. One economically-correct rename alias: ZOMATO(.NS) → ETERNAL.NS.
 *     The TATAMOTORS→TMCV/TMPV demerger is NOT seeded as an alias: a demerger
 *     has two successors and needs Phase C CorporateAction records — mapping
 *     it to either single instrument would merge unrelated histories (spec §6).
 *     Effective dates are left NULL (unverified from free sources — never
 *     invented).
 *
 * down(): drops ONLY the six tables this migration created, in FK-safe order.
 * Run only against a backed-up DB (fresh pg_dump is taken before live runs).
 */
export class CreateAccountsInstrumentsWatchlistLedger1788662156470 implements MigrationInterface {
  name = "CreateAccountsInstrumentsWatchlistLedger1788662156470";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── accounts ────────────────────────────────────────────────────────────
    await queryRunner.query(
      `CREATE TABLE "accounts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "username" character varying(100) NOT NULL,
        "email" character varying(255),
        "password_hash" character varying(100) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_accounts_username" UNIQUE ("username"),
        CONSTRAINT "UQ_accounts_email" UNIQUE ("email"),
        CONSTRAINT "PK_accounts" PRIMARY KEY ("id")
      )`
    );

    // ── instruments ─────────────────────────────────────────────────────────
    await queryRunner.query(
      `CREATE TABLE "instruments" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "yahoo_ticker" character varying(20) NOT NULL,
        "name" character varying(255) NOT NULL,
        "sector" character varying(100),
        "isin" character varying(12),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_instruments" PRIMARY KEY ("id")
      )`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_instruments_yahoo_ticker" ON "instruments" ("yahoo_ticker")`
    );

    // ── instrument_aliases ──────────────────────────────────────────────────
    await queryRunner.query(
      `CREATE TABLE "instrument_aliases" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "instrument_id" uuid NOT NULL,
        "alias" character varying(60) NOT NULL,
        "effective_from" date,
        "effective_to" date,
        "note" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_instrument_aliases" PRIMARY KEY ("id"),
        CONSTRAINT "FK_instrument_aliases_instrument" FOREIGN KEY ("instrument_id")
          REFERENCES "instruments"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_instrument_aliases_alias" ON "instrument_aliases" ("alias")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_instrument_aliases_instrument" ON "instrument_aliases" ("instrument_id")`
    );

    // ── watchlist_items ─────────────────────────────────────────────────────
    await queryRunner.query(
      `CREATE TABLE "watchlist_items" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "account_id" uuid NOT NULL,
        "instrument_id" uuid NOT NULL,
        "notes" text,
        "horizon" character varying(10) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_watchlist_items" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_watchlist_account_instrument" UNIQUE ("account_id", "instrument_id"),
        CONSTRAINT "CHK_watchlist_horizon" CHECK ("horizon" IN ('short','medium','long')),
        CONSTRAINT "FK_watchlist_items_account" FOREIGN KEY ("account_id")
          REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_watchlist_items_instrument" FOREIGN KEY ("instrument_id")
          REFERENCES "instruments"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
      )`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_watchlist_items_account" ON "watchlist_items" ("account_id")`
    );

    // ── ledger_transactions (immutable; corrections via corrects_id) ───────
    await queryRunner.query(
      `CREATE TABLE "ledger_transactions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "account_id" uuid NOT NULL,
        "instrument_id" uuid NOT NULL,
        "type" character varying(14) NOT NULL,
        "trade_date" date NOT NULL,
        "qty" numeric(18,4),
        "price" numeric(14,4),
        "gross_amount" numeric(16,4),
        "charges" numeric(14,4) NOT NULL DEFAULT '0',
        "is_estimated_price" boolean NOT NULL DEFAULT false,
        "note" text,
        "corrects_id" uuid,
        "idempotency_key" character varying(120),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ledger_transactions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_ledger_corrects_id" UNIQUE ("corrects_id"),
        CONSTRAINT "UQ_ledger_idempotency_key" UNIQUE ("idempotency_key"),
        CONSTRAINT "CHK_ledger_type" CHECK ("type" IN ('BUY','SELL','DIVIDEND','SPLIT','BONUS','CHARGE_ADJUST')),
        CONSTRAINT "CHK_ledger_charges_nonnegative" CHECK ("charges" >= 0),
        CONSTRAINT "FK_ledger_transactions_account" FOREIGN KEY ("account_id")
          REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_ledger_transactions_instrument" FOREIGN KEY ("instrument_id")
          REFERENCES "instruments"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_ledger_transactions_corrects" FOREIGN KEY ("corrects_id")
          REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
      )`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ledger_account" ON "ledger_transactions" ("account_id")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ledger_account_instrument_date" ON "ledger_transactions" ("account_id", "instrument_id", "trade_date")`
    );

    // ── lot_allocations (stored FIFO audit trail; never recomputed) ────────
    await queryRunner.query(
      `CREATE TABLE "lot_allocations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "sell_txn_id" uuid NOT NULL,
        "buy_txn_id" uuid NOT NULL,
        "qty" numeric(18,4) NOT NULL,
        "allocated_cost" numeric(16,4) NOT NULL,
        "realized_pnl" numeric(16,4) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_lot_allocations" PRIMARY KEY ("id"),
        CONSTRAINT "FK_lot_allocations_sell" FOREIGN KEY ("sell_txn_id")
          REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_lot_allocations_buy" FOREIGN KEY ("buy_txn_id")
          REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
      )`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_lot_allocations_sell" ON "lot_allocations" ("sell_txn_id")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_lot_allocations_buy" ON "lot_allocations" ("buy_txn_id")`
    );

    // ── Seed 1: the single owner account (idempotent) ───────────────────────
    const ownerUser = process.env.OWNER_USER || "owner";
    let ownerPass = process.env.OWNER_PASS || "";
    let generated = false;
    if (!ownerPass) {
      ownerPass = randomBytes(12).toString("base64url");
      generated = true;
    }
    const passwordHash = await bcrypt.hash(ownerPass, 12);
    const inserted: Array<{ id: string }> = await queryRunner.query(
      `INSERT INTO "accounts" ("username", "password_hash")
       VALUES ($1, $2)
       ON CONFLICT ("username") DO NOTHING
       RETURNING "id"`,
      [ownerUser, passwordHash]
    );
    if (inserted.length > 0 && generated) {
      // Printed exactly once, at seed time, on the machine running the
      // migration. Not logged anywhere else; only the bcrypt hash is stored.
      console.log(
        `\n════════════════════════════════════════════════════════════\n` +
          `  Owner account seeded: username "${ownerUser}"\n` +
          `  GENERATED PASSWORD (shown once, store it now): ${ownerPass}\n` +
          `  To choose your own, set OWNER_PASS in .env and reseed.\n` +
          `════════════════════════════════════════════════════════════\n`
      );
    } else if (inserted.length > 0) {
      console.log(`Owner account seeded: username "${ownerUser}" (password from OWNER_PASS env).`);
    } else {
      console.log(`Owner account "${ownerUser}" already exists — seed skipped.`);
    }

    // ── Seed 2: instruments from the verified 151-symbol universe ──────────
    for (const s of NSE_UNIVERSE) {
      await queryRunner.query(
        `INSERT INTO "instruments" ("yahoo_ticker", "name", "sector")
         VALUES ($1, $2, $3)
         ON CONFLICT ("yahoo_ticker") DO NOTHING`,
        [s.ticker, s.name, s.sector]
      );
    }

    // ── Seed 3: the one verified rename alias (ZOMATO → ETERNAL) ───────────
    await queryRunner.query(
      `INSERT INTO "instrument_aliases" ("instrument_id", "alias", "note")
       SELECT i."id", a.alias,
              'Former name of Eternal Ltd (company rename, identity-continuous). Exact effective dates unverified from free sources — left null.'
       FROM "instruments" i
       CROSS JOIN (VALUES ('ZOMATO.NS'), ('ZOMATO')) AS a(alias)
       WHERE i."yahoo_ticker" = 'ETERNAL.NS'
       ON CONFLICT ("alias") DO NOTHING`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // FK-safe reverse order. Drops ONLY what up() created (seeds included).
    await queryRunner.query(`DROP TABLE "lot_allocations"`);
    await queryRunner.query(`DROP TABLE "ledger_transactions"`);
    await queryRunner.query(`DROP TABLE "watchlist_items"`);
    await queryRunner.query(`DROP TABLE "instrument_aliases"`);
    await queryRunner.query(`DROP TABLE "instruments"`);
    await queryRunner.query(`DROP TABLE "accounts"`);
  }
}
