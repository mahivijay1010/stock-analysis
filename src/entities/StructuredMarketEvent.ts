import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/**
 * StructuredMarketEvent (completion directive, Phase 9) — a point-in-time
 * market event with an explicit "when did this become knowable" timestamp.
 *
 * Source tiers (priority order, spec §9): 1 NSE/BSE exchange filings ·
 * 2 company IR / exchange-sourced data (Yahoo corporate actions, earnings
 * calendar) · 3 government/regulator · 4 reputable publications (classified
 * news) · 5 other. A consumer at time T may only read rows with
 * announcedAt ≤ T — the ingestors set announcedAt conservatively (never
 * earlier than provable knowability), so replays cannot leak the future.
 */
@Entity("structured_market_events")
@Index(["ticker", "announcedAt"])
@Index(["ticker", "eventType", "eventDate", "source"], { unique: true })
export class StructuredMarketEvent {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "varchar", length: 20 })
  ticker: string;

  /** earnings | dividend | split | order_win | regulatory | management_change | litigation | rating_change | results | other */
  @Column({ name: "event_type", type: "varchar", length: 30 })
  eventType: string;

  /** The date the event occurs / is effective (ex-date, earnings date, …). */
  @Column({ name: "event_date", type: "date" })
  eventDate: string;

  /** When the event became knowable to this system — the point-in-time key. */
  @Column({ name: "announced_at", type: "timestamptz" })
  announcedAt: Date;

  @Column({ type: "varchar", length: 80 })
  source: string;

  /** 1 exchange filing · 2 IR/exchange data · 3 government · 4 publications · 5 other. */
  @Column({ name: "source_tier", type: "smallint" })
  sourceTier: number;

  @Column({ type: "text", nullable: true })
  headline?: string | null;

  @Column({ type: "text", nullable: true })
  url?: string | null;

  @Column({ type: "jsonb", nullable: true })
  payload?: Record<string, unknown> | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
