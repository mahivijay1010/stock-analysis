import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/** Immutable metadata/payload snapshot for every external retrieval. */
@Entity("intelligence_sources")
@Index(["ticker", "provider", "publishedAt"])
@Index(["contentHash"], { unique: true })
export class IntelligenceSource {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 20, nullable: true })
  ticker?: string | null;

  @Column({ type: "varchar", length: 40 })
  provider!: string;

  @Column({ name: "source_level", type: "smallint" })
  sourceLevel!: number;

  @Column({ name: "document_type", type: "varchar", length: 60 })
  documentType!: string;

  @Column({ name: "source_url", type: "text" })
  sourceUrl!: string;

  @Column({ name: "source_document", type: "text", nullable: true })
  sourceDocument?: string | null;

  @Column({ name: "content_hash", type: "varchar", length: 64 })
  contentHash!: string;

  @Column({ name: "media_type", type: "varchar", length: 120, nullable: true })
  mediaType?: string | null;

  @Column({ name: "cache_path", type: "text", nullable: true })
  cachePath?: string | null;

  @Column({ name: "raw_payload", type: "jsonb", nullable: true })
  rawPayload?: Record<string, unknown> | null;

  @Column({ name: "published_at", type: "timestamptz", nullable: true })
  publishedAt?: Date | null;

  @CreateDateColumn({ name: "retrieved_at", type: "timestamptz" })
  retrievedAt!: Date;
}
