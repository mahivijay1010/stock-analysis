import { Entity, PrimaryGeneratedColumn, Column, Index } from "typeorm";

/**
 * Ensemble Weight Entity (V7 Module A3)
 *
 * Live regret-updated model weights per (ticker, horizon): after each evening
 * verification, scripts/updateEnsemble.ts multiplies each model's weight by
 * exp(−η·brier_m) on the newly matured outcome (η = 2) and renormalizes —
 * a light FTRL-style online update. The selector prefers these weights when
 * they are fresher than the stored backtest stats.
 *
 * One special meta row (ticker = "__DRIFT__", horizonDays = 0) stores the last
 * run's drift counters ({ switches, updatedPairs }) for /api/calibration's
 * modelDrift block. All payload columns are nullable — a partially-written row
 * can never crash a reader.
 */
@Entity("ensemble_weights")
@Index(["ticker", "horizonDays"], { unique: true })
@Index(["ticker"])
export class EnsembleWeight {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "varchar", length: 20 })
  ticker: string;

  @Column({ name: "horizon_days", type: "int" })
  horizonDays: number; // 1 | 3 | 7 | 15 | 30 (0 for the __DRIFT__ meta row)

  /** Model → weight (sums to ~1). For the meta row: drift counters. */
  @Column({ type: "jsonb", nullable: true })
  weights?: Record<string, number> | null;

  @Column({ name: "updated_at", type: "timestamptz", nullable: true })
  updatedAt?: Date | null;
}
