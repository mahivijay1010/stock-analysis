import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/**
 * Provenance for every scraped/polled market reading (reviewer: store enough to
 * know what produced an evaluation). One row per source per security per cycle,
 * append-only. rawHash lets us prove the parsed payload; parsingVersion lets us
 * detect that a scraper change (not a market move) shifted a value.
 *
 * NOTE: this is LIVE-panel provenance ONLY. It never feeds financial_facts (the
 * point-in-time XBRL store backtests read) — the backtest firewall stands.
 */
@Entity("market_source_snapshots")
@Index(["ticker", "fetchedAt"])
export class MarketSourceSnapshot {
  @PrimaryGeneratedColumn("uuid") id: string;

  @Column({ type: "varchar", length: 20 }) ticker: string;
  @Column({ type: "varchar", length: 40 }) source: string;
  @Column({ name: "source_url", type: "text", nullable: true }) sourceUrl?: string | null;

  @Column({ name: "mode", type: "varchar", length: 20 }) mode: string; // SCRAPED_SNAPSHOT | INTRADAY_CANDLES | STREAMING

  @Column({ name: "fetched_at", type: "timestamptz" }) fetchedAt: Date;
  @Column({ name: "source_timestamp", type: "timestamptz", nullable: true }) sourceTimestamp?: Date | null;

  /** sha256 of the raw parsed quote — provenance + parser-drift detection. */
  @Column({ name: "raw_hash", type: "varchar", length: 64 }) rawHash: string;
  @Column({ name: "parsing_version", type: "varchar", length: 40 }) parsingVersion: string;

  @Column({ type: "numeric", precision: 14, scale: 4, nullable: true }) price?: string | null;
  @Column({ type: "numeric", precision: 14, scale: 4, nullable: true }) open?: string | null;
  @Column({ type: "numeric", precision: 14, scale: 4, nullable: true }) high?: string | null;
  @Column({ type: "numeric", precision: 14, scale: 4, nullable: true }) low?: string | null;
  @Column({ type: "numeric", precision: 20, scale: 2, nullable: true }) volume?: string | null;
  @Column({ name: "change_pct", type: "numeric", precision: 10, scale: 4, nullable: true }) changePct?: string | null;

  /** Freshness × parse-validity outcome for this cycle's merged snapshot. */
  @Column({ name: "quality_status", type: "varchar", length: 25 }) qualityStatus: string;
  @Column({ name: "freshness_status", type: "varchar", length: 20 }) freshnessStatus: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}
