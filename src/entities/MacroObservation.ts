import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity("macro_observations")
@Index(["indicator", "period", "sourceUrl"], { unique: true })
export class MacroObservation {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 100 })
  indicator!: string;

  @Column({ type: "numeric", precision: 30, scale: 8 })
  value!: string;

  @Column({ type: "varchar", length: 30, nullable: true })
  unit?: string | null;

  @Column({ type: "varchar", length: 40 })
  period!: string;

  @Column({ type: "varchar", length: 40 })
  provider!: string;

  @Column({ name: "source_url", type: "text" })
  sourceUrl!: string;

  @Column({ name: "publication_date", type: "date", nullable: true })
  publicationDate?: string | null;

  @Column({ type: "varchar", length: 24, default: "RAW" })
  status!: string;

  @Column({ type: "varchar", length: 10, default: "HIGH" })
  confidence!: string;

  @Column({ type: "jsonb", default: {} })
  metadata!: Record<string, unknown>;

  @CreateDateColumn({ name: "retrieved_at", type: "timestamptz" })
  retrievedAt!: Date;
}
