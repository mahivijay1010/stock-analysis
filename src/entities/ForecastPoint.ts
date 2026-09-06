import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  ManyToOne,
  JoinColumn,
  Unique,
} from "typeorm";
import { ForecastRun } from "./ForecastRun";

/**
 * ForecastPoint (Phase C, spec §5) — one calendar day inside a ForecastRun's
 * window. IMMUTABLE: written in the same transaction as the run, never
 * updated. Grading lives in forecast_outcomes.
 *
 * EVERY calendar day in the window gets a row (spec: day-wise output renders
 * every day). Closed days carry NULL quantiles — a carried-forward display
 * value is a UI affordance (carriesForwardFrom), never a new prediction.
 *
 * Quantiles are PRICES (₹) from the seeded bootstrap distribution of
 * cumulative returns at this point's trading-day offset from the anchor:
 * p10–p90 is the 80% interval, p05–p95 the 90% (spec: never relabel).
 * An 80% interval per date is NOT an 80% guarantee for the whole path.
 */
@Entity("forecast_points")
@Unique("UQ_forecast_points_run_date", ["runId", "targetDate"])
export class ForecastPoint {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "run_id", type: "uuid" })
  runId: string;

  @ManyToOne(() => ForecastRun, { onDelete: "CASCADE" })
  @JoinColumn({ name: "run_id" })
  run?: ForecastRun;

  /** IST calendar date this row is about. */
  @Index()
  @Column({ name: "target_date", type: "date" })
  targetDate: string;

  /**
   * Calendar state AT ISSUANCE:
   *  - "expected_session" — calendar resolved this as a (projected) session
   *  - "weekend"          — closed by rule
   *  - "expected_closed"  — known holiday/closure from the calendar
   * What actually happened is recorded on the outcome, not rewritten here.
   */
  @Column({ name: "market_state", type: "varchar", length: 20 })
  marketState: "expected_session" | "weekend" | "expected_closed";

  /** 1..N sessions after the anchor; NULL for closed days. */
  @Column({ name: "trading_day_offset", type: "int", nullable: true })
  tradingDayOffset?: number | null;

  // ── distribution (NULL on closed days — no prediction exists for them) ────
  @Column({ name: "price_p05", type: "numeric", precision: 14, scale: 4, nullable: true })
  priceP05?: string | null;

  @Column({ name: "price_p10", type: "numeric", precision: 14, scale: 4, nullable: true })
  priceP10?: string | null;

  @Column({ name: "price_p25", type: "numeric", precision: 14, scale: 4, nullable: true })
  priceP25?: string | null;

  @Column({ name: "price_p50", type: "numeric", precision: 14, scale: 4, nullable: true })
  priceP50?: string | null;

  @Column({ name: "price_p75", type: "numeric", precision: 14, scale: 4, nullable: true })
  priceP75?: string | null;

  @Column({ name: "price_p90", type: "numeric", precision: 14, scale: 4, nullable: true })
  priceP90?: string | null;

  @Column({ name: "price_p95", type: "numeric", precision: 14, scale: 4, nullable: true })
  priceP95?: string | null;

  /** Genuinely computed sample mean of the simulated prices (spec: mean only when real). */
  @Column({ name: "price_mean", type: "numeric", precision: 14, scale: 4, nullable: true })
  priceMean?: string | null;

  /** Median cumulative return vs anchor, % (convenience; derivable from p50/anchor). */
  @Column({ name: "median_return_pct", type: "numeric", precision: 9, scale: 4, nullable: true })
  medianReturnPct?: string | null;

  /** P(cumulative return > 0) at this offset — a frequency across paths, not a promise. */
  @Column({ type: "numeric", precision: 6, scale: 4, nullable: true })
  pop?: string | null;

  /** For closed days: the prior expected session whose forecast the UI may show as context. */
  @Column({ name: "carries_forward_from", type: "date", nullable: true })
  carriesForwardFrom?: string | null;
}
