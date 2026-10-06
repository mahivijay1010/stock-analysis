/**
 * Nightly daily-horizon challenger — the learning half of the 1/3/7/15/30-day
 * loop, built on the same discipline as intradayCalibrationRun.ts.
 *
 * Every night, the ACTIVE direction policy for each horizon is scored beside a
 * FIXED set of challengers on graded prediction_logs rows, and a challenger
 * replaces it only under the rule below, written BEFORE any prospective
 * result existed. The core (`evaluateHorizon`, `decideHorizon`) is pure and
 * unit-tested so the rule cannot drift.
 *
 * THE RULE, pre-registered 2026-10-01 (before any row it will judge existed):
 *
 *   EVIDENCE WINDOW. Only rows with prediction_date ≥ PREREGISTERED_ON count
 *   toward promotion. The challengers carry no fitted parameters, but the
 *   REVERSAL hypothesis was chosen after looking at 2026-09-17..29 (UP picks
 *   underperformed the cohort median by 0.26% at 1d), so those days cannot
 *   also be the test. They are scored and reported as IN-SAMPLE, never used.
 *
 *   NO-HINDSIGHT BASELINE. For each prospective row, the "trailing majority"
 *   constant predicts the majority realised direction among same-horizon
 *   rows that had MATURED (target_date < this row's prediction_date). This is
 *   what a naive trader could actually have known. The hindsight-best
 *   constant is reported beside it as an upper bound, not as a hurdle.
 *
 *   A challenger is PROMOTED for a horizon only if, on the prospective window:
 *     (a) calls ≥ 500 AND distinct prediction dates ≥ 10,
 *     (b) cross-sectional hit rate > 50.0% (it picks stocks, not the tape),
 *     (c) cross-sectional hit beats the ACTIVE policy's by ≥ 1.5 pp,
 *     (d) absolute hit rate beats the trailing-majority constant,
 *     (e) absolute hit rate is not below the ACTIVE policy's.
 *   Among qualifiers, the highest cross-sectional hit wins.
 *
 *   NULL (no directional call) is promoted when nothing qualifies AND the
 *   active policy, with (a) satisfied, fails BOTH skill tests — absolute hit
 *   ≤ trailing-majority AND cross-sectional hit ≤ 50%. A call that loses to a
 *   constant and to a coin is worse than no call. When NULL is active, it is
 *   treated as scoring exactly the trailing-majority (absolute) and 50%
 *   (cross-sectional), so a challenger must clear 51.5% to replace it.
 *
 * WHAT THIS DOES NOT DO. It never rewrites prediction_logs — quant-v1 keeps
 * logging its raw call, which is the evidence every policy is a transform of.
 * And it says nothing about economics: a directional edge smaller than
 * round-trip cost (14–21 bps) is still not a trade.
 */

import { createHash } from "crypto";
import { AppDataSource } from "../../config/database";
import {
  Direction,
  GradedPrediction,
  POLICY_DESCRIPTIONS,
  PolicyKey,
  PolicyScore,
  cohortStats,
  naiveBaselines,
  scorePolicy,
  NaiveBaselines,
} from "./dailySkill";

export const DAILY_CHALLENGER_VERSION = "daily-challenger-v1";
export const PREREGISTERED_ON = "2026-10-01";
export const DAILY_HORIZONS = [1, 3, 7, 15, 30] as const;

/** Pre-registered thresholds. Changing any of these is a methodology change and must be a visible commit. */
export const DAILY_PROMOTION_RULE = {
  minCalls: 500,
  minDays: 10,
  minCrossSectionalPct: 50.0,
  minCrossSectionalLiftPp: 1.5,
} as const;

export const CHALLENGERS: PolicyKey[] = ["incumbent", "reversal", "market-neutral", "null"];

export interface DatedPrediction extends GradedPrediction {
  /** The date the outcome became KNOWN (prediction_logs.outcome_date — trading-day horizon, not the calendar target_date). */
  targetDate: string; // YYYY-MM-DD
}

/**
 * Trailing-majority constant: for each row, the majority realised direction
 * among rows that had matured before its prediction date. Rows with no
 * matured history get no baseline call. PURE.
 */
export function trailingMajorityHitPct(rows: DatedPrediction[], history: DatedPrediction[]): { hitPct: number | null; calls: number } {
  const matured = [...history].sort((a, b) => a.targetDate.localeCompare(b.targetDate));
  const sorted = [...rows].sort((a, b) => a.predictionDate.localeCompare(b.predictionDate));
  let i = 0;
  let up = 0;
  let down = 0;
  let calls = 0;
  let hits = 0;
  for (const r of sorted) {
    while (i < matured.length && matured[i].targetDate < r.predictionDate) {
      if (matured[i].actualDirection === "UP") up++;
      else down++;
      i++;
    }
    if (up + down === 0) continue;
    const d: Direction = up > down ? "UP" : "DOWN";
    calls++;
    if (d === r.actualDirection) hits++;
  }
  return { hitPct: calls > 0 ? (hits / calls) * 100 : null, calls };
}

export interface ChallengerEval {
  policy: PolicyKey;
  describe: string;
  inSample: PolicyScore;
  prospective: PolicyScore;
  qualifies: boolean;
  why: string;
}

export interface HorizonEvaluation {
  horizonDays: number;
  active: PolicyKey;
  inSampleN: number;
  prospectiveN: number;
  trailingMajority: { hitPct: number | null; calls: number };
  hindsight: NaiveBaselines;
  /** What the ACTIVE policy is held to (NULL → trailing-majority / 50). */
  activeBar: { hitPct: number | null; crossSectionalPct: number | null };
  challengers: ChallengerEval[];
}

/** Score every challenger for one horizon, split at the registration date. PURE. */
export function evaluateHorizon(rows: DatedPrediction[], horizonDays: number, active: PolicyKey, registeredOn = PREREGISTERED_ON): HorizonEvaluation {
  const hr = rows.filter((r) => r.horizonDays === horizonDays);
  const stats = cohortStats(hr);
  const pre = hr.filter((r) => r.predictionDate < registeredOn);
  const post = hr.filter((r) => r.predictionDate >= registeredOn);
  const trailing = trailingMajorityHitPct(post, hr);

  const scores = new Map<PolicyKey, { inSample: PolicyScore; prospective: PolicyScore }>();
  for (const p of CHALLENGERS) scores.set(p, { inSample: scorePolicy(p, pre, stats), prospective: scorePolicy(p, post, stats) });

  const activeScore = scores.get(active)!.prospective;
  const activeBar =
    active === "null"
      ? { hitPct: trailing.hitPct, crossSectionalPct: 50 }
      : { hitPct: activeScore.hitRatePct, crossSectionalPct: activeScore.crossSectionalHitPct };

  const R = DAILY_PROMOTION_RULE;
  const challengers = CHALLENGERS.map((p): ChallengerEval => {
    const s = scores.get(p)!;
    const pr = s.prospective;
    const reasons: string[] = [];
    if (p === active) reasons.push("is the active policy");
    else if (p === "null") reasons.push("null: cannot qualify on direction; promoted only if the active policy fails both skill tests");
    else {
      if (pr.calls < R.minCalls) reasons.push(`prospective calls ${pr.calls} < ${R.minCalls}`);
      if (pr.days < R.minDays) reasons.push(`prospective days ${pr.days} < ${R.minDays}`);
      const xs = pr.crossSectionalHitPct;
      if (xs == null || xs <= R.minCrossSectionalPct) reasons.push(`cross-sectional ${xs?.toFixed(2) ?? "n/a"}% ≤ ${R.minCrossSectionalPct}%`);
      const lift = (xs ?? 0) - (activeBar.crossSectionalPct ?? 0);
      if (xs == null || lift < R.minCrossSectionalLiftPp) reasons.push(`cross-sectional lift ${lift.toFixed(2)} pp < ${R.minCrossSectionalLiftPp}`);
      if (pr.hitRatePct == null || trailing.hitPct == null || pr.hitRatePct <= trailing.hitPct)
        reasons.push(`absolute ${pr.hitRatePct?.toFixed(2) ?? "n/a"}% not above trailing-majority ${trailing.hitPct?.toFixed(2) ?? "n/a"}%`);
      if (pr.hitRatePct == null || (activeBar.hitPct != null && pr.hitRatePct < activeBar.hitPct))
        reasons.push(`absolute ${pr.hitRatePct?.toFixed(2) ?? "n/a"}% below active ${activeBar.hitPct?.toFixed(2) ?? "n/a"}%`);
    }
    return {
      policy: p,
      describe: POLICY_DESCRIPTIONS[p],
      inSample: s.inSample,
      prospective: pr,
      qualifies: reasons.length === 0,
      why: reasons.length ? reasons.join("; ") : "clears every pre-registered threshold on the prospective window",
    };
  });

  return {
    horizonDays,
    active,
    inSampleN: pre.length,
    prospectiveN: post.length,
    trailingMajority: trailing,
    hindsight: naiveBaselines(post),
    activeBar,
    challengers,
  };
}

export interface HorizonDecision {
  promote: boolean;
  winner: PolicyKey | null;
  reason: string;
}

/** Apply the pre-registered rule. PURE. */
export function decideHorizon(ev: HorizonEvaluation): HorizonDecision {
  const R = DAILY_PROMOTION_RULE;
  const f = (x: number | null | undefined) => (x == null ? "n/a" : `${x.toFixed(2)}%`);
  const qualifying = ev.challengers.filter((c) => c.qualifies);
  if (qualifying.length > 0) {
    const w = qualifying.sort((a, b) => (b.prospective.crossSectionalHitPct ?? 0) - (a.prospective.crossSectionalHitPct ?? 0))[0];
    return {
      promote: true,
      winner: w.policy,
      reason:
        `${ev.horizonDays}d: ${w.policy} (${w.describe}) beat active ${ev.active} prospectively — cross-sectional ${f(w.prospective.crossSectionalHitPct)} vs ${f(ev.activeBar.crossSectionalPct)}, ` +
        `absolute ${f(w.prospective.hitRatePct)} vs trailing-majority ${f(ev.trailingMajority.hitPct)}, on ${w.prospective.calls} calls over ${w.prospective.days} days. ` +
        `Multi-day windows overlap; this is a governed policy change, re-tested nightly — not proof of skill.`,
    };
  }
  const act = ev.challengers.find((c) => c.policy === ev.active)!.prospective;
  const enough = act.calls >= R.minCalls && act.days >= R.minDays;
  if (ev.active !== "null" && enough) {
    const losesToConstant = act.hitRatePct != null && ev.trailingMajority.hitPct != null && act.hitRatePct <= ev.trailingMajority.hitPct;
    const losesToCoin = act.crossSectionalHitPct != null && act.crossSectionalHitPct <= 50;
    if (losesToConstant && losesToCoin) {
      return {
        promote: true,
        winner: "null",
        reason:
          `${ev.horizonDays}d: no challenger qualified and active ${ev.active} failed both skill tests prospectively — absolute ${f(act.hitRatePct)} ≤ trailing-majority ${f(ev.trailingMajority.hitPct)}, ` +
          `cross-sectional ${f(act.crossSectionalHitPct)} ≤ 50% (${act.calls} calls, ${act.days} days). Withholding direction: no call beats a call that loses to a constant and a coin.`,
      };
    }
  }
  if (!enough) {
    return {
      promote: false,
      winner: null,
      reason: `${ev.horizonDays}d: prospective window has ${act.calls} calls over ${act.days} days (need ≥${R.minCalls} and ≥${R.minDays} since ${PREREGISTERED_ON}); nothing can change yet.`,
    };
  }
  return { promote: false, winner: null, reason: `${ev.horizonDays}d: no challenger cleared the pre-registered rule; ${ev.active} retained.` };
}

export interface DailyChallengerSummary {
  experimentRunId: string | null;
  perHorizon: Array<{ horizonDays: number; active: PolicyKey; prospectiveN: number; decision: HorizonDecision }>;
  promoted: Array<{ horizonDays: number; version: string; policy: PolicyKey }>;
  note: string;
}

interface DbRow {
  ticker: string;
  prediction_date: string;
  target_date: string;
  horizon_days: number;
  predicted_direction: string | null;
  expected_return: string | number;
  actual_return: string | number;
  actual_direction: string;
}

/** Graded quant-v1 rows, with dates as YYYY-MM-DD strings. */
export async function loadGraded(): Promise<DatedPrediction[]> {
  const rows: DbRow[] = await AppDataSource.query(
    `SELECT ticker, to_char(prediction_date,'YYYY-MM-DD') prediction_date, to_char(outcome_date,'YYYY-MM-DD') target_date,
            horizon_days, predicted_direction, expected_return, actual_return, actual_direction
       FROM prediction_logs
      WHERE model_version = 'quant-v1' AND prediction_correct IS NOT NULL
        AND actual_return IS NOT NULL AND actual_direction IN ('UP','DOWN') AND expected_return IS NOT NULL AND outcome_date IS NOT NULL`
  );
  return rows.map((r) => ({
    ticker: r.ticker,
    predictionDate: r.prediction_date,
    targetDate: r.target_date,
    horizonDays: Number(r.horizon_days),
    predictedDirection: r.predicted_direction === "UP" || r.predicted_direction === "DOWN" ? r.predicted_direction : null,
    expectedReturnPct: Number(r.expected_return),
    actualReturnPct: Number(r.actual_return),
    actualDirection: r.actual_direction as Direction,
  }));
}

async function activePolicies(): Promise<Map<number, { version: string; policy: PolicyKey }>> {
  const rows: Array<{ horizon_days: number; version: string; policy: PolicyKey }> = await AppDataSource.query(
    `SELECT horizon_days, version, policy FROM daily_direction_policy WHERE state = 'ACTIVE'`
  );
  return new Map(rows.map((r) => [Number(r.horizon_days), { version: r.version, policy: r.policy }]));
}

/**
 * The job. Evaluates every horizon, records one experiment run and one
 * learning lesson, and promotes per horizon under the rule above.
 */
export async function runDailyChallenger(opts: { dryRun?: boolean; note?: string } = {}): Promise<DailyChallengerSummary> {
  const startedAt = new Date();
  const rows = await loadGraded();
  const active = await activePolicies();

  const evals = DAILY_HORIZONS.map((h) => evaluateHorizon(rows, h, active.get(h)?.policy ?? "incumbent"));
  const decisions = evals.map((e) => ({ ev: e, decision: decideHorizon(e) }));

  const manifest = evals.map((e) => `${e.horizonDays}|${e.inSampleN}|${e.prospectiveN}`).join(",");
  const datasetHash = createHash("sha256").update(`${DAILY_CHALLENGER_VERSION}|${manifest}`).digest("hex");
  const metrics = {
    version: DAILY_CHALLENGER_VERSION,
    rule: DAILY_PROMOTION_RULE,
    preregisteredOn: PREREGISTERED_ON,
    evaluations: evals,
    decisions: decisions.map((d) => ({ horizonDays: d.ev.horizonDays, ...d.decision })),
  };

  let experimentRunId: string | null = null;
  if (!opts.dryRun) {
    const [run]: Array<{ id: string }> = await AppDataSource.query(
      `INSERT INTO experiment_runs
         (name, kind, model_version, config, splits, dataset_manifest, dataset_hash, metrics, baselines, segments_used, used_final_test, status, notes, started_at, finished_at)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10::jsonb,false,'completed',$11,$12,now())
       RETURNING id`,
      [
        "daily-challenger",
        "challenger",
        "quant-v1",
        JSON.stringify({ challengers: CHALLENGERS, rule: DAILY_PROMOTION_RULE, horizons: DAILY_HORIZONS }),
        JSON.stringify({ method: `in-sample = prediction_date < ${PREREGISTERED_ON} (reported only); prospective = on/after (judged)` }),
        JSON.stringify({ source: "prediction_logs (quant-v1, graded)", perHorizon: evals.map((e) => ({ h: e.horizonDays, inSample: e.inSampleN, prospective: e.prospectiveN })) }),
        datasetHash,
        JSON.stringify(metrics),
        JSON.stringify({ trailingMajority: "no-hindsight constant (hurdle)", hindsightBest: "upper bound (reported only)", crossSectional: "constant = 50% by construction" }),
        JSON.stringify(["in-sample(<" + PREREGISTERED_ON + ")", "prospective(≥" + PREREGISTERED_ON + ")"]),
        `${opts.note ? opts.note + " — " : ""}Daily challenger evaluation. ` + decisions.map((d) => d.decision.reason).join(" | "),
        startedAt,
      ]
    );
    experimentRunId = run?.id ?? null;
  }

  const promoted: DailyChallengerSummary["promoted"] = [];
  if (!opts.dryRun) {
    const day = startedAt.toISOString().slice(0, 10).replace(/-/g, "");
    for (const { ev, decision } of decisions) {
      if (!decision.promote || !decision.winner || decision.winner === ev.active) continue;
      const version = `dp-${ev.horizonDays}d-${day}-${decision.winner}`;
      const winner = ev.challengers.find((c) => c.policy === decision.winner)!;
      await AppDataSource.transaction(async (m) => {
        await m.query(`SET LOCAL stocksense.allow_snapshot_mutation = 'on'`);
        const [inc]: Array<{ version: string }> = await m.query(
          `SELECT version FROM daily_direction_policy WHERE state = 'ACTIVE' AND horizon_days = $1 FOR UPDATE`,
          [ev.horizonDays]
        );
        await m.query(`UPDATE daily_direction_policy SET state = 'RETIRED' WHERE state = 'ACTIVE' AND horizon_days = $1`, [ev.horizonDays]);
        await m.query(
          `INSERT INTO daily_direction_policy (horizon_days, version, policy, state, reason, experiment_run_id, evidence, promoted_at)
           VALUES ($1,$2,$3,'ACTIVE',$4,$5,$6::jsonb,now())`,
          [ev.horizonDays, version, decision.winner, decision.reason, experimentRunId,
           JSON.stringify({ prospective: winner.prospective, activeBar: ev.activeBar, trailingMajority: ev.trailingMajority, rule: DAILY_PROMOTION_RULE })]
        );
        await m.query(
          `INSERT INTO model_governance_transitions (model_key, from_state, to_state, reason, evidence_run_id) VALUES ($1,$2,$3,$4,$5)`,
          [`daily-policy:${ev.horizonDays}d:${inc?.version ?? "none"}→${version}`, "ACTIVE", "RETIRED", decision.reason, experimentRunId]
        );
      });
      promoted.push({ horizonDays: ev.horizonDays, version, policy: decision.winner });
    }

    const f = (x: number | null | undefined) => (x == null ? "n/a" : `${x.toFixed(1)}%`);
    await AppDataSource.query(
      `INSERT INTO learning_lessons (experiment_run_id, model_key, category, observation, lesson, action_taken, action_detail)
       VALUES ($1, 'daily-direction-policy', 'CALIBRATION', $2, $3, $4, $5)`,
      [
        experimentRunId,
        `${opts.note ? "[" + opts.note + "] " : ""}` +
          evals
            .map((e) => {
              const inc = e.challengers.find((c) => c.policy === "incumbent")!;
              const rev = e.challengers.find((c) => c.policy === "reversal")!;
              const mn = e.challengers.find((c) => c.policy === "market-neutral")!;
              return `${e.horizonDays}d active=${e.active} in-sample n=${e.inSampleN} (quant-v1 abs ${f(inc.inSample.hitRatePct)} / xs ${f(inc.inSample.crossSectionalHitPct)}; reversal xs ${f(rev.inSample.crossSectionalHitPct)}; mkt-neutral xs ${f(mn.inSample.crossSectionalHitPct)}) · prospective n=${e.prospectiveN} (quant-v1 abs ${f(inc.prospective.hitRatePct)} / xs ${f(inc.prospective.crossSectionalHitPct)}, trailing-majority ${f(e.trailingMajority.hitPct)})`;
            })
            .join(" | "),
        decisions.map((d) => d.decision.reason).join(" | "),
        promoted.length ? "THRESHOLD" : "NONE",
        promoted.length ? `Promoted ${promoted.map((p) => `${p.horizonDays}d→${p.policy}`).join(", ")}.` : "No policy changed. Re-evaluated next night.",
      ]
    );
  }

  return {
    experimentRunId,
    perHorizon: decisions.map((d) => ({ horizonDays: d.ev.horizonDays, active: d.ev.active, prospectiveN: d.ev.prospectiveN, decision: d.decision })),
    promoted,
    note: promoted.length
      ? `Promoted ${promoted.map((p) => p.version).join(", ")}. quant-v1 still logs its raw call; the policy changes only what direction is SHOWN.`
      : decisions.map((d) => d.decision.reason).join(" | "),
  };
}
