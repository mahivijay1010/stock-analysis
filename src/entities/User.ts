import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
} from "typeorm";
import { Alert } from "./Alert";
import { Watchlist } from "./Watchlist";
import { Portfolio } from "./Portfolio";

/**
 * User Entity
 * Represents a registered user in the system
 */
@Entity("users")
export class User {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ unique: true })
  @Index()
  email!: string;

  @Column()
  password!: string; // Hashed password

  @Column()
  firstName!: string;

  @Column()
  lastName!: string;

  @Column({ nullable: true })
  phoneNumber?: string;

  @Column({ default: "user" })
  role!: string; // user, premium, admin

  @Column({ default: false })
  emailVerified!: boolean;

  @Column({ nullable: true })
  emailVerificationToken?: string;

  @Column({ nullable: true })
  passwordResetToken?: string;

  @Column({ nullable: true })
  passwordResetExpires?: Date;

  @Column({ nullable: true })
  profilePicture?: string;

  @Column({ default: "free" })
  subscriptionPlan!: string; // free, basic, premium, enterprise

  @Column({ nullable: true })
  subscriptionExpires?: Date;

  @Column({ default: true })
  isActive!: boolean;

  @Column({ nullable: true })
  lastLoginAt?: Date;

  @Column({ type: "jsonb", nullable: true })
  preferences?: {
    theme?: "light" | "dark";
    currency?: string;
    notifications?: {
      email?: boolean;
      push?: boolean;
      sms?: boolean;
    };
    riskTolerance?: "conservative" | "moderate" | "aggressive";
  };

  // OAuth fields
  @Column({ nullable: true })
  googleId?: string;

  @Column({ nullable: true })
  githubId?: string;

  @Column({ type: "jsonb", nullable: true })
  oauthData?: Record<string, any>;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  // Relations
  @OneToMany(() => Portfolio, (portfolio) => portfolio.user)
  portfolios!: Portfolio[];

  @OneToMany(() => Watchlist, (watchlist) => watchlist.user)
  watchlists!: Watchlist[];

  @OneToMany(() => Alert, (alert) => alert.user)
  alerts!: Alert[];
}
