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
import { User } from "./User";

/**
 * Watchlist Entity
 * Represents a user's watchlist of stocks to monitor
 */
@Entity("watchlists")
export class Watchlist {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column()
  @Index()
  userId!: string;

  @Column()
  name!: string;

  @Column({ nullable: true })
  description?: string;

  @Column({ type: "jsonb", default: [] })
  tickers!: Array<{
    ticker: string;
    companyName: string;
    addedAt: string;
    notes?: string;
    targetPrice?: number;
    alertEnabled?: boolean;
  }>;

  @Column({ default: false })
  isDefault!: boolean;

  @Column({ default: true })
  isPublic!: boolean;

  @Column({ type: "int", default: 0 })
  sortOrder!: number;

  @Column({ nullable: true })
  color?: string; // For UI organization

  @Column({ nullable: true })
  icon?: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  // Relations
  @ManyToOne(() => User, (user) => user.watchlists)
  @JoinColumn({ name: "userId" })
  user!: User;
}
