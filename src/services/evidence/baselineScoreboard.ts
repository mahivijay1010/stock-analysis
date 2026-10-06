/**
 * Evidence-tab "vs naive baselines" report: the daily model's hit rate beside
 * the constants that score on the same rows, its cross-sectional (stock-
 * picking) hit rate, the ACTIVE direction policy per horizon, and the last
 * nightly challenger decision. Definitions live in research/dailySkill.ts.
 */
import { AppDataSource } from "../../config/database";
import { HorizonScoreboard, scoreboard, scoreboardHeadline } from "../research/dailySkill";
import { DAILY_PROMOTION_RULE, PREREGISTERED_ON, loadGraded } from "../research/dailyChallengerRun";

export interface DirectionPolicyRow {
  horizonDays: number;
  version: string;
  policy: string;
  promotedAt: string | null;
  reason: string;
}

export interface BaselineReport {
  version: "baseline-scoreboard-v1";
  headline: string;
  horizons: HorizonScoreboard[];
  policies: DirectionPolicyRow[];
  challenger: {
    preregisteredOn: string;
    rule: typeof DAILY_PROMOTION_RULE;
    lastRunAt: string | null;
    lastDecision: string | null;
  };
  definition: string;
}

export async function baselineReport(): Promise<BaselineReport> {
  const rows = await loadGraded();
  const horizons = scoreboard(rows);

  let policies: DirectionPolicyRow[] = [];
  try {
    const p: Array<{ horizon_days: number; version: string; policy: string; promoted_at: Date | null; reason: string }> = await AppDataSource.query(
      `SELECT horizon_days, version, policy, promoted_at, reason FROM daily_direction_policy WHERE state = 'ACTIVE' ORDER BY horizon_days`
    );
    policies = p.map((r) => ({
      horizonDays: Number(r.horizon_days),
      version: r.version,
      policy: r.policy,
      promotedAt: r.promoted_at ? new Date(r.promoted_at).toISOString() : null,
      reason: r.reason,
    }));
  } catch {
    // table absent on a backend that has not run migration 1790200000000 — report without it
  }

  const [last]: Array<{ finished_at: Date | null; notes: string | null }> = await AppDataSource.query(
    `SELECT finished_at, notes FROM experiment_runs WHERE name = 'daily-challenger' ORDER BY started_at DESC LIMIT 1`
  );

  return {
    version: "baseline-scoreboard-v1",
    headline:
      scoreboardHeadline(horizons) ??
      "Too few graded daily predictions to compare against a constant guess yet.",
    horizons,
    policies,
    challenger: {
      preregisteredOn: PREREGISTERED_ON,
      rule: DAILY_PROMOTION_RULE,
      lastRunAt: last?.finished_at ? new Date(last.finished_at).toISOString() : null,
      lastDecision: last?.notes ?? null,
    },
    definition:
      "Hit = shown direction equals realised direction (stricter than the ledger's grade, which credits near-flat moves). " +
      "Cross-sectional = UP picks beat that day's median stock / DOWN picks trail it; any constant scores 50% by construction. " +
      "'Always-UP/DOWN' are scored on the same rows; the better of the two needs hindsight and is an upper bound, not a model. " +
      "Multi-day horizons logged daily overlap, so prediction DAYS, not rows, are the honest sample size.",
  };
}
