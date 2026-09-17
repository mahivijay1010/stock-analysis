/**
 * Continuous-learning loop (docs/system-trust-review.md batch 3):
 * runWeeklyCalibrationRefresh composes the calibration/ensemble refresh and
 * the live-baseline experiment with isolated failure handling, so one
 * sub-job failing never prevents the other from running or being reported.
 * This is the exact behaviour CronService.weeklyCalibrationRefresh depends
 * on — tested here with fake deps, no DB required.
 */

import { runWeeklyCalibrationRefresh } from "../src/services/research/ResearchJobsService";
import { CalibrationEnsembleRunResult } from "../src/services/research/calibrationEnsembleRun";

function okCalibration(): CalibrationEnsembleRunResult {
  return {
    experimentRunId: "exp-cal-1",
    calibratorsFit: 3,
    calibratorsPromoted: 1,
    calibrationVerdicts: ["model-a 1d: promoted"],
    ensembleVerdicts: ["1d members=[]"],
    skipped: [],
  };
}

describe("runWeeklyCalibrationRefresh — failure isolation", () => {
  test("both sub-jobs succeed", async () => {
    const r = await runWeeklyCalibrationRefresh({
      runCalibration: async () => okCalibration(),
      runExperiment: async () => ({ id: "exp-baseline-1" }),
    });
    expect(r.calibration).toEqual(okCalibration());
    expect(r.experimentRunId).toBe("exp-baseline-1");
  });

  test("calibration fails, experiment still runs and reports its own result", async () => {
    const r = await runWeeklyCalibrationRefresh({
      runCalibration: async () => {
        throw new Error("harness DB unreachable");
      },
      runExperiment: async () => ({ id: "exp-baseline-2" }),
    });
    expect(r.calibration).toEqual({ error: "harness DB unreachable" });
    expect(r.experimentRunId).toBe("exp-baseline-2");
  });

  test("experiment fails, calibration still runs and reports its own result", async () => {
    const r = await runWeeklyCalibrationRefresh({
      runCalibration: async () => okCalibration(),
      runExperiment: async () => {
        throw new Error("insufficient distinct dates");
      },
    });
    expect(r.calibration).toEqual(okCalibration());
    expect(r.experimentRunId).toEqual({ error: "insufficient distinct dates" });
  });

  test("both fail — both errors are reported, neither throws out of the composition", async () => {
    await expect(
      runWeeklyCalibrationRefresh({
        runCalibration: async () => {
          throw new Error("cal boom");
        },
        runExperiment: async () => {
          throw new Error("exp boom");
        },
      })
    ).resolves.toEqual({ calibration: { error: "cal boom" }, experimentRunId: { error: "exp boom" } });
  });

  test("a non-Error throw is stringified rather than crashing the composition", async () => {
    const r = await runWeeklyCalibrationRefresh({
      runCalibration: async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "plain string failure";
      },
      runExperiment: async () => ({ id: "exp-baseline-3" }),
    });
    expect(r.calibration).toEqual({ error: "plain string failure" });
  });
});
