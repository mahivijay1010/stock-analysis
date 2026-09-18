/**
 * EvidenceService — the honesty invariants of the transparency tab.
 *
 * These tests exist because the failure mode of a transparency surface is not
 * a crash, it is a surface that quietly looks better than the evidence. Each
 * test below pins one property that, if it broke, would let the tab flatter
 * the model without anything appearing wrong.
 */

import { EvidenceService, MIN_GRADED_FOR_RATE } from "../src/services/evidence/EvidenceService";
import { AppDataSource } from "../src/config/database";

jest.mock("../src/config/database", () => ({
  AppDataSource: { query: jest.fn() },
}));

const q = AppDataSource.query as jest.Mock;

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    ticker: "COALINDIA.NS",
    prediction_date: "2026-09-16",
    target_date: "2026-09-17",
    horizon_days: 1,
    model_version: "quant-v1",
    predicted_direction: "UP",
    predicted_probability: "0.5377",
    confidence: "0.5377",
    expected_return: "0.1354",
    actual_return: "-1.9378",
    actual_direction: "DOWN",
    prediction_correct: false,
    outcome_date: "2026-09-17",
    recommendation_given: null,
    ...over,
  };
}

/** prediction_logs is read twice: the page of rows, then the full-table counts. */
function mockPredictions(rows: Record<string, unknown>[], totals: Record<string, string>): void {
  q.mockReset();
  q.mockImplementationOnce(async () => rows).mockImplementationOnce(async () => [totals]);
}

describe("EvidenceService.predictions — the ledger cannot flatter the model", () => {
  test("wrong predictions are ordered before correct ones by the QUERY, not the client", async () => {
    mockPredictions([], { total: "0", wrong: "0", correct: "0", pending: "0" });
    await new EvidenceService().predictions();
    const sql = String(q.mock.calls[0][0]);
    // The CASE must rank FALSE (wrong) at 0, TRUE at 1, NULL (pending) at 2.
    expect(sql).toMatch(/prediction_correct IS FALSE THEN 0/);
    expect(sql).toMatch(/prediction_correct IS TRUE\s+THEN 1/);
    // and nothing may filter rows out of the ledger.
    expect(sql).not.toMatch(/WHERE/i);
  });

  test("counts come from the whole table, so a page limit cannot shrink the denominator", async () => {
    // One row returned, but the table holds 25 — the summary must say 25.
    mockPredictions([row()], { total: "25", wrong: "2", correct: "0", pending: "23" });
    const led = await new EvidenceService().predictions(1);
    expect(led.rows).toHaveLength(1);
    expect(led.total).toBe(25);
    expect(led.pending).toBe(23);
    expect(led.graded).toBe(2);
  });

  test("a null prediction_correct is PENDING — never counted as a success", async () => {
    mockPredictions(
      [row({ prediction_correct: null, actual_return: null, actual_direction: null })],
      { total: "1", wrong: "0", correct: "0", pending: "1" }
    );
    const led = await new EvidenceService().predictions();
    expect(led.rows[0].grade).toBe("PENDING");
    expect(led.rows[0].errorPct).toBeNull();
    expect(led.correct).toBe(0);
  });

  test("the hit rate is WITHHELD below the minimum graded sample, with an explanation", async () => {
    mockPredictions([row()], { total: "25", wrong: "2", correct: "0", pending: "23" });
    const led = await new EvidenceService().predictions();
    expect(led.graded).toBeLessThan(MIN_GRADED_FOR_RATE);
    expect(led.hitRatePct).toBeNull();
    expect(led.sampleWarning).toMatch(/at least 10 graded outcomes/);
  });

  test("the hit rate appears only once enough outcomes have matured", async () => {
    mockPredictions([row()], { total: "40", wrong: "4", correct: "16", pending: "20" });
    const led = await new EvidenceService().predictions();
    expect(led.hitRatePct).toBe(80);
    expect(led.sampleWarning).toBeNull();
  });

  test("the miss is signed actual − expected, in percentage points", async () => {
    mockPredictions([row()], { total: "1", wrong: "1", correct: "0", pending: "0" });
    const led = await new EvidenceService().predictions();
    // −1.9378 − 0.1354
    expect(led.rows[0].errorPct).toBeCloseTo(-2.0732, 4);
    expect(led.rows[0].grade).toBe("WRONG");
  });
});

describe("EvidenceService.bundle — the headline states the least flattering truth", () => {
  /**
   * bundle() fans out over predictions (rows + totals), calibrators,
   * governance, experiments and the cron heartbeat. `jobsHaveRun` controls
   * the last of those: with no cron rows the pipeline reads as never-run,
   * which deliberately overrides every other headline.
   */
  function mockBundle(
    totals: Record<string, string>,
    rows: Record<string, unknown>[] = [],
    jobsHaveRun = true
  ): void {
    q.mockReset();
    q.mockImplementation(async (sql: string) => {
      if (/FROM prediction_logs\b/.test(sql) && /COUNT/.test(sql)) return [totals];
      if (/FROM prediction_logs/.test(sql)) return rows;
      if (/FROM cron_execution_logs/.test(sql)) {
        if (!jobsHaveRun) return [];
        return /GROUP BY/.test(sql)
          ? [{ job_name: "evening-verify-predictions", last_run_at: new Date(), runs: "5", failures: "0" }]
          : [{ status: "success", execution_duration_ms: 1200, error_summary: null }];
      }
      return [];
    });
  }

  test("a pipeline that has NEVER run overrides every other headline", async () => {
    // Both matured predictions were wrong, but that is not the leading fact:
    // if nothing is running, no reading of the tables below is meaningful.
    mockBundle({ total: "25", wrong: "2", correct: "0", pending: "23" }, [row()], false);
    const b = await new EvidenceService().bundle();
    expect(b.pipeline.neverRun).toBe(true);
    expect(b.summary.headline).toMatch(/No scheduled job has ever run/);
    expect(b.summary.headline).toMatch(/not currently learning/);
  });

  test("once jobs have run, the heartbeat reports their last status", async () => {
    mockBundle({ total: "25", wrong: "2", correct: "0", pending: "23" }, [row()]);
    const b = await new EvidenceService().bundle();
    expect(b.pipeline.neverRun).toBe(false);
    expect(b.pipeline.jobs[0].jobName).toBe("evening-verify-predictions");
    expect(b.pipeline.jobs[0].lastStatus).toBe("success");
  });

  test("with nothing matured it refuses to claim a track record", async () => {
    mockBundle({ total: "25", wrong: "0", correct: "0", pending: "25" });
    const b = await new EvidenceService().bundle();
    expect(b.summary.headline).toMatch(/No prediction has matured yet/);
    expect(b.summary.headline).toMatch(/no track record/i);
  });

  test("when every matured call was wrong, the headline says exactly that", async () => {
    mockBundle({ total: "25", wrong: "2", correct: "0", pending: "23" }, [row()]);
    const b = await new EvidenceService().bundle();
    expect(b.summary.headline).toMatch(/Every one of the 2 matured predictions was WRONG/);
    expect(b.summary.headline).toMatch(/23 more are still pending/);
    expect(b.summary.predictionsWrong).toBe(2);
  });
});
