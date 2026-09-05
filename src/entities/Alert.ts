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
 * Alert Entity
 * Represents price alerts and notifications for stocks
 */
@Entity("alerts")
export class Alert {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column()
  @Index()
  userId!: string;

  @Column()
  @Index()
  ticker!: string;

  @Column()
  companyName!: string;

  @Column()
  alertType!: string; // price_above, price_below, percent_change, volume_spike, etc.

  @Column({ type: "jsonb" })
  condition!: {
    type: string;
    value: number;
    operator?: ">" | "<" | "=" | ">=" | "<=";
    timeframe?: string;
  };

  @Column({ default: false })
  triggered!: boolean;

  @Column({ nullable: true })
  @Index()
  triggeredAt?: Date;

  @Column({ type: "decimal", precision: 15, scale: 2, nullable: true })
  triggerPrice?: number;

  @Column({ default: true })
  isActive!: boolean;

  @Column({ default: false })
  isRecurring!: boolean;

  @Column({ type: "jsonb", default: { email: true, push: false, sms: false } })
  notificationChannels!: {
    email: boolean;
    push: boolean;
    sms: boolean;
  };

  @Column({ nullable: true })
  expiresAt?: Date;

  @Column({ nullable: true })
  message?: string; // Custom alert message

  @Column({ type: "int", default: 0 })
  triggerCount!: number;

  @Column({ nullable: true })
  lastCheckedAt?: Date;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  // Relations
  @ManyToOne(() => User, (user) => user.alerts)
  @JoinColumn({ name: "userId" })
  user!: User;
}
