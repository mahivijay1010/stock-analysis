import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from "typeorm";

/**
 * Postgres `decimal` columns come back as strings — this transformer keeps
 * the entity fields as real numbers. Shared by the V2 paper-trading entities.
 */
export class NumericTransformer {
  to(value?: number | null): number | null | undefined {
    return value;
  }
  from(value?: string | null): number | null {
    if (value === null || value === undefined) return null;
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }
}

/**
 * PaperAccount (Module V2-D) — a paper-trading account for the admin desk.
 * Seeded once on boot with name "admin", startCapital = cash = ₹1,000.
 * NEW table — existing entities are untouched.
 */
@Entity("paper_accounts")
export class PaperAccount {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "varchar", length: 100, unique: true })
  name: string;

  @Column({
    name: "start_capital",
    type: "decimal",
    precision: 14,
    scale: 2,
    transformer: new NumericTransformer(),
  })
  startCapital: number;

  @Column({
    type: "decimal",
    precision: 14,
    scale: 2,
    transformer: new NumericTransformer(),
  })
  cash: number;

  /** Dynamic goal: ₹ target the user wants to reach (default 1,00,000 when null). */
  @Column({
    name: "target_amount",
    type: "decimal",
    precision: 14,
    scale: 2,
    nullable: true,
    transformer: new NumericTransformer(),
  })
  targetAmount?: number | null;

  /** Dynamic goal: days to reach the target (default 30 when null). */
  @Column({ name: "target_days", type: "int", nullable: true })
  targetDays?: number | null;

  /** When the current challenge run started (set on reset; createdAt fallback). */
  @Column({ name: "challenge_started_at", type: "timestamptz", nullable: true })
  challengeStartedAt?: Date | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
