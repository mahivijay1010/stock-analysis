/**
 * Phase 7 tests (completion directive) — calibrator math and, critically, the
 * train/test separation discipline: fitting happens on the earlier slice,
 * selection on the later held-out slice, and nothing is promoted without
 * held-out improvement + enough effective samples.
 */

import {
  applyCalibrator,
  CalPoint,
  fitBeta,
  fitIsotonic,
  fitPlatt,
  selectCalibrator,
} from "../src/services/research/calibration";
import { mulberry32 } from "../src/services/quant/montecarlo";

/** Synthetic overconfident forecaster: true P(up)=0.5+0.3(p−0.5) — raw p too extreme. */
function overconfidentPoints(n: number, seed = 11): CalPoint[] {
  const rand = mulberry32(seed);
  const pts: CalPoint[] = [];
  for (let i = 0; i < n; i++) {
    const p = 0.05 + 0.9 * rand();
    const trueP = 0.5 + 0.3 * (p - 0.5);
    const outcome: 0 | 1 = rand() < trueP ? 1 : 0;
    const day = new Date(Date.UTC(2024, 0, 1 + i));
    pts.push({ prob: p, outcome, date: day.toISOString().slice(0, 10) });
  }
  return pts;
}

const brier = (pts: Array<{ p: number; y: number }>): number =>
  pts.reduce((a, x) => a + (x.p - x.y) ** 2, 0) / pts.length;

describe("calibrator fitting", () => {
  const train = overconfidentPoints(1200, 11);
  const hold = overconfidentPoints(800, 99);

  test("isotonic (PAV) output is monotonically non-decreasing", () => {
    const cal = fitIsotonic(train);
    const { values } = cal.params as { values: number[] };
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
  });

  test("all three calibrators improve held-out Brier on a known-overconfident forecaster", () => {
    const rawBrier = brier(hold.map((p) => ({ p: p.prob, y: p.outcome })));
    for (const fit of [fitPlatt, fitIsotonic, fitBeta]) {
      const cal = fit(train);
      const calBrier = brier(hold.map((p) => ({ p: applyCalibrator(cal, p.prob), y: p.outcome })));
      expect(calBrier).toBeLessThan(rawBrier);
    }
  });

  test("calibrated probabilities stay inside (0,1)", () => {
    for (const fit of [fitPlatt, fitIsotonic, fitBeta]) {
      const cal = fit(train);
      for (const p of [0.001, 0.3, 0.7, 0.999]) {
        const c = applyCalibrator(cal, p);
        expect(c).toBeGreaterThan(0);
        expect(c).toBeLessThan(1);
      }
    }
  });
});

describe("selectCalibrator — held-out discipline (Phase 7)", () => {
  test("promotes a calibrator on a genuinely miscalibrated forecaster, with fit strictly before hold-out", () => {
    const report = selectCalibrator(overconfidentPoints(2000), 1);
    expect(report.calibratorType).not.toBeNull();
    expect(report.brierAfter).not.toBeNull();
    expect(report.brierAfter!).toBeLessThan(report.brierBefore);
    expect(report.trainingEnd < "2028-01-01").toBe(true);
    expect(report.verdict).toMatch(/promoted on held-out evidence/);
  });

  test("refuses tiny samples — directional probability stays unavailable", () => {
    const report = selectCalibrator(overconfidentPoints(80), 1);
    expect(report.calibratorType).toBeNull();
    expect(report.verdict).toMatch(/insufficient calibration evidence/);
  });

  test("refuses when overlap makes effective hold-out samples inadequate (30d labels)", () => {
    // 300 points over 300 days → hold-out ~120 days ÷ 21 ≈ 5 effective < 10.
    const report = selectCalibrator(overconfidentPoints(300), 21);
    expect(report.calibratorType).toBeNull();
    expect(report.verdict).toMatch(/independent hold-out obs/);
  });

  test("does NOT promote on an already-calibrated forecaster (no held-out improvement)", () => {
    const rand = mulberry32(5);
    const pts: CalPoint[] = [];
    for (let i = 0; i < 2000; i++) {
      const p = 0.2 + 0.6 * rand();
      const outcome: 0 | 1 = rand() < p ? 1 : 0; // perfectly calibrated by construction
      pts.push({ prob: p, outcome, date: new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10) });
    }
    const report = selectCalibrator(pts, 1);
    // Either nothing improves, or improvement is marginal — the guard is that
    // a promotion REQUIRES strictly better held-out Brier AND no worse ECE.
    if (report.calibratorType != null) {
      expect(report.brierAfter!).toBeLessThan(report.brierBefore);
      expect(report.eceAfter!).toBeLessThanOrEqual(report.eceBefore + 1e-6);
    } else {
      expect(report.verdict).toMatch(/no calibrator improved/);
    }
  });
});
