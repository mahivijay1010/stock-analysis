/**
 * ScoreCard tests (risk-spec Rule 1, 11; remediation plan S1) — the separated
 * scores, missing-data penalties, and the evidence caps on "opportunity".
 */

import {
  buildScoreCard,
  computeDataQualityScore,
  computeForecastConfidence,
  computeRiskScore,
  ScoreCardInputs,
} from "../src/services/decision/scorecard";

describe("computeRiskScore — one formula replaces three inconsistent labels", () => {
  test("missing vol or drawdown → null score, unknown band (never a fabricated middle)", () => {
    expect(computeRiskScore({ annualVolPct: null, maxDrawdownPct1y: 20 }).band).toBe("unknown");
    expect(computeRiskScore({ annualVolPct: 30, maxDrawdownPct1y: null }).score).toBeNull();
  });

  test("calm large-cap shape → low; the BHEL shape (36% vol, 20% dd) → medium", () => {
    expect(computeRiskScore({ annualVolPct: 18, maxDrawdownPct1y: 15 }).band).toBe("low");
    const bhel = computeRiskScore({ annualVolPct: 36, maxDrawdownPct1y: 20 });
    expect(bhel.band).toBe("medium");
    expect(bhel.score).toBeGreaterThan(25);
    expect(bhel.score).toBeLessThan(60);
  });

  test("extreme vol + drawdown → high, above the policy veto line", () => {
    const r = computeRiskScore({ annualVolPct: 65, maxDrawdownPct1y: 55 });
    expect(r.band).toBe("high");
    expect(r.score).toBeGreaterThanOrEqual(80);
  });

  test("illiquidity adds risk, itemized", () => {
    const thin = computeRiskScore({ annualVolPct: 30, maxDrawdownPct1y: 25, medianDailyTurnover: 5_000_000 });
    const liquid = computeRiskScore({ annualVolPct: 30, maxDrawdownPct1y: 25, medianDailyTurnover: 500_000_000 });
    expect(thin.score! - liquid.score!).toBe(10);
    expect(thin.reasons.join(" ")).toMatch(/liquidity/i);
  });
});

describe("computeDataQualityScore — missing inputs are penalties, never neutral (Rule 11)", () => {
  const complete = {
    barCount: 500,
    barsSource: "yahoo",
    barStalenessDays: 0,
    suspectedCorporateActionBreak: false,
    fundamentalsAvailable: true,
    fundamentalsCompleteness: 0.9,
    filingsMetricsAvailable: true,
    newsAvailable: true,
  };

  test("complete inputs → 100, zero penalties", () => {
    const d = computeDataQualityScore(complete);
    expect(d.score).toBe(100);
    expect(d.penalties).toHaveLength(0);
  });

  test("every deduction is itemized — nothing silent", () => {
    const d = computeDataQualityScore({
      ...complete,
      barsSource: "db-stale",
      fundamentalsAvailable: false,
      filingsMetricsAvailable: false,
      newsAvailable: false,
    });
    expect(d.score).toBe(100 - 20 - 15 - 10 - 5);
    expect(d.penalties).toHaveLength(4);
    d.penalties.forEach((p) => expect(p).toMatch(/^−\d+: /));
  });

  test("a suspected unadjusted corporate action is a first-class penalty (audit §9.1)", () => {
    const d = computeDataQualityScore({ ...complete, suspectedCorporateActionBreak: true });
    expect(d.score).toBe(80);
    expect(d.penalties[0]).toMatch(/UNADJUSTED corporate action/);
  });

  test("incomplete fundamentals penalized even when 'available'", () => {
    const d = computeDataQualityScore({ ...complete, fundamentalsCompleteness: 0.4 });
    expect(d.score).toBe(90);
    expect(d.penalties[0]).toMatch(/NOT neutral/);
  });
});

describe("computeForecastConfidence — measured out-of-sample evidence only", () => {
  test("no record at all → 0, LOW", () => {
    const f = computeForecastConfidence({ brier: null, rawSamples: null, overlapDays: 30, bandCoveragePct: null, stabilityDelta: null });
    expect(f.score).toBe(0);
    expect(f.band).toBe("LOW");
  });

  test("TODAY'S system record (Brier 0.2533, 39 raw ≈ 1 independent) → LOW — the honest answer", () => {
    const f = computeForecastConfidence({ brier: 0.2533, rawSamples: 39, overlapDays: 30, bandCoveragePct: 85.2, stabilityDelta: null });
    expect(f.band).toBe("LOW");
    expect(f.brierSkill).toBeLessThan(0);
    expect(f.effectiveSamples).toBe(1);
    expect(f.reasons.join(" ")).toMatch(/no measured edge over a constant 50%/i);
  });

  test("a genuinely strong validated record can reach HIGH — the scale is not rigged shut", () => {
    const f = computeForecastConfidence({ brier: 0.2, rawSamples: 3000, overlapDays: 30, bandCoveragePct: 81, stabilityDelta: 0.004 });
    expect(f.brierSkill).toBeCloseTo(0.05, 4);
    expect(f.band).toBe("HIGH");
  });

  test("negative skill earns zero skill points regardless of sample size", () => {
    const f = computeForecastConfidence({ brier: 0.26, rawSamples: 30000, overlapDays: 30, bandCoveragePct: 80, stabilityDelta: 0.001 });
    expect(f.score).toBeLessThan(65); // no skill points: 0 + 30 + 20 + 10 = 60 max
  });
});

describe("buildScoreCard — opportunity is capped by evidence, never a probability", () => {
  const inputs = (over?: Partial<ScoreCardInputs>): ScoreCardInputs => ({
    setupScore: 79,
    momentumScore: 75,
    valuationScore: 33,
    fundamentalScore: 60,
    businessQualityScore: null,
    entryTimingScore: 38,
    risk: { annualVolPct: 36, maxDrawdownPct1y: 20 },
    dataQuality: {
      barCount: 500,
      barsSource: "yahoo",
      barStalenessDays: 0,
      suspectedCorporateActionBreak: false,
      fundamentalsAvailable: true,
      fundamentalsCompleteness: 0.5,
      filingsMetricsAvailable: false,
      newsAvailable: true,
    },
    forecastConfidence: { brier: 0.2533, rawSamples: 39, overlapDays: 30, bandCoveragePct: 85, stabilityDelta: null },
    ...over,
  });

  test("the BHEL shape: setup 79 but opportunity is dragged far below it by LOW confidence", () => {
    const card = buildScoreCard(inputs());
    expect(card.setupScore).toBe(79);
    expect(card.forecastConfidence.band).toBe("LOW");
    expect(card.overallOpportunityScore).not.toBeNull();
    expect(card.overallOpportunityScore!).toBeLessThan(card.setupScore!);
    expect(card.caption).toMatch(/No score on this card is a probability/i);
    expect(card.caption).toMatch(/measured out-of-sample performance only — not the setup score/i);
  });

  test("fewer than 2 descriptive scores → opportunity null (not fabricated)", () => {
    const card = buildScoreCard(
      inputs({ setupScore: 79, valuationScore: null, fundamentalScore: null, businessQualityScore: null, entryTimingScore: null })
    );
    expect(card.overallOpportunityScore).toBeNull();
  });

  test("technicalScore is an alias of setupScore — one formula, stated", () => {
    const card = buildScoreCard(inputs());
    expect(card.technicalScore).toBe(card.setupScore);
  });
});
