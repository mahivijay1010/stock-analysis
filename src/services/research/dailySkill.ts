/**
 * Daily-horizon skill measurement — does the 1/3/7/15/30-day direction call
 * know anything the market's own drift does not?
 *
 * WHY THIS EXISTS (measured 2026-10-01, docs: memory daily-model-findings).
 * quant-v1's 56.2% hit rate looked like progress. It was the tape: the model
 * calls DOWN ~70% of the time and NSE fell over the logged window, so a
 * constant "always DOWN" scored 60.6 / 70.9 / 84.3% at 1/3/7 days — beating
 * the model at every horizon. Raw hit rate rewards riding the regime, and a
 * target stated in raw hit rate ("reach 70–80%") can be met by a model with
 * zero skill in a one-way market and then collapse the week it turns.
 *
 * So skill is measured two ways, neither of which the regime can fake:
 *
 *   1. ABSOLUTE vs NAIVE. The model's hit rate beside the constant baselines
 *      scored on the very same rows: always-UP, always-DOWN, and the
 *      HINDSIGHT best constant (an upper bound no real model could know in
 *      advance — shown so "beats always-DOWN" is never mistaken for skill
 *      when the best constant did better still).
 *
 *   2. CROSS-SECTIONAL. Each (prediction_date, horizon) cohort is ranked
 *      against its own median realised return. A call is cross-sectionally
 *      correct when UP picks beat the cohort median and DOWN picks fall below
 *      it. The market's direction cancels out exactly; a constant scores 50%
 *      by construction. This is the stock-picking question.
 *
 * HIT DEFINITION. A call is correct when the direction SHOWN
 * (predicted_direction) equals the realised direction. This is stricter than
 * prediction_logs.prediction_correct, which grades the sign of
 * expected_return (it can disagree with the shown direction) and credits
 * "both near zero" as a hit; on 2026-10-01 that gap was 54.2% vs 52.8% at 1d.
 * The user acts on the shown direction, so that is what is scored here.
 *
 * Everything here is PURE so the definitions are unit-tested and cannot
 * drift into something more flattering.
 */

export type Direction = "UP" | "DOWN";

/** One graded prediction_logs row, as the scorer needs it. */
export interface GradedPrediction {
  ticker: string;
  predictionDate: string; // YYYY-MM-DD
  horizonDays: number;
  predictedDirection: Direction | "UNCERTAIN" | null;
  expectedReturnPct: number;
  actualReturnPct: number;
  actualDirection: Direction;
}

/** A direction policy: maps a row (with its cohort context) to a call, or null = no call. */
export type PolicyKey = "incumbent" | "reversal" | "market-neutral" | "null";

export const POLICY_DESCRIPTIONS: Record<PolicyKey, string> = {
  incumbent: "quant-v1 direction as logged",
  reversal: "quant-v1 direction flipped (short-term reversal hypothesis)",
  "market-neutral": "UP iff expected return is above the cohort's median expected return — strips the model's market-wide tilt",
  null: "no directional call",
};

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const cohortKey = (r: GradedPrediction) => `${r.predictionDate}|${r.horizonDays}`;

export interface CohortStats {
  medianActual: number;
  medianExpected: number;
  n: number;
}

/** Median realised and expected return per (prediction_date, horizon) cohort. PURE. */
export function cohortStats(rows: GradedPrediction[]): Map<string, CohortStats> {
  const groups = new Map<string, GradedPrediction[]>();
  for (const r of rows) {
    const k = cohortKey(r);
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  const out = new Map<string, CohortStats>();
  for (const [k, g] of groups) {
    out.set(k, {
      medianActual: median(g.map((r) => r.actualReturnPct)),
      medianExpected: median(g.map((r) => r.expectedReturnPct)),
      n: g.length,
    });
  }
  return out;
}

/** The call a policy makes on one row. PURE. */
export function policyDirection(policy: PolicyKey, r: GradedPrediction, c: CohortStats): Direction | null {
  const logged = r.predictedDirection === "UP" || r.predictedDirection === "DOWN" ? r.predictedDirection : null;
  switch (policy) {
    case "incumbent":
      return logged;
    case "reversal":
      return logged === null ? null : logged === "UP" ? "DOWN" : "UP";
    case "market-neutral":
      return r.expectedReturnPct > c.medianExpected ? "UP" : "DOWN";
    case "null":
      return null;
  }
}

export interface PolicyScore {
  /** Rows the policy was asked about. */
  n: number;
  /** Rows it actually made a call on. */
  calls: number;
  coveragePct: number | null;
  /** Hit rate on absolute direction, over calls. */
  hitRatePct: number | null;
  /** Hit rate against the cohort median, over calls. Constants score 50 by construction. */
  crossSectionalHitPct: number | null;
  /** Mean (actual − cohort median) of UP calls minus that of DOWN calls, in % — the long/short spread. */
  spreadPct: number | null;
  /** Distinct prediction dates — the honest count of near-independent market regimes sampled. */
  days: number;
}

const pct = (k: number, n: number) => (n > 0 ? (k / n) * 100 : null);

/** Score a policy over rows. `stats` must have been computed over (at least) the same cohorts. PURE. */
export function scorePolicy(policy: PolicyKey, rows: GradedPrediction[], stats: Map<string, CohortStats>): PolicyScore {
  let calls = 0;
  let hits = 0;
  let xsHits = 0;
  let upRel = 0;
  let upN = 0;
  let downRel = 0;
  let downN = 0;
  const days = new Set<string>();
  for (const r of rows) {
    days.add(r.predictionDate);
    const c = stats.get(cohortKey(r));
    if (!c) continue;
    const d = policyDirection(policy, r, c);
    if (d === null) continue;
    calls++;
    if (d === r.actualDirection) hits++;
    const rel = r.actualReturnPct - c.medianActual;
    if ((d === "UP" && rel > 0) || (d === "DOWN" && rel < 0)) xsHits++;
    if (d === "UP") {
      upRel += rel;
      upN++;
    } else {
      downRel += rel;
      downN++;
    }
  }
  return {
    n: rows.length,
    calls,
    coveragePct: pct(calls, rows.length),
    hitRatePct: pct(hits, calls),
    crossSectionalHitPct: pct(xsHits, calls),
    spreadPct: upN > 0 && downN > 0 ? upRel / upN - downRel / downN : null,
    days: days.size,
  };
}

export interface NaiveBaselines {
  alwaysUpPct: number | null;
  alwaysDownPct: number | null;
  /** max(alwaysUp, alwaysDown) — requires knowing the outcome. An upper bound, NOT an achievable model. */
  hindsightBestPct: number | null;
  hindsightBest: Direction | null;
}

/** Constant-direction hit rates on exactly these rows. PURE. */
export function naiveBaselines(rows: GradedPrediction[]): NaiveBaselines {
  const n = rows.length;
  if (n === 0) return { alwaysUpPct: null, alwaysDownPct: null, hindsightBestPct: null, hindsightBest: null };
  const up = rows.filter((r) => r.actualDirection === "UP").length;
  const upPct = (up / n) * 100;
  const downPct = 100 - upPct;
  return {
    alwaysUpPct: upPct,
    alwaysDownPct: downPct,
    hindsightBestPct: Math.max(upPct, downPct),
    hindsightBest: upPct >= downPct ? "UP" : "DOWN",
  };
}

/** Hit rate of a FIXED constant direction on these rows (for a no-hindsight baseline chosen elsewhere). PURE. */
export function constantHitPct(rows: GradedPrediction[], d: Direction): number | null {
  if (rows.length === 0) return null;
  return (rows.filter((r) => r.actualDirection === d).length / rows.length) * 100;
}

export interface HorizonScoreboard {
  horizonDays: number;
  model: PolicyScore;
  baselines: NaiveBaselines;
  /** model hit − hindsight-best constant, in pp. Negative = a constant beat the model. */
  edgeVsBestConstantPp: number | null;
  /** model cross-sectional hit − 50, in pp. Negative = picks were worse than random against the cohort. */
  crossSectionalEdgePp: number | null;
  verdict: string;
}

/** Withhold rates below this many graded rows — shared convention (MIN_GRADED_FOR_RATE). */
export const MIN_ROWS_FOR_VERDICT = 10;

/** Per-horizon scoreboard over all graded rows: the incumbent beside its naive baselines. PURE. */
export function scoreboard(rows: GradedPrediction[]): HorizonScoreboard[] {
  const stats = cohortStats(rows);
  const horizons = [...new Set(rows.map((r) => r.horizonDays))].sort((a, b) => a - b);
  return horizons.map((h) => {
    const hr = rows.filter((r) => r.horizonDays === h);
    const model = scorePolicy("incumbent", hr, stats);
    const baselines = naiveBaselines(hr);
    const edge = model.hitRatePct != null && baselines.hindsightBestPct != null ? model.hitRatePct - baselines.hindsightBestPct : null;
    const xsEdge = model.crossSectionalHitPct != null ? model.crossSectionalHitPct - 50 : null;
    return { horizonDays: h, model, baselines, edgeVsBestConstantPp: edge, crossSectionalEdgePp: xsEdge, verdict: verdictFor(h, model, baselines, edge, xsEdge) };
  });
}

function verdictFor(h: number, m: PolicyScore, b: NaiveBaselines, edge: number | null, xsEdge: number | null): string {
  if (m.calls < MIN_ROWS_FOR_VERDICT || edge == null || xsEdge == null || b.hindsightBestPct == null) {
    return `${h}d: ${m.calls} graded call${m.calls === 1 ? "" : "s"} — too few to judge.`;
  }
  const f = (x: number) => x.toFixed(1);
  const beatsConstant = edge > 0;
  const picks = xsEdge > 0;
  const days = `${m.days} prediction day${m.days === 1 ? "" : "s"}`;
  if (!beatsConstant && !picks) {
    return `${h}d: NO SKILL. Model ${f(m.hitRatePct!)}% vs always-${b.hindsightBest} ${f(b.hindsightBestPct)}% (${f(edge)} pp), and its picks were ${f(m.crossSectionalHitPct!)}% against the cohort median (below a coin). ${days}.`;
  }
  if (!beatsConstant) {
    return `${h}d: loses to always-${b.hindsightBest} (${f(m.hitRatePct!)}% vs ${f(b.hindsightBestPct)}%); stock-picking ${f(m.crossSectionalHitPct!)}% vs cohort median. ${days} — not yet evidence.`;
  }
  if (!picks) {
    return `${h}d: beats the best constant by ${f(edge)} pp but picks were ${f(m.crossSectionalHitPct!)}% vs cohort median — the edge is market timing, not stock selection. ${days}.`;
  }
  return `${h}d: beats the best constant by ${f(edge)} pp and picks ${f(m.crossSectionalHitPct!)}% vs cohort median. ${days} — overlapping multi-day windows, so UNPROVEN until it holds prospectively.`;
}

/** Least-flattering one-line summary across horizons. PURE. */
export function scoreboardHeadline(boards: HorizonScoreboard[]): string | null {
  const judged = boards.filter((b) => b.edgeVsBestConstantPp != null && b.model.calls >= MIN_ROWS_FOR_VERDICT);
  if (judged.length === 0) return null;
  const losing = judged.filter((b) => (b.edgeVsBestConstantPp ?? 0) <= 0);
  if (losing.length === judged.length) {
    const worst = losing.reduce((a, b) => ((a.edgeVsBestConstantPp ?? 0) < (b.edgeVsBestConstantPp ?? 0) ? a : b));
    return `A constant guess beat the model at every horizon (worst: ${worst.horizonDays}d, model ${worst.model.hitRatePct?.toFixed(1)}% vs always-${worst.baselines.hindsightBest} ${worst.baselines.hindsightBestPct?.toFixed(1)}%). The raw hit rate is the market's drift, not skill.`;
  }
  if (losing.length > 0) {
    return `A constant guess beat the model at ${losing.map((b) => `${b.horizonDays}d`).join(", ")}. Raw hit rate there is regime, not skill.`;
  }
  const noPicks = judged.filter((b) => (b.crossSectionalEdgePp ?? 0) <= 0);
  if (noPicks.length > 0) {
    return `The model beats every constant, but its stock picks are no better than random at ${noPicks.map((b) => `${b.horizonDays}d`).join(", ")} — market timing, not selection.`;
  }
  return "The model beats every constant and its picks beat the cohort median at every judged horizon — on overlapping windows; UNPROVEN until it holds prospectively.";
}
