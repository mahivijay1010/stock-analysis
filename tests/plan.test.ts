import { buildTradePlan } from "../src/services/framework/plan";

describe("probability-aligned trade plan", () => {
  test("caps an extreme structural target at the forecast upper bound", () => {
    const plan = buildTradePlan({
      entry: 84.15,
      atr14: 5.52,
      annualVolatilityPct: 45,
      recommendation: "HOLD",
      forecastConstraint: {
        horizonDays: 30,
        upperReturnPct: 7,
        label: "the bootstrap upper bound",
      },
    });

    expect(plan).not.toBeNull();
    expect(plan!.stopLoss).toBeCloseTo(73.11, 2);
    expect(plan!.target).toBeCloseTo(90.04, 2);
    expect(plan!.target).toBeLessThan(117.2);
    expect(plan!.rewardRiskRatio).toBeCloseTo(0.53, 2);
    expect(plan!.meetsRewardRisk).toBe(false);
    expect(plan!.note).toContain("capped");
    expect(plan!.note).toContain("not a qualifying 3:1 trade");
  });

  test("preserves 3:1 when the forecast envelope can contain it", () => {
    const plan = buildTradePlan({
      entry: 100,
      atr14: 2,
      annualVolatilityPct: 30,
      recommendation: "BUY",
      forecastConstraint: {
        horizonDays: 30,
        upperReturnPct: 25,
        label: "the forecast upper bound",
      },
    });

    expect(plan!.stopLoss).toBe(95);
    expect(plan!.target).toBe(115);
    expect(plan!.rewardRiskRatio).toBe(3);
    expect(plan!.meetsRewardRisk).toBe(true);
  });
});
