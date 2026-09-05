import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/** Evidence for order book, capex, TAM, moat, management and macro interpretation. */
@Entity("intelligence_evidence")
@Index(["ticker", "category", "asOfDate"])
export class IntelligenceEvidence {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 20, nullable: true })
  ticker?: string | null;

  @Column({ type: "varchar", length: 60 })
  category!: string;

  @Column({ type: "varchar", length: 120, nullable: true })
  label?: string | null;

  @Column({ type: "numeric", precision: 30, scale: 6, nullable: true })
  value?: string | null;

  @Column({ type: "varchar", length: 20, nullable: true })
  currency?: string | null;

  @Column({ type: "text" })
  excerpt!: string;

  @Column({ name: "as_of_date", type: "date", nullable: true })
  asOfDate?: string | null;

  @Column({ name: "source_id", type: "uuid", nullable: true })
  sourceId?: string | null;

  @Column({ name: "source_url", type: "text" })
  sourceUrl!: string;

  @Column({ type: "varchar", length: 24 })
  status!: string;

  @Column({ type: "varchar", length: 10 })
  confidence!: string;

  @Column({ type: "jsonb", default: {} })
  metadata!: Record<string, unknown>;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
