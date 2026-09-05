import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
} from "typeorm";
import { User } from "./User";
import { Position } from "./Position";

/**
 * Portfolio Entity
 * Represents a user's investment portfolio
 */
@Entity("portfolios")
export class Portfolio {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column()
  @Index()
  userId!: string;

  @Column()
  name!: string;

  @Column({ nullable: true })
  description?: string;

  @Column({ type: "decimal", precision: 15, scale: 2, default: 0 })
  cashBalance!: number;

  @Column({ type: "decimal", precision: 15, scale: 2, default: 0 })
  totalValue!: number; // Cash + positions value

  @Column({ type: "decimal", precision: 15, scale: 2, default: 0 })
  totalCost!: number; // Total amount invested

  @Column({ type: "decimal", precision: 10, scale: 2, default: 0 })
  totalReturnPercent!: number; // (totalValue - totalCost) / totalCost * 100

  @Column({ type: "decimal", precision: 15, scale: 2, default: 0 })
  totalReturnDollar!: number; // totalValue - totalCost

  @Column({ type: "decimal", precision: 10, scale: 2, default: 0 })
  dayChangePercent!: number;

  @Column({ type: "decimal", precision: 15, scale: 2, default: 0 })
  dayChangeDollar!: number;

  @Column({ default: "USD" })
  currency!: string;

  @Column({ default: true })
  isActive!: boolean;

  @Column({ default: false })
  isDefault!: boolean;

  @Column({ type: "jsonb", nullable: true })
  allocation?: {
    stocks?: number;
    bonds?: number;
    cash?: number;
    crypto?: number;
    other?: number;
  };

  @Column({ type: "jsonb", nullable: true })
  sectorAllocation?: Record<string, number>;

  @Column({ type: "jsonb", nullable: true })
  performanceHistory?: Array<{
    date: string;
    value: number;
    return: number;
  }>;

  @Column({ type: "jsonb", nullable: true })
  riskMetrics?: {
    beta?: number;
    sharpeRatio?: number;
    volatility?: number;
    maxDrawdown?: number;
  };

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  // Relations
  @ManyToOne(() => User, (user) => user.portfolios)
  @JoinColumn({ name: "userId" })
  user!: User;

  @OneToMany(() => Position, (position) => position.portfolio)
  positions!: Position[];
}
