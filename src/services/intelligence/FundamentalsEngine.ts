/**
 * FundamentalsEngine — the fallback + merge + sanity pipeline that turns the
 * provider chain into one trustworthy scraped-ratios record.
 *
 * Behaviour:
 *  - Runs providers in priority order (Screener → Trendlyne → Tickertape).
 *  - MERGES: a field is filled by the FIRST provider that supplies a value
 *    surviving sanity — so a later source only fills gaps, never overrides a
 *    higher-priority source. (Coverage-maximizing, not first-wins-all.)
 *  - Every field passes per-field bounds + cross-field contradiction checks
 *    before it is kept; rejects are recorded, not stored.
 *  - Records which provider supplied each field (provenance).
 *  - Returns MetricResult[] ready for the existing metrics store; a stock with
 *    no usable data yields [] (honest blank), never a thrown error or a zero.
 */

import { MetricResult } from "./types";
import { FundamentalsProvider, ScrapedRatios, RATIO_FIELDS, FIELD_METRIC, ProviderResult } from "./providers/fundamentalsTypes";
import { ScreenerDataSource } from "./providers/ScreenerDataSource";
import { TrendlyneDataSource } from "./providers/TrendlyneDataSource";
import { TickertapeDataSource } from "./providers/TickertapeDataSource";
import { sanitizeRatios, crossFieldContradictions } from "./fundamentalsSanity";

export interface MergedRatios {
  values: Partial<ScrapedRatios>;
  fieldSources: Partial<Record<keyof ScrapedRatios, string>>;
  providersTried: string[];
  rejected: Array<{ field: string; value: number; reason: string; provider: string }>;
}

export class FundamentalsEngine {
  constructor(
    private readonly providers: FundamentalsProvider[] = [
      new ScreenerDataSource(),
      new TrendlyneDataSource(),
      new TickertapeDataSource(),
    ]
  ) {}

  async getRatios(ticker: string): Promise<MergedRatios> {
    const values: Partial<ScrapedRatios> = {};
    const fieldSources: Partial<Record<keyof ScrapedRatios, string>> = {};
    const providersTried: string[] = [];
    const rejected: MergedRatios["rejected"] = [];

    for (const provider of this.providers) {
      // Stop early only if EVERY field is already filled.
      if (RATIO_FIELDS.every((f) => values[f] != null)) break;
      let res: ProviderResult;
      try {
        res = await provider.fetch(ticker);
      } catch {
        providersTried.push(`${provider.name}(error)`);
        continue;
      }
      providersTried.push(provider.name);
      const { clean, rejected: rej } = sanitizeRatios(res.values);
      for (const r of rej) rejected.push({ field: String(r.field), value: r.value, reason: r.reason, provider: provider.name });
      for (const field of RATIO_FIELDS) {
        if (values[field] == null && clean[field] != null) {
          values[field] = clean[field];
          fieldSources[field] = provider.name;
        }
      }
    }

    // Cross-field contradictions on the merged record — drop offenders.
    for (const bad of crossFieldContradictions(values)) {
      if (values[bad] != null) {
        rejected.push({ field: String(bad), value: values[bad] as number, reason: "cross-field contradiction", provider: fieldSources[bad] ?? "merged" });
        delete values[bad];
        delete fieldSources[bad];
      }
    }
    return { values, fieldSources, providersTried, rejected };
  }

  /** Convert the merged record to persistable MetricResult rows (SCRAPED). */
  toMetricResults(merged: MergedRatios): MetricResult[] {
    const at = new Date().toISOString();
    const out: MetricResult[] = [];
    for (const field of RATIO_FIELDS) {
      const v = merged.values[field];
      if (v == null) continue;
      const spec = FIELD_METRIC[field];
      const provider = merged.fieldSources[field] ?? "SCRAPED";
      out.push({
        metric: spec.metric,
        value: v,
        period: at.slice(0, 10),
        formula: `scraped from ${provider}`,
        inputs: { unit: spec.unit, provider },
        methodology: `SCRAPED_${provider}`,
        sources: [{ provider, sourceLevel: 4, url: "", document: "fundamentals scrape" }],
        status: "SCRAPED",
        confidence: "MEDIUM",
        reason: "current-snapshot scrape for the live panel; NOT point-in-time, firewalled from backtests",
        calculatedAt: at,
      });
    }
    return out;
  }
}

export const fundamentalsEngine = new FundamentalsEngine();
