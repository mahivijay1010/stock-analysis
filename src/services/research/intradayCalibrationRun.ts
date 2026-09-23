/**
 * Nightly intraday calibration — the learning half of the intraday loop.
 *
 * Every session, the forecaster's incumbent parameters are re-scored against
 * a fixed set of CHALLENGERS on that day's persisted outcomes, and a challenger
 * replaces the incumbent only if it clears a rule written down here BEFORE the
 * first run. This file is deliberately pure in its core (`rescore`,
 * `evaluateChallengers`, `decidePromotion`) so the rule is unit-tested and
 * cannot drift by accident.
 *
 * THE RULE, pre-registered 2026-09-23 (docs/intraday-microstructure-notes.md §8):
 *
 *   Split the session CHRONOLOGICALLY: first 60% of graded forecasts (by
 *   made_at) is the fit set, last 40% is the hold-out. Never random — random
 *   splits leak the day's regime across the boundary, and the hold-out then
 *   includes the closing volatility spike (§4), so a winner there has survived
 *   the hardest regime, not an easy one.
 *
 *   A challenger is PROMOTED only if, on the hold-out:
 *     (a) n_test ≥ 500,
 *     (b) its hit rate > 50.0%,
 *     (c) its hit rate beats the incumbent's by ≥ 1.5 percentage points,
 *     (d) its Brier score is lower (better) than the incumbent's.
 *   Among qualifying challengers, the highest hold-out hit rate wins.
 *
 *   The NULL model (driftSign 0 — no directional call, P(up) ≡ 0.5) is a
 *   first-class challenger with a special rule: if NO challenger qualifies AND
 *   the incumbent's hold-out hit rate is ≤ 50%, the null is promoted. If the
 *   incumbent loses to a coin, the coin is the better model, and the honest
 *   display is "no directional call" rather than a confident wrong one.
 *
 * WHY THE CHALLENGER SET IS WHAT IT IS. Roll (1984) predicts negative
 * autocorrelation from bid-ask bounce at this horizon, which motivates
 * `driftSign: -1`. arXiv 2606.29591 predicts that bounce has no *directional*
 * power, which motivates `driftSign: 0`. Shrinkage 0.5 and 1.0 test whether
 * the incumbent's 0.25 is throwing away real signal. Nothing else: a wide
 * search over a single day is how one manufactures a spurious winner.
 *
 * WHAT THIS DOES NOT DO. It does not decide whether a forecast is worth
 * acting on — that is the cost gate (`clears_cost`), which is reported here
 * as a statistic but does not enter the promotion rule. A model can be
 * directionally right and still uneconomic; those are different questions,
 * and conflating them is how the entry/exit cards ended up showing targets on
 * trades that could not clear their own fees.
 *
 * Re-scoring is exact, not approximate: the stored row carries the shrinkage
 * and horizon it was made under, so the raw EWMA drift is recovered as
 * expected / (shrinkage × horizon), and any (sign, shrinkage) challenger is
 * then a closed-form transform of stored fields. Half-life challengers would
 * need the bar history and are deliberately out of scope for v1.
 */

import { createHash } from "crypto";
import { AppDataSource } from "../../config/database";
import {
  IntradayModelParams,
  IntradayOutcomeRepository,
  StoredOutcomeRow,
  intradayOutcomeRepository,
} from "../realtime/intradayOutcomeRepository";

export const INTRADAY_CALIBRATION_VERSION = "intraday-calibration-v1";

/** Pre-registered thresholds. Changing any of these is a methodology change and must be a visible commit. */
export const PROMOTION_RULE = {
  fitFraction: 0.6,
  minHoldoutN: 500,
  minHoldoutHitRatePct: 50.0,
  minImprovementPp: 1.5,
} as const;

export interface Challenger {
  key: string;
  describe: string;
  params: IntradayModelParams;
}

/** The fixed challenger set. Derived from the incumbent so half-life and clamps are held equal. */
export function challengerSet(incumbent: IntradayModelParams): Challenger[] {
  return [
    { key: "mean-reversion", describe: "driftSign −1 (Roll 1984 bounce)", params: { ...incumbent, driftSign: -1 } },
    { key: "null", describe: "driftSign 0 — no directional call, P(up)=0.5", params: { ...incumbent, driftSign: 0 } },
    { key: "shrink-0.5", describe: "shrinkage 0.50", params: { ...incumbent, driftShrinkage: 0.5 } },
    { key: "shrink-1.0", describe: "shrinkage 1.00 (unshrunk)", params: { ...incumbent, driftShrinkage: 1.0 } },
  ];
}

/** Normal CDF (Abramowitz–Stegun 7.1.26) — same approximation the forecaster uses. */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-(z * z) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface Rescored {
  /** P(up) under the challenger. Exactly 0.5 for the null model. */
  probabilityUp: number;
  /** Null model withholds direction; scored as WRONG for hit rate purposes so it can never "win" on direction. */
  direction: "UP" | "DOWN" | null;
  correct: boolean;
  brier: number;
}

/**
 * Re-score one stored outcome under different parameters. PURE.
 *
 * raw drift per bar = expected / (shrinkage_made × horizon)
 * expected' = sign × shrinkage' × raw × horizon
 * P'(up) = clamp(Φ(expected' / (barVol × √horizon)))
 */
export function rescore(row: StoredOutcomeRow, p: IntradayModelParams): Rescored {
  const madeUnder = row.model_params;
  const horizon = Number(row.horizon_min);
  const expectedMade = Number(row.expected_return_pct);
  const barVol = Number(row.bar_vol_pct);
  const actualUp = row.actual_direction === "UP" ? 1 : 0;

  if (p.driftSign === 0) {
    return { probabilityUp: 0.5, direction: null, correct: false, brier: 0.25 };
  }

  const shrinkMade = madeUnder.driftShrinkage > 0 ? madeUnder.driftShrinkage : 1;
  const signMade = madeUnder.driftSign === 0 ? 1 : madeUnder.driftSign;
  const rawDrift = expectedMade / (signMade * shrinkMade * horizon);
  const expectedNew = p.driftSign * p.driftShrinkage * rawDrift * horizon;
  const horizonVol = barVol * Math.sqrt(horizon);
  const prob = horizonVol > 0 ? clamp(normalCdf(expectedNew / horizonVol), p.minProbability, p.maxProbability) : 0.5;
  const direction: "UP" | "DOWN" = prob >= 0.5 ? "UP" : "DOWN";
  return {
    probabilityUp: prob,
    direction,
    correct: direction === row.actual_direction,
    brier: (prob - actualUp) ** 2,
  };
}

export interface SplitScore {
  n: number;
  hitRatePct: number | null;
  brier: number | null;
  /** Realised |return| inside the incumbent's stored 80% band — a property of the day, not the challenger. */
  bandCoverage80Pct: number | null;
  clearsCostRatePct: number | null;
}

function scoreRows(rows: StoredOutcomeRow[], p: IntradayModelParams | null): SplitScore {
  const n = rows.length;
  if (n === 0) return { n: 0, hitRatePct: null, brier: null, bandCoverage80Pct: null, clearsCostRatePct: null };
  let correct = 0;
  let brierSum = 0;
  let inBand = 0;
  let clears = 0;
  for (const r of rows) {
    const actual = Number(r.actual_return_pct);
    if (p) {
      const s = rescore(r, p);
      if (s.correct) correct++;
      brierSum += s.brier;
    } else {
      if (r.outcome === "CORRECT") correct++;
      brierSum += (Number(r.probability_up) - (r.actual_direction === "UP" ? 1 : 0)) ** 2;
    }
    if (actual >= Number(r.low80_pct) && actual <= Number(r.high80_pct)) inBand++;
    if (r.clears_cost) clears++;
  }
  return {
    n,
    hitRatePct: (correct / n) * 100,
    brier: brierSum / n,
    bandCoverage80Pct: (inBand / n) * 100,
    clearsCostRatePct: (clears / n) * 100,
  };
}

export interface ChallengerResult {
  key: string;
  describe: string;
  params: IntradayModelParams;
  fit: SplitScore;
  holdout: SplitScore;
  qualifies: boolean;
  why: string;
}

export interface EvaluationResult {
  horizonMin: number;
  sessionDate: string;
  nTotal: number;
  split: { fitN: number; holdoutN: number; boundaryMadeAt: string | null };
  incumbent: { version: string; params: IntradayModelParams; fit: SplitScore; holdout: SplitScore };
  challengers: ChallengerResult[];
}

/** Chronological split, then score incumbent (as stored) and every challenger (re-scored). PURE. */
export function evaluateChallengers(
  rows: StoredOutcomeRow[],
  incumbentVersion: string,
  incumbent: IntradayModelParams,
  horizonMin: number,
  sessionDate: string
): EvaluationResult {
  const sorted = [...rows].sort((a, b) => new Date(a.made_at).getTime() - new Date(b.made_at).getTime());
  const cut = Math.floor(sorted.length * PROMOTION_RULE.fitFraction);
  const fit = sorted.slice(0, cut);
  const holdout = sorted.slice(cut);

  const incFit = scoreRows(fit, null);
  const incHold = scoreRows(holdout, null);

  const challengers = challengerSet(incumbent).map((c): ChallengerResult => {
    const cFit = scoreRows(fit, c.params);
    const cHold = scoreRows(holdout, c.params);
    const reasons: string[] = [];
    if (c.params.driftSign === 0) {
      reasons.push("null model: cannot qualify on direction; promoted only if nothing else does and the incumbent ≤ 50%");
    } else {
      if (cHold.n < PROMOTION_RULE.minHoldoutN) reasons.push(`hold-out n ${cHold.n} < ${PROMOTION_RULE.minHoldoutN}`);
      if ((cHold.hitRatePct ?? 0) <= PROMOTION_RULE.minHoldoutHitRatePct) reasons.push(`hold-out hit ${cHold.hitRatePct?.toFixed(2)}% ≤ 50%`);
      const lift = (cHold.hitRatePct ?? 0) - (incHold.hitRatePct ?? 0);
      if (lift < PROMOTION_RULE.minImprovementPp) reasons.push(`lift ${lift.toFixed(2)} pp < ${PROMOTION_RULE.minImprovementPp}`);
      if ((cHold.brier ?? 1) >= (incHold.brier ?? 1)) reasons.push(`Brier ${cHold.brier?.toFixed(4)} not better than incumbent ${incHold.brier?.toFixed(4)}`);
    }
    return {
      key: c.key,
      describe: c.describe,
      params: c.params,
      fit: cFit,
      holdout: cHold,
      qualifies: reasons.length === 0,
      why: reasons.length ? reasons.join("; ") : "clears every pre-registered threshold on the hold-out",
    };
  });

  return {
    horizonMin,
    sessionDate,
    nTotal: sorted.length,
    split: { fitN: fit.length, holdoutN: holdout.length, boundaryMadeAt: holdout[0] ? new Date(holdout[0].made_at).toISOString() : null },
    incumbent: { version: incumbentVersion, params: incumbent, fit: incFit, holdout: incHold },
    challengers,
  };
}

export interface PromotionDecision {
  promote: boolean;
  winner: ChallengerResult | null;
  reason: string;
}

/** Apply the pre-registered rule to an evaluation. PURE. */
export function decidePromotion(ev: EvaluationResult): PromotionDecision {
  const qualifying = ev.challengers.filter((c) => c.qualifies && c.params.driftSign !== 0);
  if (qualifying.length > 0) {
    const winner = qualifying.sort((a, b) => (b.holdout.hitRatePct ?? 0) - (a.holdout.hitRatePct ?? 0))[0];
    return {
      promote: true,
      winner,
      reason:
        `${winner.key} (${winner.describe}) beat incumbent ${ev.incumbent.version} on the chronological hold-out: ` +
        `${winner.holdout.hitRatePct?.toFixed(2)}% vs ${ev.incumbent.holdout.hitRatePct?.toFixed(2)}% on n=${winner.holdout.n}, ` +
        `Brier ${winner.holdout.brier?.toFixed(4)} vs ${ev.incumbent.holdout.brier?.toFixed(4)}. ` +
        `Session ${ev.sessionDate}, ${ev.horizonMin}m. One session is not proof of skill; this is a governed parameter change, re-tested nightly.`,
    };
  }
  const nullModel = ev.challengers.find((c) => c.params.driftSign === 0) ?? null;
  const incHit = ev.incumbent.holdout.hitRatePct;
  if (nullModel && ev.incumbent.holdout.n >= PROMOTION_RULE.minHoldoutN && incHit != null && incHit <= 50) {
    return {
      promote: true,
      winner: nullModel,
      reason:
        `No challenger qualified and the incumbent ${ev.incumbent.version} scored ${incHit.toFixed(2)}% on the hold-out (n=${ev.incumbent.holdout.n}) — ` +
        `at or below a coin flip. Promoting the NULL model: direction withheld, P(up)=0.5. A coin is the better model than a confident wrong one.`,
    };
  }
  return {
    promote: false,
    winner: null,
    reason:
      ev.incumbent.holdout.n < PROMOTION_RULE.minHoldoutN
        ? `hold-out n=${ev.incumbent.holdout.n} < ${PROMOTION_RULE.minHoldoutN}; too little data to change anything`
        : `no challenger cleared the pre-registered rule; incumbent ${ev.incumbent.version} retained at ${incHit?.toFixed(2)}% hold-out`,
  };
}

export interface CalibrationRunSummary {
  sessionDate: string;
  experimentRunId: string | null;
  perHorizon: Array<{ horizonMin: number; nTotal: number; decision: PromotionDecision; incumbentHoldoutHitPct: number | null }>;
  promoted: { horizonMin: number; version: string } | null;
  note: string;
}

/**
 * The job. Reads a session's persisted outcomes, evaluates, records an
 * experiment run, promotes at most ONE parameter set (the 1-minute horizon
 * has the most data and governs; 5-minute is evaluated and recorded but does
 * not promote independently in v1 — one live parameter set at a time keeps
 * the causal story readable), and writes a learning_lessons row either way.
 */
export async function runIntradayCalibration(opts: {
  sessionDate?: string;
  repo?: IntradayOutcomeRepository;
  horizons?: number[];
  dryRun?: boolean;
} = {}): Promise<CalibrationRunSummary> {
  const repo = opts.repo ?? intradayOutcomeRepository;
  const horizons = opts.horizons ?? [1, 5];
  const startedAt = new Date();

  const sessionDate = opts.sessionDate ?? (await repo.sessionsWithData(1))[0];
  if (!sessionDate) {
    return { sessionDate: "none", experimentRunId: null, perHorizon: [], promoted: null, note: "no persisted intraday outcomes yet — nothing to learn from" };
  }

  const active = await repo.activeParams();
  const evaluations: EvaluationResult[] = [];
  for (const h of horizons) {
    const rows = await repo.outcomesForSession(sessionDate, h);
    evaluations.push(evaluateChallengers(rows, active.version, active.params, h, sessionDate));
  }

  const ids = evaluations.flatMap((e) => e.challengers.map((c) => `${e.horizonMin}|${c.key}|${c.holdout.n}`)).join("\n");
  const datasetHash = createHash("sha256").update(`${sessionDate}|${ids}`).digest("hex");

  const governing = evaluations.find((e) => e.horizonMin === 1) ?? evaluations[0];
  const decision = decidePromotion(governing);

  const metrics = {
    version: INTRADAY_CALIBRATION_VERSION,
    rule: PROMOTION_RULE,
    evaluations: evaluations.map((e) => ({
      horizonMin: e.horizonMin,
      nTotal: e.nTotal,
      split: e.split,
      incumbent: { version: e.incumbent.version, holdout: e.incumbent.holdout, fit: e.incumbent.fit },
      challengers: e.challengers.map((c) => ({ key: c.key, holdout: c.holdout, fit: c.fit, qualifies: c.qualifies, why: c.why })),
    })),
    decision: { promote: decision.promote, winner: decision.winner?.key ?? null, reason: decision.reason },
  };

  let experimentRunId: string | null = null;
  if (!opts.dryRun) {
    const [run]: Array<{ id: string }> = await AppDataSource.query(
      `INSERT INTO experiment_runs
         (name, kind, model_version, config, splits, dataset_manifest, dataset_hash, metrics, baselines, segments_used, used_final_test, status, notes, started_at, finished_at)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10::jsonb,false,'completed',$11,$12,now())
       RETURNING id`,
      [
        "intraday-calibration",
        "challenger",
        active.version,
        JSON.stringify({ challengers: challengerSet(active.params).map((c) => c.key), rule: PROMOTION_RULE }),
        JSON.stringify({ method: "chronological 60/40 by made_at within the session", perHorizon: evaluations.map((e) => ({ h: e.horizonMin, ...e.split })) }),
        JSON.stringify({ source: "intraday_forecast_outcomes", sessionDate, horizons, rows: evaluations.map((e) => ({ h: e.horizonMin, n: e.nTotal })) }),
        datasetHash,
        JSON.stringify(metrics),
        JSON.stringify({ note: "incumbent as stored is the baseline; null model (P=0.5, Brier 0.25) is the floor" }),
        JSON.stringify(["fit(chronological first 60%)", "holdout(chronological last 40%)"]),
        `Nightly intraday challenger evaluation for ${sessionDate}. ${decision.reason}`,
        startedAt,
      ]
    );
    experimentRunId = run?.id ?? null;
  }

  let promoted: CalibrationRunSummary["promoted"] = null;
  if (decision.promote && decision.winner && !opts.dryRun) {
    const version = `ip-${sessionDate.replace(/-/g, "")}-${decision.winner.key}`;
    await repo.promote({
      version,
      params: decision.winner.params,
      reason: decision.reason,
      evidence: { sessionDate, horizonMin: governing.horizonMin, holdout: decision.winner.holdout, incumbentHoldout: governing.incumbent.holdout, rule: PROMOTION_RULE },
      experimentRunId,
    });
    promoted = { horizonMin: governing.horizonMin, version };
  }

  if (!opts.dryRun) {
    await AppDataSource.query(
      `INSERT INTO learning_lessons (experiment_run_id, model_key, category, observation, lesson, action_taken, action_detail)
       VALUES ($1, 'intraday-forecast-v1', 'CALIBRATION', $2, $3, $4, $5)`,
      [
        experimentRunId,
        `Session ${sessionDate}: ` +
          evaluations
            .map((e) => `${e.horizonMin}m n=${e.nTotal}, incumbent hold-out ${e.incumbent.holdout.hitRatePct?.toFixed(2) ?? "n/a"}% (band cov ${e.incumbent.holdout.bandCoverage80Pct?.toFixed(1) ?? "n/a"}%, clears-cost ${e.incumbent.holdout.clearsCostRatePct?.toFixed(2) ?? "n/a"}%); ` +
              e.challengers.map((c) => `${c.key}=${c.holdout.hitRatePct?.toFixed(2) ?? "n/a"}%`).join(", "))
            .join(" | "),
        decision.reason,
        decision.promote ? "THRESHOLD" : "NONE",
        promoted ? `Promoted ${promoted.version} as ACTIVE intraday params.` : "Incumbent retained. Re-evaluated next session.",
      ]
    );
  }

  return {
    sessionDate,
    experimentRunId,
    perHorizon: evaluations.map((e) => ({
      horizonMin: e.horizonMin,
      nTotal: e.nTotal,
      decision: e === governing ? decision : { promote: false, winner: null, reason: "evaluated only; 1m horizon governs promotion in v1" },
      incumbentHoldoutHitPct: e.incumbent.holdout.hitRatePct,
    })),
    promoted,
    note: promoted
      ? `Promoted ${promoted.version}. The forecaster picks it up at its next start; nothing about whether the calls are ECONOMIC changed — see clears_cost.`
      : decision.reason,
  };
}
