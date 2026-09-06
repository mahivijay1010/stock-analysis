import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * TradingSession (Phase C, spec §5) — one row per IST calendar date the
 * calendar has an opinion about. Replaces the weekday heuristic for product
 * dates: forecasts target *resolved* sessions, not "30 days ≈ 21 sessions".
 *
 * status:
 *  - "session"  — trading happened / is expected to happen on this date
 *  - "closed"   — no trading (weekend, holiday, unexpected closure)
 * basis (how we know):
 *  - "observed"           — real bars exist in stock_history for this date
 *  - "weekend"            — Sat/Sun, closed by rule
 *  - "no_data"            — past weekday where the whole universe produced no
 *                           bars → reconciled as a holiday/unexpected closure
 *  - "weekday_projection" — FUTURE weekday, provisionally a session until the
 *                           date passes and reconciliation confirms/corrects it
 *  - "official_calendar"  — from an ingested official NSE holiday list (none
 *                           seeded: free sources are unverified; ingestion
 *                           hook exists for when the user supplies one)
 *
 * Future dates are honest "expected" states, never presented as certain; the
 * daily reconcile job flips weekday_projection → observed/no_data once real
 * data arrives (spec: unexpected closures need explicit states).
 */
@Entity("trading_sessions")
export class TradingSession {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index("UQ_trading_sessions_date", { unique: true })
  @Column({ name: "session_date", type: "date" })
  sessionDate: string;

  @Column({ type: "varchar", length: 10 })
  status: "session" | "closed";

  @Column({ type: "varchar", length: 20 })
  basis: "observed" | "weekend" | "no_data" | "weekday_projection" | "official_calendar";

  /** Holiday name / closure note when known. */
  @Column({ type: "varchar", length: 120, nullable: true })
  label?: string | null;

  /** Set when basis becomes "observed" or "no_data" (reconciled against data). */
  @Column({ name: "confirmed_at", type: "timestamptz", nullable: true })
  confirmedAt?: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
