/**
 * The daily skill definitions and promotion rule, pinned.
 *
 * The failure this guards against was real (2026-10-01): a 56% raw hit rate
 * that a constant always-DOWN beat at every horizon. If cross-sectional
 * scoring ever let a constant score above 50%, or the rule promoted on
 * in-sample days, the system would report regime as skill again.
 */

import { GradedPrediction, cohortStats, naiveBaselines, scoreboard, scoreboardHeadline, scorePolicy } from "../src/services/research/dailySkill";
import {
  DAILY_PROMOTION_RULE,
  DatedPrediction,
  decideHorizon,
  evaluateHorizon,
  trailingMajorityHitPct,
} from "../src/services/research/dailyChallengerRun";

function addDays(d: string, n: number): string {
  const t = new Date(d + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** A cohort of `n` stocks on `date`: expected returns 0..n-1, actual = market + skill·(rank − mid) + noise-free. */
function cohort(date: string, n: number, opts: { market: number; skill: number; predicted?: (i: number) => "UP" | "DOWN"; h?: number }): DatedPrediction[] {
  const h = opts.h ?? 1;
  return Array.from({ length: n }, (_, i) => {
    const actual = opts.market + opts.skill * (i - (n - 1) / 2);
    return {
      ticker: `T${i}`,
      predictionDate: date,
      targetDate: addDays(date, h),
      horizonDays: h,
      predictedDirection: opts.predicted ? opts.predicted(i) : i >= n / 2 ? "UP" : "DOWN",
      expectedReturnPct: i - (n - 1) / 2,
      actualReturnPct: actual,
      actualDirection: actual > 0 ? "UP" : "DOWN",
    };
  });
}

describe("dailySkill — regime cannot masquerade as skill", () => {
  it("a constant call scores exactly 50% cross-sectionally, however one-way the tape", () => {
    const rows = cohort("2026-09-20", 20, { market: -3, skill: 0.1, predicted: () => "DOWN" });
    const s = scorePolicy("incumbent", rows, cohortStats(rows));
    expect(s.hitRatePct).toBe(100); // every stock fell
    expect(s.crossSectionalHitPct).toBe(50); // …and that says nothing about picking
  });

  it("baselines report always-UP/DOWN and flag the hindsight best", () => {
    const rows = cohort("2026-09-20", 10, { market: -3, skill: 0.1 });
    expect(naiveBaselines(rows)).toEqual({ alwaysUpPct: 0, alwaysDownPct: 100, hindsightBestPct: 100, hindsightBest: "DOWN" });
  });

  it("a genuine picker scores 100% cross-sectionally and the reversal of it scores 0%", () => {
    const rows = cohort("2026-09-20", 20, { market: 0.05, skill: 0.2 });
    const st = cohortStats(rows);
    expect(scorePolicy("incumbent", rows, st).crossSectionalHitPct).toBe(100);
    expect(scorePolicy("reversal", rows, st).crossSectionalHitPct).toBe(0);
    expect(scorePolicy("market-neutral", rows, st).crossSectionalHitPct).toBe(100);
    expect(scorePolicy("null", rows, st).calls).toBe(0);
  });

  it("market-neutral strips a bearish tilt: a model calling DOWN on everything still gets ranked", () => {
    const rows = cohort("2026-09-20", 20, { market: 0, skill: 0.2, predicted: () => "DOWN" });
    const st = cohortStats(rows);
    expect(scorePolicy("incumbent", rows, st).crossSectionalHitPct).toBe(50);
    expect(scorePolicy("market-neutral", rows, st).crossSectionalHitPct).toBe(100);
  });

  it("scoreboard headline says a constant beat the model when it did", () => {
    const rows: GradedPrediction[] = cohort("2026-09-20", 20, { market: -3, skill: 0.1, predicted: (i) => (i % 3 === 0 ? "UP" : "DOWN") });
    const b = scoreboard(rows);
    expect(b[0].edgeVsBestConstantPp).toBeLessThan(0);
    expect(scoreboardHeadline(b)).toMatch(/constant guess beat the model at every horizon/);
  });
});

describe("dailyChallengerRun — the pre-registered rule", () => {
  const REG = "2026-10-01";
  const days = (start: string, k: number) => Array.from({ length: k }, (_, i) => addDays(start, i));

  it("trailing majority uses only matured rows (no hindsight)", () => {
    const hist = cohort("2026-09-20", 4, { market: -1, skill: 0 }); // matures 09-21, all DOWN
    const today = cohort("2026-09-21", 4, { market: 1, skill: 0 }); // same day as maturity → not yet known
    expect(trailingMajorityHitPct(today, [...hist, ...today]).calls).toBe(0);
    const tomorrow = cohort("2026-09-22", 4, { market: 1, skill: 0 });
    expect(trailingMajorityHitPct(tomorrow, [...hist, ...tomorrow])).toEqual({ hitPct: 0, calls: 4 });
  });

  it("never promotes on in-sample days, however good the challenger looks there", () => {
    // Reversal is perfect in-sample: model's picks are exactly backwards.
    const pre = days("2026-09-01", 25).flatMap((d) => cohort(d, 60, { market: 0.1, skill: -0.2 }));
    const ev = evaluateHorizon(pre, 1, "incumbent", REG);
    expect(ev.challengers.find((c) => c.policy === "reversal")!.inSample.crossSectionalHitPct).toBe(100);
    const dec = decideHorizon(ev);
    expect(dec.promote).toBe(false);
    expect(dec.reason).toMatch(/prospective window has 0 calls/);
  });

  it("promotes reversal when it clears every threshold prospectively", () => {
    const post = days(REG, 12).flatMap((d) => cohort(d, 60, { market: 0.5, skill: -0.2 }));
    const pre = cohort("2026-09-25", 60, { market: 0.5, skill: -0.2 });
    const ev = evaluateHorizon([...pre, ...post], 1, "incumbent", REG);
    const dec = decideHorizon(ev);
    expect(post.length).toBeGreaterThanOrEqual(DAILY_PROMOTION_RULE.minCalls);
    expect(dec.promote).toBe(true);
    expect(dec.winner).toBe("reversal");
  });

  it("refuses with too few prospective DAYS even when calls are plentiful", () => {
    const post = days(REG, 9).flatMap((d) => cohort(d, 100, { market: 0.5, skill: -0.2 }));
    const dec = decideHorizon(evaluateHorizon(post, 1, "incumbent", REG));
    expect(dec.promote).toBe(false);
    expect(dec.reason).toMatch(/over 9 days/);
  });

  it("promotes NULL when the active policy loses to both a constant and a coin", () => {
    // Market falls every day; model calls UP on its top half, but its picks have no skill
    // (all actuals identical → cross-sectional ties count as misses).
    const post = days(REG, 12).flatMap((d) => cohort(d, 60, { market: -1, skill: 0 }));
    const pre = cohort("2026-09-25", 60, { market: -1, skill: 0 });
    const ev = evaluateHorizon([...pre, ...post], 1, "incumbent", REG);
    const dec = decideHorizon(ev);
    expect(dec.winner).toBe("null");
  });
});
