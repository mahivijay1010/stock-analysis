import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/** A normalized, still-uncomputed financial-statement fact. */
@Entity("financial_facts")
@Index(["ticker", "concept", "periodEnd", "consolidation"])
@Index(["sourceId", "rawConcept", "contextId"], { unique: true })
export class FinancialFact {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 20 })
  ticker!: string;

  @Column({ type: "varchar", length: 80 })
  concept!: string;

  @Column({ name: "raw_concept", type: "varchar", length: 255 })
  rawConcept!: string;

  @Column({ name: "context_id", type: "varchar", length: 255 })
  contextId!: string;

  @Column({ type: "numeric", precision: 30, scale: 6 })
  value!: string;

  @Column({ type: "varchar", length: 20, nullable: true })
  currency?: string | null;

  @Column({ type: "varchar", length: 80, nullable: true })
  unit?: string | null;

  @Column({ name: "period_start", type: "date", nullable: true })
  periodStart?: string | null;

  @Column({ name: "period_end", type: "date" })
  periodEnd!: string;

  @Column({ name: "period_type", type: "varchar", length: 20 })
  periodType!: string;

  @Column({ type: "varchar", length: 20, default: "UNKNOWN" })
  consolidation!: string;

  @Column({ type: "varchar", length: 24 })
  status!: string;

  @Column({ type: "varchar", length: 10 })
  confidence!: string;

  @Column({ name: "source_id", type: "uuid" })
  sourceId!: string;

  @Column({ name: "source_url", type: "text" })
  sourceUrl!: string;

  @Column({ name: "validation_notes", type: "jsonb", nullable: true })
  validationNotes?: string[] | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
