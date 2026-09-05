import { DcfOutput, DcfScenarioAssumptions, DcfScenarioResult, MetricResult, SourceRef } from "./types";

const round = (v: number, digits = 4): number => Number(v.toFixed(digits));

export const DEFAULT_DCF_SCENARIOS: DcfScenarioAssumptions[] = [
  { name: "bear", fcfGrowthPct: 4, waccPct: 13, terminalGrowthPct: 3, forecastYears: 5 },
  { name: "base", fcfGrowthPct: 8, waccPct: 11, terminalGrowthPct: 4, forecastYears: 5 },
  { name: "bull", fcfGrowthPct: 12, waccPct: 10, terminalGrowthPct: 5, forecastYears: 5 },
];

export interface DcfInputs {
  latestFcf: number;
  debt: number;
  cash: number;
  sharesOutstanding: number;
  currentPrice?: number | null;
  period: string;
  sources?: SourceRef[];
}

export function runDcfScenario(
  inputs: DcfInputs,
  assumptions: DcfScenarioAssumptions
): DcfScenarioResult {
  const forecastYears = assumptions.forecastYears ?? 5;
  const growth = assumptions.fcfGrowthPct / 100;
  const wacc = assumptions.waccPct / 100;
  const terminalGrowth = assumptions.terminalGrowthPct / 100;
  if (![inputs.latestFcf, inputs.debt, inputs.cash, inputs.sharesOutstanding].every(Number.isFinite)) {
    throw new Error("DCF inputs must be finite numbers.");
  }
  if (inputs.latestFcf <= 0) throw new Error("DCF requires positive normalized FCF.");
  if (inputs.sharesOutstanding <= 0) throw new Error("DCF shares outstanding must be positive.");
  if (forecastYears < 1 || forecastYears > 20) throw new Error("DCF forecastYears must be between 1 and 20.");
  if (wacc <= terminalGrowth) throw new Error("DCF terminal growth must be lower than WACC.");
  if (wacc <= 0 || assumptions.waccPct > 100) throw new Error("DCF WACC must be in (0, 100].");

  const projectedFcf: number[] = [];
  let fcf = inputs.latestFcf;
  let pvForecastFcf = 0;
  for (let year = 1; year <= forecastYears; year++) {
    fcf *= 1 + growth;
    projectedFcf.push(round(fcf, 2));
    pvForecastFcf += fcf / Math.pow(1 + wacc, year);
  }
  const terminalValue = (fcf * (1 + terminalGrowth)) / (wacc - terminalGrowth);
  const pvTerminalValue = terminalValue / Math.pow(1 + wacc, forecastYears);
  const enterpriseValue = pvForecastFcf + pvTerminalValue;
  const equityValue = enterpriseValue - inputs.debt + inputs.cash;
  const intrinsicValuePerShare = equityValue / inputs.sharesOutstanding;
  const marginOfSafetyPct = inputs.currentPrice && inputs.currentPrice > 0
    ? ((intrinsicValuePerShare / inputs.currentPrice) - 1) * 100
    : null;

  return {
    name: assumptions.name,
    assumptions: { ...assumptions, forecastYears },
    projectedFcf,
    pvForecastFcf: round(pvForecastFcf, 2),
    terminalValue: round(terminalValue, 2),
    pvTerminalValue: round(pvTerminalValue, 2),
    enterpriseValue: round(enterpriseValue, 2),
    equityValue: round(equityValue, 2),
    intrinsicValuePerShare: round(intrinsicValuePerShare, 2),
    currentPrice: inputs.currentPrice ?? null,
    marginOfSafetyPct: marginOfSafetyPct == null ? null : round(marginOfSafetyPct),
  };
}

export function calculateDcf(
  inputs: DcfInputs | null,
  scenarios: DcfScenarioAssumptions[] = DEFAULT_DCF_SCENARIOS
): MetricResult<DcfOutput> {
  const formula = "PV(forecast FCF) + PV(terminal value) - debt + cash; divided by shares";
  if (!inputs) {
    return {
      metric: "dcf", value: null, period: "UNKNOWN", formula, inputs: {}, methodology: "FCFF_SCENARIO_DCF",
      sources: [], status: "NOT_AVAILABLE", confidence: "LOW", reason: "FCF, debt, cash and shares are required.", calculatedAt: new Date().toISOString(),
    };
  }
  try {
    const results = scenarios.map((s) => runDcfScenario(inputs, s));
    const base = scenarios.find((s) => s.name === "base") ?? scenarios[0];
    const sensitivity: DcfOutput["sensitivity"] = [];
    for (const waccDelta of [-2, -1, 0, 1, 2]) {
      for (const terminalDelta of [-1, 0, 1]) {
        const assumption = {
          ...base,
          name: `wacc_${base.waccPct + waccDelta}_tg_${base.terminalGrowthPct + terminalDelta}`,
          waccPct: base.waccPct + waccDelta,
          terminalGrowthPct: base.terminalGrowthPct + terminalDelta,
        };
        if (assumption.terminalGrowthPct >= assumption.waccPct) continue;
        const r = runDcfScenario(inputs, assumption);
        sensitivity.push({
          waccPct: assumption.waccPct,
          terminalGrowthPct: assumption.terminalGrowthPct,
          intrinsicValuePerShare: r.intrinsicValuePerShare,
        });
      }
    }
    return {
      metric: "dcf",
      value: { scenarios: results, sensitivity },
      period: inputs.period,
      formula,
      inputs: {
        latest_fcf: inputs.latestFcf, debt: inputs.debt, cash: inputs.cash,
        shares_outstanding: inputs.sharesOutstanding, current_price: inputs.currentPrice ?? null,
      },
      methodology: "FCFF_SCENARIO_DCF",
      sources: inputs.sources ?? [],
      status: "CALCULATED",
      confidence: "MEDIUM",
      reason: "DCF is assumption-sensitive; bear/base/bull outputs are estimates, not objective truth.",
      calculatedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      metric: "dcf", value: null, period: inputs.period, formula, inputs: { ...inputs }, methodology: "FCFF_SCENARIO_DCF",
      sources: inputs.sources ?? [], status: "NOT_AVAILABLE", confidence: "LOW",
      reason: error instanceof Error ? error.message : "Invalid DCF inputs.", calculatedAt: new Date().toISOString(),
    };
  }
}
