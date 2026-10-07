/**
 * Calibration curve (reliability diagram). These pin the honesty rules that
 * make the feedback loop trustworthy: a perfectly-calibrated stream reads
 * WELL_CALIBRATED, a confidently-wrong stream reads OVERCONFIDENT, bins below
 * the minimum count are withheld (not fabricated), and ECE/Brier are computed.
 */

import { buildCalibration, CalibrationPoint } from "../src/services/evidence/calibrationCurve";

/** Deterministic stream: among n points with stated prob p, exactly round(p·n)
 *  win — i.e. perfectly calibrated at p. */
function calibratedBucket(p: number, n: number): CalibrationPoint[] {
  const wins = Math.round(p * n);
  return Array.from({ length: n }, (_, i) => ({ predictedProb: p, won: i < wins }));
}

describe("buildCalibration", () => {
  test("a perfectly-calibrated stream reads WELL_CALIBRATED with low ECE", () => {
    const pts = [...calibratedBucket(0.15, 100), ...calibratedBucket(0.45, 100), ...calibratedBucket(0.55, 100), ...calibratedBucket(0.85, 100)];
    const r = buildCalibration(pts, { nBins: 10, minPerBin: 20 });
    expect(r.reliability).toBe("WELL_CALIBRATED");
    expect(r.ece!).toBeLessThanOrEqual(0.05);
    expect(r.brier).not.toBeNull();
  });

  test("a confidently-wrong stream reads OVERCONFIDENT", () => {
    // Stated 0.8 everywhere, but only 30% actually win.
    const pts = [...calibratedBucket(0.8, 100).map((_, i) => ({ predictedProb: 0.8, won: i < 30 }))];
    const r = buildCalibration(pts, { nBins: 10, minPerBin: 20 });
    expect(r.reliability).toBe("OVERCONFIDENT");
    expect(r.headline).toMatch(/[Oo]verconfident/);
    expect(r.overallPredictedMean!).toBeGreaterThan(r.overallActualRate!);
  });

  test("bins below the minimum count are withheld, never fabricated", () => {
    const pts = [...calibratedBucket(0.55, 100), ...Array.from({ length: 5 }, () => ({ predictedProb: 0.95, won: true }))];
    const r = buildCalibration(pts, { nBins: 10, minPerBin: 20 });
    const topBin = r.bins[r.bins.length - 1];
    expect(topBin.count).toBe(5);
    expect(topBin.actualRate).toBeNull();
    expect(topBin.withheld).toBe(true);
  });

  test("a per-bin actual rate carries a Wilson interval", () => {
    const r = buildCalibration(calibratedBucket(0.55, 200), { nBins: 10, minPerBin: 20 });
    const bin = r.bins.find((b) => b.count >= 20)!;
    expect(bin.actualRate).not.toBeNull();
    expect(bin.wilsonLo).toBeLessThanOrEqual(bin.actualRate!);
    expect(bin.wilsonHi).toBeGreaterThanOrEqual(bin.actualRate!);
  });

  test("too few points overall ⇒ INSUFFICIENT, not a fake curve", () => {
    const r = buildCalibration([{ predictedProb: 0.5, won: true }], { minPerBin: 20 });
    expect(r.reliability).toBe("INSUFFICIENT");
    expect(r.brier).toBeNull();
  });
});
