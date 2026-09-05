import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * Cron Execution Log Entity
 *
 * Tracks scheduled job execution for monitoring and debugging
 * Enables performance analysis and failure detection
 */
@Entity("cron_execution_logs")
@Index(["jobName", "executionStart"])
@Index(["status"])
export class CronExecutionLog {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "job_name", type: "varchar", length: 100 })
  jobName: string;

  @Column({ name: "execution_start", type: "timestamp" })
  executionStart: Date;

  @Column({ name: "execution_end", type: "timestamp", nullable: true })
  executionEnd?: Date;

  @Column({ name: "execution_duration_ms", type: "integer", nullable: true })
  executionDurationMs?: number;

  @Column({ name: "status", type: "varchar", length: 20, nullable: true })
  status?: string; // 'running', 'completed', 'failed', 'partial'

  @Column({ name: "stocks_processed", type: "integer", default: 0 })
  stocksProcessed: number;

  @Column({ name: "stocks_failed", type: "integer", default: 0 })
  stocksFailed: number;

  @Column({ name: "api_calls_made", type: "integer", default: 0 })
  apiCallsMade: number;

  @Column({ name: "error_summary", type: "text", nullable: true })
  errorSummary?: string;

  @Column({ name: "success_rate", type: "decimal", precision: 5, scale: 2, nullable: true })
  successRate?: number;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
