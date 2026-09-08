/**
 * ConditionalShortTermForecast (Parts 6/7) — a setup/regime-conditional view
 * built with hierarchical empirical-Bayes shrinkage, so a sparse
 * stock×setup cell cannot show an extreme rate. Records WHICH hierarchy level
 * supplied the estimate. PURE.
 *
 * The estimate shrinks: stock/setup → sector/setup → universe/setup. Only the
 * SHRUNK value is exposed. This is a descriptive conditional expectancy, not a
 * calibrated probability — target-vs-stop probability remains withheld unless
 * the meta-label model is promoted.
 */

import { hierarchicalShrink, ShrinkageResult } from "./shrinkage";

export interface ConditionalForecast {
  metric: "targetFirstRate" | "expectancyR";
  rawEstimate: number;
  shrunkEstimate: number;
  hierarchyLevel: "stock" | "sector" | "global";
  effectiveSample: number;
  shrinkageWeight: number;
  note: string;
}

export function conditionalEstimate(opts: {
  metric: "targetFirstRate" | "expectancyR";
  stock: { estimate: number; n: number } | null;
  sector: { estimate: number; n: number } | null;
  global: { estimate: number; n: number };
  minCellN?: number;
}): ConditionalForecast {
  const r: ShrinkageResult & { level: "stock" | "sector" | "global" } = hierarchicalShrink({
    stock: opts.stock,
    sector: opts.sector,
    global: opts.global,
    minCellN: opts.minCellN ?? 15,
    k: 25,
  });
  return {
    metric: opts.metric,
    rawEstimate: Math.round(r.rawEstimate * 1000) / 1000,
    shrunkEstimate: Math.round(r.shrunkEstimate * 1000) / 1000,
    hierarchyLevel: r.level,
    effectiveSample: r.effectiveSample,
    shrinkageWeight: r.shrinkageWeight,
    note:
      r.level === "global"
        ? "insufficient stock/sector history — using the universe-wide setup estimate (fully shrunk)"
        : `estimate supplied at the ${r.level} level, shrunk toward its parent prior`,
  };
}
