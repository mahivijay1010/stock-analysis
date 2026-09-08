import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * AiReview (risk-spec "AI API DESIGN") — append-only audit trail of every
 * committee call: prompt version, model, input hash, full response, latency,
 * token usage, timestamps. No personal user data is ever sent or stored
 * beyond explicitly-supplied position context.
 */
@Entity("ai_reviews")
export class AiReview {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ type: "varchar", length: 20 })
  ticker: string;

  @Column({ name: "prompt_version", type: "varchar", length: 40 })
  promptVersion: string;

  @Column({ name: "model_name", type: "varchar", length: 60 })
  modelName: string;

  @Column({ type: "varchar", length: 20 })
  provider: string;

  @Column({ name: "input_hash", type: "varchar", length: 64 })
  inputHash: string;

  /** Which AI role produced this row (risk_committee | fundamental_analyst | event_analyst | technical_analyst | forecast_critic | counterfactual | extraction). */
  @Index()
  @Column({ type: "varchar", length: 40, default: "risk_committee" })
  role: string;

  /** Provider response id (OpenAI Responses API) for audit/tracing. */
  @Column({ name: "response_id", type: "text", nullable: true })
  responseId?: string | null;

  @Column({ name: "schema_version", type: "varchar", length: 60, nullable: true })
  schemaVersion?: string | null;

  /** valid | invalid — invalid rows keep the failure reason in meta and NO response payload is trusted. */
  @Column({ name: "validation_result", type: "varchar", length: 12, nullable: true })
  validationResult?: string | null;

  /** modelSnapshot, requestId, toolCalls, failure reasons, disagreement inputs … */
  @Column({ type: "jsonb", nullable: true })
  meta?: Record<string, unknown> | null;

  /** The exact structured context sent (deterministic outputs only). */
  @Column({ name: "request_context", type: "jsonb" })
  requestContext: Record<string, unknown>;

  /** The validated (and possibly clamped) review. */
  @Column({ type: "jsonb" })
  response: Record<string, unknown>;

  @Column({ type: "boolean", default: false })
  clamped: boolean;

  @Column({ name: "clamp_notes", type: "jsonb", nullable: true })
  clampNotes?: string[] | null;

  @Column({ name: "latency_ms", type: "int" })
  latencyMs: number;

  @Column({ name: "tokens_in", type: "int", nullable: true })
  tokensIn?: number | null;

  @Column({ name: "tokens_out", type: "int", nullable: true })
  tokensOut?: number | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
