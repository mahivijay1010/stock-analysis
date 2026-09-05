import { Confidence, DataStatus, ExtractedEvidence, MetricResult } from "./types";

export interface StructuredQualitativeProvider {
  analyze(input: {
    kind: "MOAT" | "MANAGEMENT" | "MACRO_STANCE" | "INDUSTRY_TAM";
    evidence: ExtractedEvidence[];
    requiredDimensions: string[];
  }): Promise<{
    score: number | null;
    dimensions: Array<{ name: string; score: number | null; reason: string; evidenceIndexes: number[] }>;
    summary: string;
    confidence: Confidence;
  }>;
}

export class QualitativeAnalysisService {
  constructor(private readonly provider?: StructuredQualitativeProvider) {}

  async analyze(
    ticker: string,
    kind: "MOAT" | "MANAGEMENT" | "MACRO_STANCE" | "INDUSTRY_TAM",
    evidence: ExtractedEvidence[],
    period: string
  ): Promise<MetricResult<Record<string, unknown>>> {
    const dimensions = kind === "MOAT"
      ? ["brand", "switching_costs", "network_effects", "cost_advantage", "scale", "distribution", "ip", "regulatory_advantage", "customer_stickiness", "competitive_intensity"]
      : kind === "MANAGEMENT"
        ? ["growth", "returns", "cash_flow", "debt", "dilution", "capital_allocation", "governance"]
        : kind === "INDUSTRY_TAM"
          ? ["low", "base", "high", "cagr", "source_count", "risks"]
          : ["policy_direction", "inflation", "growth", "liquidity"];
    const base = {
      metric: kind.toLowerCase(), period, formula: null, inputs: { evidence_count: evidence.length },
      methodology: "EVIDENCE_BACKED_STRUCTURED_AI", sources: evidence.map((e) => ({ provider: "DOCUMENT", sourceLevel: 2 as const, url: e.sourceUrl })),
      calculatedAt: new Date().toISOString(),
    };
    if (evidence.length === 0 || !this.provider) {
      return {
        ...base,
        value: null,
        status: "NOT_AVAILABLE" as DataStatus,
        confidence: "LOW",
        reason: evidence.length === 0
          ? "No reliable public evidence was collected."
          : "Evidence is available but no structured AI provider is configured.",
      };
    }
    const result = await this.provider.analyze({ kind, evidence, requiredDimensions: dimensions });
    return {
      ...base,
      value: { ticker, ...result },
      status: "AI_ANALYSIS",
      confidence: result.confidence,
    };
  }
}
