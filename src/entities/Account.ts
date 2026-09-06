import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from "typeorm";

/**
 * Account (Phase B2, spec §11 User/Account) — a real user account owning
 * watchlist items and ledger transactions.
 *
 * Deliberately a NEW table named `accounts`: the dead legacy `users` table
 * (0 rows, zero code references) is preserved untouched as an artifact and
 * will be archived/dropped only via its own reviewed migration
 * (implementation-plan §8 Q3 — name-collision avoidance).
 *
 * Auth model (plan §8 Q1 option b): single seeded owner account, registration
 * disabled, session cookie auth. Identity is ALWAYS derived server-side from
 * the session — never from a client-supplied account id (spec §12).
 */
@Entity("accounts")
export class Account {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "varchar", length: 100, unique: true })
  username: string;

  /** Optional contact email; not used for login in B2. */
  @Column({ type: "varchar", length: 255, nullable: true, unique: true })
  email?: string | null;

  /** bcrypt hash — never a plaintext or reversible value. */
  @Column({ name: "password_hash", type: "varchar", length: 100 })
  passwordHash: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
