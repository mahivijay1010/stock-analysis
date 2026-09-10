import { AppDataSource } from "../../config/database";
import { FinancialFact, IntelligenceEvidence, IntelligenceMetric, IntelligenceSource, MacroObservation } from "../../entities";
import { ExtractedEvidence, MacroValue, MetricResult, NormalizedFinancialFact } from "./types";

function ensureDatabase(): void {
  if (!AppDataSource.isInitialized) throw new Error("Database is not initialized.");
}

// ── V10 B1/B3: batched read of the LATEST stored metric values ───────────────

/** Latest stored DCF scenario intrinsic values (₹/share) for a ticker. */
export interface StoredDcfScenarios {
  bear: number | null;
  base: number | null;
  bull: number | null;
  /** The quote the scenarios were computed against (may be stale). */
  priceAtCalc: number | null;
  period: string;
  calculatedAt: string; // ISO
}

/** The latest stored metric values for one ticker (nulls = not stored/valid). */
export interface StoredTickerIntelligence {
  ticker: string; // normalized (no .NS/.BO suffix)
  roe: number | null;
  roic: number | null;
  fcf: number | null;
  currentRatio: number | null;
  /** True when the stored current_ratio row is BANK_NOT_MEANINGFUL. */
  currentRatioNotMeaningful: boolean;
  peg: number | null;
  /** Latest annual revenue fact (CONSOLIDATED preferred) — for FCF margin. */
  revenue: number | null;
  dcf: StoredDcfScenarios | null;
  /** Freshness of this ticker's newest stored metric (rotation ordering). */
  latestCalculatedAt: string; // ISO
}

const QUALITY_METRICS = ["roe", "roic", "fcf", "current_ratio", "peg", "dcf"] as const;

function parseNumeric(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

export class IntelligenceRepository {
  async saveSource(input: Omit<IntelligenceSource, "id" | "retrievedAt">): Promise<IntelligenceSource> {
    ensureDatabase();
    const repository = AppDataSource.getRepository(IntelligenceSource);
    const existing = await repository.findOne({ where: { contentHash: input.contentHash } });
    if (existing) return existing;
    return repository.save(repository.create(input));
  }

  async saveFacts(sourceId: string, facts: NormalizedFinancialFact[]): Promise<void> {
    ensureDatabase();
    const repository = AppDataSource.getRepository(FinancialFact);
    for (const fact of facts) {
      const entity = repository.create({
        ticker: fact.ticker, concept: fact.concept, rawConcept: fact.rawConcept, contextId: fact.contextId,
        value: String(fact.value), currency: fact.currency, unit: fact.unit, periodStart: fact.periodStart,
        periodEnd: fact.periodEnd, periodType: fact.periodType, consolidation: fact.consolidation,
        status: fact.status, confidence: fact.confidence, sourceId, sourceUrl: fact.source.url,
        validationNotes: fact.validationNotes,
      });
      await repository.upsert(entity, ["sourceId", "rawConcept", "contextId"]);
    }
  }

  async saveMetrics(ticker: string | null, metrics: MetricResult<unknown>[]): Promise<void> {
    ensureDatabase();
    const repository = AppDataSource.getRepository(IntelligenceMetric);
    for (const metric of metrics) {
      const scalar = typeof metric.value === "number" ? String(metric.value) : null;
      await repository.save(repository.create({
        ticker, metric: metric.metric, value: scalar, valueJson: scalar == null ? metric.value : null,
        period: metric.period, formula: metric.formula, inputValues: metric.inputs,
        methodology: metric.methodology, sources: metric.sources.map((source) => ({ ...source })),
        status: metric.status, confidence: metric.confidence, reason: metric.reason ?? null,
      }));
    }
  }

  async saveEvidence(ticker: string, sourceId: string, evidence: ExtractedEvidence[]): Promise<void> {
    ensureDatabase();
    const repository = AppDataSource.getRepository(IntelligenceEvidence);
    await repository.save(evidence.map((item) => repository.create({
      ticker, category: item.category, label: item.label, value: item.value == null ? null : String(item.value),
      currency: item.currency, excerpt: item.excerpt, asOfDate: item.asOfDate, sourceId,
      sourceUrl: item.sourceUrl, status: item.status, confidence: item.confidence, metadata: item.metadata,
    })));
  }

  async saveMacro(values: MacroValue[]): Promise<void> {
    ensureDatabase();
    const repository = AppDataSource.getRepository(MacroObservation);
    for (const value of values) {
      const existing = await repository.findOne({ where: {
        indicator: value.indicator, period: value.period, sourceUrl: value.sourceUrl,
      } });
      if (existing) continue;
      await repository.save(repository.create({
        indicator: value.indicator, value: String(value.value), unit: value.unit, period: value.period,
        provider: value.provider, sourceUrl: value.sourceUrl, publicationDate: value.publicationDate ?? null,
        status: value.status, confidence: value.confidence, metadata: value.metadata ?? {},
      }));
    }
  }

  async readTicker(ticker: string): Promise<Record<string, unknown>> {
    ensureDatabase();
    const normalized = ticker.replace(/\.(NS|BO)$/i, "").toUpperCase();
    const [sources, facts, metrics, evidence] = await Promise.all([
      AppDataSource.getRepository(IntelligenceSource).find({ where: { ticker: normalized }, order: { retrievedAt: "DESC" }, take: 100 }),
      AppDataSource.getRepository(FinancialFact).find({ where: { ticker: normalized }, order: { periodEnd: "DESC" }, take: 1000 }),
      AppDataSource.getRepository(IntelligenceMetric).find({ where: { ticker: normalized }, order: { calculatedAt: "DESC" }, take: 100 }),
      AppDataSource.getRepository(IntelligenceEvidence).find({ where: { ticker: normalized }, order: { createdAt: "DESC" }, take: 100 }),
    ]);
    return { ticker: normalized, sources, facts, metrics, evidence };
  }

  async readMacro(): Promise<MacroObservation[]> {
    ensureDatabase();
    return AppDataSource.getRepository(MacroObservation).find({ order: { retrievedAt: "DESC" }, take: 250 });
  }

  /**
   * V10 B1/B3 — the LATEST stored value of each quality metric (roe, roic,
   * fcf, current_ratio, peg, dcf) per ticker, plus the latest annual revenue
   * fact (for the FCF-margin signal), in TWO batched queries total — never a
   * per-ticker loop and never an NSE fetch. Tickers with no stored metrics
   * are simply absent from the returned map (the caller falls back honestly).
   */
  async latestStoredMetrics(tickers: string[]): Promise<Map<string, StoredTickerIntelligence>> {
    ensureDatabase();
    const normalized = Array.from(
      new Set(tickers.map((t) => t.replace(/\.(NS|BO)$/i, "").toUpperCase()).filter(Boolean))
    );
    const out = new Map<string, StoredTickerIntelligence>();
    if (normalized.length === 0) return out;

    interface MetricRow {
      ticker: string;
      metric: string;
      value: string | null;
      value_json: unknown;
      methodology: string;
      status: string;
      period: string;
      calculated_at: Date | string;
    }
    // PRIMARY-FEEDS-GATES: a non-scraped (CALCULATED/RAW/EXTRACTED) value is
    // preferred over a SCRAPED one for the same metric; scraped only fills a
    // gate input when no primary value exists. Recency breaks ties within a tier.
    const metricRows: MetricRow[] = await AppDataSource.query(
      `SELECT DISTINCT ON (ticker, metric)
              ticker, metric, value, value_json, methodology, status, period, calculated_at
         FROM intelligence_metrics
        WHERE ticker = ANY($1) AND metric = ANY($2)
        ORDER BY ticker, metric, (status = 'SCRAPED') ASC, calculated_at DESC`,
      [normalized, QUALITY_METRICS as unknown as string[]]
    );

    interface RevenueRow {
      ticker: string;
      value: string | null;
    }
    const revenueRows: RevenueRow[] = await AppDataSource.query(
      `SELECT DISTINCT ON (ticker) ticker, value
         FROM financial_facts
        WHERE ticker = ANY($1) AND concept = 'revenue' AND period_type = 'ANNUAL'
        ORDER BY ticker, (consolidation = 'CONSOLIDATED') DESC, period_end DESC`,
      [normalized]
    );
    const revenueByTicker = new Map(revenueRows.map((r) => [r.ticker, parseNumeric(r.value)]));

    for (const row of metricRows) {
      let entry = out.get(row.ticker);
      if (!entry) {
        entry = {
          ticker: row.ticker,
          roe: null,
          roic: null,
          fcf: null,
          currentRatio: null,
          currentRatioNotMeaningful: false,
          peg: null,
          revenue: revenueByTicker.get(row.ticker) ?? null,
          dcf: null,
          latestCalculatedAt: toIso(row.calculated_at),
        };
        out.set(row.ticker, entry);
      }
      const calcIso = toIso(row.calculated_at);
      if (calcIso > entry.latestCalculatedAt) entry.latestCalculatedAt = calcIso;

      const calculatedValue = row.status === "CALCULATED" ? parseNumeric(row.value) : null;
      switch (row.metric) {
        case "roe":
          entry.roe = calculatedValue;
          break;
        case "roic":
          entry.roic = calculatedValue;
          break;
        case "fcf":
          entry.fcf = calculatedValue;
          break;
        case "current_ratio":
          entry.currentRatio = calculatedValue;
          entry.currentRatioNotMeaningful = row.methodology === "BANK_NOT_MEANINGFUL";
          break;
        case "peg":
          entry.peg = calculatedValue;
          break;
        case "dcf": {
          if (row.status !== "CALCULATED" || row.value_json == null) break;
          const parsed =
            typeof row.value_json === "string" ? safeJson(row.value_json) : row.value_json;
          const scenarios = (parsed as { scenarios?: Array<Record<string, unknown>> })?.scenarios;
          if (!Array.isArray(scenarios)) break;
          const level = (name: string): number | null => {
            const s = scenarios.find((x) => x.name === name);
            return s ? parseNumeric(s.intrinsicValuePerShare) : null;
          };
          const priceAtCalc = scenarios.length
            ? parseNumeric(scenarios[0].currentPrice)
            : null;
          entry.dcf = {
            bear: level("bear"),
            base: level("base"),
            bull: level("bull"),
            priceAtCalc,
            period: row.period,
            calculatedAt: calcIso,
          };
          break;
        }
      }
    }
    return out;
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
