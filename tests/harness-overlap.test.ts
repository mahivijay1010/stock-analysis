/**
 * Regression test for docs/system-trust-review.md §4.6: harness.ts's
 * metricsFor() used to compute effectiveSamples as
 * floor(preds.length / tradingDayOffset) — but `preds` is a POOLED
 * cross-sectional array (many tickers per date), so this over-counted
 * independent observations by roughly the ticker count. A 30d horizon with
 * 40 tickers over 100 dates reported ~190 "effective samples" from ~5 truly
 * independent (non-overlapping) windows.
 *
 * The correct divisor — matching decision/policy.ts's effectiveSamples() and
 * monitoring/ModelHealthService.ts's `effective` — is DISTINCT DATES divided
 * by the horizon's trading-day overlap, not the pooled row count.
 */

import { metricsFor, H_TD, PredRecord } from "../src/services/research/harness";
import { ModelOutput } from "../src/services/research/models";

function mkPred(ticker: string, date: string, target: number): PredRecord {
  const output: ModelOutput = {
    modelName: "test-model",
    modelVersion: "v1",
    horizonDays: 30,
    expectedReturn: 0.01,
    medianReturn: 0.01,
    quantiles: { p10: -0.02, p50: 0.01, p90: 0.04 },
    rawDirectionProbability: 0.55,
    featureTimestamp: date,
    trainingEndDate: date,
  };
  return { ticker, date, target, output };
}

describe("harness.metricsFor — overlap-adjusted effectiveSamples", () => {
  test("dividing by distinct dates, not pooled rows, at 30d horizon", () => {
    const h = 30;
    const td = H_TD[h]; // 21
    const tickers = Array.from({ length: 40 }, (_, i) => `T${i}`);
    const dates = Array.from({ length: 100 }, (_, i) => `2026-01-${String((i % 28) + 1).padStart(2, "0")}-${Math.floor(i / 28)}`);

    // 40 tickers x 100 dates = 4000 pooled rows, but only 100 distinct dates.
    const preds: PredRecord[] = [];
    for (const d of dates) for (const t of tickers) preds.push(mkPred(t, d, 0.01));

    const m = metricsFor("test-model", "v1", h, preds, []);

    expect(m.rawSamples).toBe(4000);
    // OLD (buggy) behaviour would have been floor(4000 / 21) = 190.
    const buggyValue = Math.floor(preds.length / td);
    expect(buggyValue).toBe(190);
    // CORRECT behaviour: floor(distinctDates / 21) = floor(100 / 21) = 4.
    expect(m.effectiveSamples).toBe(4);
    expect(m.effectiveSamples).not.toBe(buggyValue);
  });

  test("a single date with many tickers yields effectiveSamples = 1, not the ticker count", () => {
    const h = 1;
    const preds: PredRecord[] = Array.from({ length: 50 }, (_, i) => mkPred(`T${i}`, "2026-01-01", 0.01));
    const m = metricsFor("test-model", "v1", h, preds, []);
    expect(m.rawSamples).toBe(50);
    expect(m.effectiveSamples).toBe(1); // floor(1 distinct date / 1 td) = 1, not 50
  });

  test("many distinct dates with one ticker each still divides by the horizon overlap correctly", () => {
    const h = 7;
    const td = H_TD[h]; // 5
    const preds: PredRecord[] = Array.from({ length: 23 }, (_, i) => mkPred("SOLO", `2026-01-${String(i + 1).padStart(2, "0")}`, 0.01));
    const m = metricsFor("test-model", "v1", h, preds, []);
    expect(m.rawSamples).toBe(23);
    expect(m.effectiveSamples).toBe(Math.floor(23 / td)); // 4 — same as the old formula here, since 1 row per date
  });

  test("effectiveSamples is never zero even with fewer distinct dates than the horizon overlap", () => {
    const h = 30;
    const preds: PredRecord[] = [mkPred("A", "2026-01-01", 0.01), mkPred("B", "2026-01-01", 0.01)];
    const m = metricsFor("test-model", "v1", h, preds, []);
    expect(m.effectiveSamples).toBeGreaterThanOrEqual(1);
  });
});
