/**
 * Phase 8 tests — ensemble eligibility is a hard gate (validation-only
 * evidence), weights are OOS-derived and normalized, and the ensemble
 * ABSTAINS rather than inventing a forecast when nothing qualifies.
 */

import { buildEnsemble, combineOutputs, ENSEMBLE_ELIGIBILITY } from "../src/services/research/ensemble";
import { PredRecord } from "../src/services/research/harness";
import { ModelOutput } from "../src/services/research/models";

function preds(model: string, n: number, prob: (i: number) => number, target: (i: number) => number): PredRecord[] {
  const rows: PredRecord[] = [];
  for (let i = 0; i < n; i++) {
    const date = new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
    rows.push({
      ticker: "TEST.NS",
      date,
      target: target(i),
      output: {
        modelName: model,
        modelVersion: "t",
        horizonDays: 1,
        expectedReturn: null,
        medianReturn: null,
        quantiles: null,
        rawDirectionProbability: prob(i),
        featureTimestamp: `${date}T15:40:00+05:30`,
        trainingEndDate: "2024-12-31",
      },
    });
  }
  return rows;
}

const out = (model: string, prob: number | null, er: number | null = null): ModelOutput => ({
  modelName: model,
  modelVersion: "t",
  horizonDays: 1,
  expectedReturn: er,
  medianReturn: null,
  quantiles: null,
  rawDirectionProbability: prob,
  featureTimestamp: "2025-06-01T15:40:00+05:30",
  trainingEndDate: "2024-12-31",
});

describe("buildEnsemble — eligibility (validation evidence only)", () => {
  test("excludes confidently-wrong models (Brier above the constant-50 floor + tolerance)", () => {
    const good = preds("good", 60, () => 0.5, (i) => (i % 2 === 0 ? 0.01 : -0.01));
    const bad = preds("bad", 60, (i) => (i % 2 === 0 ? 0.05 : 0.95), (i) => (i % 2 === 0 ? 0.01 : -0.01));
    const spec = buildEnsemble({ good, bad }, 1, 1);
    expect(spec.members.map((m) => m.model)).toEqual(["good"]);
    expect(spec.excluded.find((x) => x.model === "bad")?.reason).toMatch(/confidently wrong/);
  });

  test("excludes models below the effective-sample floor (overlap-adjusted)", () => {
    // 60 daily points but 21-day overlap ⇒ ~2 independent obs < 10.
    const m = preds("thin", 60, () => 0.5, () => 0.01);
    const spec = buildEnsemble({ thin: m }, 30, 21);
    expect(spec.members).toHaveLength(0);
    expect(spec.excluded[0].reason).toMatch(/independent validation obs/);
  });

  test("excludes models that emit no direction probability", () => {
    const m = preds("noprob", 60, () => 0.5, () => 0.01).map((p) => ({
      ...p,
      output: { ...p.output, rawDirectionProbability: null },
    }));
    const spec = buildEnsemble({ noprob: m }, 1, 1);
    expect(spec.members).toHaveLength(0);
    expect(spec.excluded[0].reason).toMatch(/no direction probability/);
  });

  test("weights are normalized and never negative, even for zero-skill members", () => {
    // a: constant 0.5, 50% up ⇒ Brier .25 (zero skill), ECE 0 — eligible.
    // b: constant 0.6, 60% up ⇒ Brier .24 (some skill), ECE 0 — eligible.
    const a = preds("a", 60, () => 0.5, (i) => (i % 2 === 0 ? 0.01 : -0.01));
    const b = preds("b", 60, () => 0.6, (i) => (i % 5 < 3 ? 0.01 : -0.01));
    const spec = buildEnsemble({ a, b }, 1, 1);
    expect(spec.members).toHaveLength(2);
    const total = spec.members.reduce((s, m) => s + m.weight, 0);
    expect(total).toBeCloseTo(1, 3);
    for (const m of spec.members) expect(m.weight).toBeGreaterThan(0);
    const wa = spec.members.find((m) => m.model === "a")!.weight;
    const wb = spec.members.find((m) => m.model === "b")!.weight;
    expect(wb).toBeGreaterThan(wa); // better validation Brier ⇒ more weight
  });
});

describe("combineOutputs — abstention and weighted combination", () => {
  test("abstains (null) when the spec has no members", () => {
    const spec = buildEnsemble({}, 1, 1);
    expect(spec.members).toHaveLength(0);
    expect(combineOutputs(spec, {}, "2025-06-01T15:40:00+05:30")).toBeNull();
  });

  test("abstains when no member produced an output for the row", () => {
    const a = preds("a", 60, () => 0.6, (i) => (i % 5 < 3 ? 0.01 : -0.01));
    const spec = buildEnsemble({ a }, 1, 1);
    expect(spec.members).toHaveLength(1);
    expect(combineOutputs(spec, { a: undefined }, "2025-06-01T15:40:00+05:30")).toBeNull();
  });

  test("weighted mean of member probabilities, labeled ensemble-global", () => {
    const a = preds("a", 60, () => 0.6, (i) => (i % 5 < 3 ? 0.01 : -0.01));
    const b = preds("b", 60, () => 0.6, (i) => (i % 5 < 3 ? 0.01 : -0.01));
    const spec = buildEnsemble({ a, b }, 1, 1);
    const o = combineOutputs(spec, { a: out("a", 0.6, 0.01), b: out("b", 0.4, -0.01) }, "2025-06-01T15:40:00+05:30");
    expect(o).not.toBeNull();
    expect(o!.modelName).toBe("ensemble-global");
    // equal weights ⇒ midpoint
    expect(o!.rawDirectionProbability).toBeCloseTo(0.5, 2);
    expect(o!.expectedReturn).toBeCloseTo(0, 3);
  });

  test("eligibility constants are the documented hard gate", () => {
    expect(ENSEMBLE_ELIGIBILITY.minValEffSamples).toBe(10);
    expect(ENSEMBLE_ELIGIBILITY.maxValBrier).toBe(0.26);
    expect(ENSEMBLE_ELIGIBILITY.maxValEce).toBe(0.1);
  });
});
