import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from "typeorm";
import { Portfolio } from "./Portfolio";

/**
 * Position Entity
 * Represents an individual stock position in a portfolio
 */
@Entity("positions")
export class Position {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column()
  @Index()
  portfolioId!: string;

  @Column()
  @Index()
  ticker!: string;

  @Column()
  companyName!: string;

  @Column({ type: "decimal", precision: 15, scale: 6 })
  quantity!: number;

  @Column({ type: "decimal", precision: 15, scale: 2 })
  averageCost!: number; // Average purchase price per share

  @Column({ type: "decimal", precision: 15, scale: 2 })
  currentPrice!: number;

  @Column({ type: "decimal", precision: 15, scale: 2 })
  totalCost!: number; // quantity * averageCost

  @Column({ type: "decimal", precision: 15, scale: 2 })
  currentValue!: number; // quantity * currentPrice

  @Column({ type: "decimal", precision: 15, scale: 2 })
  unrealizedPL!: number; // currentValue - totalCost

  @Column({ type: "decimal", precision: 10, scale: 2 })
  unrealizedPLPercent!: number; // (unrealizedPL / totalCost) * 100

  @Column({ type: "decimal", precision: 10, scale: 2, default: 0 })
  dayChangePercent!: number;

  @Column({ type: "decimal", precision: 15, scale: 2, default: 0 })
  dayChangeDollar!: number;

  @Column({ type: "decimal", precision: 10, scale: 2, default: 0 })
  allocationPercent!: number; // % of portfolio

  @Column({ nullable: true })
  sector?: string;

  @Column({ nullable: true })
  industry?: string;

  @Column({ nullable: true })
  assetType?: string; // stock, etf, crypto, forex

  @Column({ default: "open" })
  status!: string; // open, closed

  @Column({ type: "jsonb", nullable: true })
  transactions?: Array<{
    date: string;
    type: "buy" | "sell";
    quantity: number;
    price: number;
    commission: number;
    total: number;
  }>;

  @Column({ nullable: true })
  @Index()
  openedAt?: Date;

  @Column({ nullable: true })
  closedAt?: Date;

  @Column({ type: "decimal", precision: 15, scale: 2, nullable: true })
  realizedPL?: number; // For closed positions

  @Column({ type: "decimal", precision: 10, scale: 2, nullable: true })
  realizedPLPercent?: number;

  @Column({ nullable: true })
  notes?: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  // Relations
  @ManyToOne(() => Portfolio, (portfolio) => portfolio.positions)
  @JoinColumn({ name: "portfolioId" })
  portfolio!: Portfolio;
}
