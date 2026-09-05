import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * Rate Limit Log Entity
 *
 * Tracks API usage for rate limit management and monitoring
 * Enables quota tracking, error analysis, and usage optimization
 */
@Entity("rate_limit_logs")
@Index(["requestTimestamp"])
@Index(["apiProvider", "requestTimestamp"])
@Index(["ticker"])
export class RateLimitLog {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  // Request Details
  @Column({ name: "api_provider", type: "varchar", length: 50, default: "alpha_vantage" })
  apiProvider: string;

  @Column({ name: "endpoint", type: "varchar", length: 100, nullable: true })
  endpoint?: string;

  @Column({ name: "ticker", type: "varchar", length: 20, nullable: true })
  ticker?: string;

  // Rate Limit Tracking
  @CreateDateColumn({ name: "request_timestamp" })
  requestTimestamp: Date;

  @Column({ name: "response_status", type: "integer", nullable: true })
  responseStatus?: number;

  @Column({ name: "response_time_ms", type: "integer", nullable: true })
  responseTimeMs?: number;

  // Quota Management
  @Column({ name: "requests_this_minute", type: "integer", nullable: true })
  requestsThisMinute?: number;

  @Column({ name: "requests_today", type: "integer", nullable: true })
  requestsToday?: number;

  @Column({ name: "quota_remaining_minute", type: "integer", nullable: true })
  quotaRemainingMinute?: number;

  @Column({ name: "quota_remaining_day", type: "integer", nullable: true })
  quotaRemainingDay?: number;

  // Error Tracking
  @Column({ name: "is_error", type: "boolean", default: false })
  isError: boolean;

  @Column({ name: "error_message", type: "text", nullable: true })
  errorMessage?: string;

  @Column({ name: "retry_count", type: "integer", default: 0 })
  retryCount: number;

  // Metadata
  @Column({ name: "request_id", type: "varchar", length: 100, nullable: true })
  requestId?: string;

  @Column({ name: "user_agent", type: "varchar", length: 255, nullable: true })
  userAgent?: string;
}
