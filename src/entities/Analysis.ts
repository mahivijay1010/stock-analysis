import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
} from "typeorm";
import { Stock } from "./Stock";

/**
 * Analysis Entity
 * Stores the results of stock analysis including recommendation and risk assessment
 * Each analysis is linked to a specific stock and represents a snapshot in time
 */
@Entity("analysis")
export class Analysis {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "stock_id" })
  stockId: string;

  @ManyToOne(() => Stock, (stock) => stock.analyses, { onDelete: "CASCADE" })
  @JoinColumn({ name: "stock_id" })
  stock: Stock;

  @Column({ type: "text" })
  summary: string;

  @Column({
    type: "enum",
    enum: ["BUY", "HOLD", "SELL", "AVOID"],
    comment: "Investment recommendation based on technical analysis",
  })
  recommendation: "BUY" | "HOLD" | "SELL" | "AVOID";

  @Column({
    type: "enum",
    enum: ["Low", "Medium", "High"],
    name: "risk_level",
    comment: "Risk assessment based on volatility and market conditions",
  })
  riskLevel: "Low" | "Medium" | "High";

  // Additional metrics stored for analysis
  @Column({ type: "decimal", precision: 10, scale: 2, nullable: true, name: "current_price" })
  currentPrice: number;

  @Column({ type: "decimal", precision: 10, scale: 2, nullable: true, name: "pe_ratio" })
  peRatio: number;

  @Column({ type: "decimal", precision: 10, scale: 2, nullable: true })
  rsi: number;

  // Composite quant score 0..100 (nullable — added at rebuild, old rows have none)
  @Column({ type: "decimal", precision: 6, scale: 2, nullable: true })
  score?: number;

  @Column({
    type: "decimal",
    precision: 10,
    scale: 2,
    nullable: true,
    name: "price_change_percent",
  })
  priceChangePercent: number;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
