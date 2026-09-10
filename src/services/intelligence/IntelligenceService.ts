import { createHash } from "crypto";
import { AppDataSource } from "../../config/database";
import { fundamentalsService } from "../market/FundamentalsService";
import { marketDataService } from "../market/MarketDataService";
import { calculateCurrentRatio, calculateFcf, calculateGrowth, calculatePeg, calculateRoce, calculateRoe, calculateRoic, calculateWorkingCapital, evaluateRules } from "./calculations";
import { calculateDcf } from "./dcf";
import { extractDocumentEvidence } from "./documentExtraction";
import { calculateCorrelationMatrix, calculatePortfolioExposure, CorrelationWindow, PortfolioAnalyticsPosition } from "./portfolioAnalytics";
import { IntelligenceRepository } from "./IntelligenceRepository";
import { BSEDataSource } from "./providers/BSEDataSource";
import { CompanyDocumentSource } from "./providers/CompanyDocumentSource";
import { MoSPIDataSource } from "./providers/MoSPIDataSource";
import { NSEDataSource } from "./providers/NSEDataSource";
import { RBIDataSource } from "./providers/RBIDataSource";
import { FredDataSource } from "./providers/FredDataSource";
import { ScreenerDataSource } from "./providers/ScreenerDataSource";
import { AnnualFinancials, CoverageRow, CrossCheck, DataStatus, FilingDocument, MetricResult, NormalizedFinancialFact, SourceRef } from "./types";
import { buildAnnualSeries, normalizeXbrl } from "./xbrl";

const BANKS = /^(HDFCBANK|ICICIBANK|AXISBANK|KOTAKBANK|SBIN|INDUSINDBK|FEDERALBNK|BANDHANBNK|IDFCFIRSTB|AUBANK)$/;

export interface RefreshOptions {
  years?: number;
  bseCode?: string;
  irPageUrl?: string;
  persist?: boolean;
}

function scalar(metric: MetricResult<unknown>): number | null {
  return typeof metric.value === "number" && Number.isFinite(metric.value) ? metric.value : null;
}

function unavailable(metric: string, period: string, reason: string, methodology: string): MetricResult {
  return { metric, value: null, period, formula: null, inputs: {}, methodology, sources: [],
    status: "NOT_AVAILABLE", confidence: "LOW", reason, calculatedAt: new Date().toISOString() };
}

export class IntelligenceService {
  constructor(
    private readonly nse = new NSEDataSource(),
    private readonly bse = new BSEDataSource(),
    private readonly rbi = new RBIDataSource(),
    private readonly mospi = new MoSPIDataSource(),
    private readonly fred = new FredDataSource(),
    private readonly screener = new ScreenerDataSource(),
    private readonly documents = new CompanyDocumentSource(),
    private readonly repository = new IntelligenceRepository()
  ) {}

  async refreshTicker(inputTicker: string, options: RefreshOptions = {}): Promise<Record<string, unknown>> {
    const ticker = inputTicker.replace(/\.(NS|BO)$/i, "").toUpperCase();
    if (!/^[A-Z0-9&-]{1,20}$/.test(ticker)) throw new Error("Invalid Indian equity ticker.");
    const persist = options.persist !== false && AppDataSource.isInitialized;
    const filings = await this.nse.listFinancialFilings(ticker, Math.min(Math.max(options.years ?? 7, 1), 15));
    const facts: NormalizedFinancialFact[] = [];
    const errors: Array<{ source: string; error: string }> = [];

    for (const filing of filings.slice(0, 16)) {
      try {
        const downloaded = await this.nse.downloadStructuredFiling(filing);
        const sourceRef: SourceRef = { provider: "NSE", sourceLevel: 1, url: filing.xbrlUrl!,
          document: filing.title, publishedAt: filing.publishedAt ?? null };
        let sourceId: string | undefined;
        if (persist) {
          const source = await this.repository.saveSource({
            ticker, provider: "NSE", sourceLevel: 1, documentType: filing.documentType,
            sourceUrl: filing.xbrlUrl!, sourceDocument: filing.title, contentHash: downloaded.contentHash,
            mediaType: "application/xml", cachePath: downloaded.cachePath, rawPayload: filing.metadata,
            publishedAt: filing.publishedAt ? new Date(filing.publishedAt) : null,
          });
          sourceId = source.id;
          sourceRef.sourceId = source.id;
        }
        const normalized = normalizeXbrl(downloaded.xml, { ticker, consolidation: filing.consolidation, source: sourceRef });
        facts.push(...normalized);
        if (persist && sourceId) await this.repository.saveFacts(sourceId, normalized);
      } catch (error) {
        errors.push({ source: filing.xbrlUrl ?? filing.url, error: error instanceof Error ? error.message : String(error) });
      }
    }

    const preferred = buildAnnualSeries(facts, "CONSOLIDATED");
    const series = preferred.length > 0 ? preferred : buildAnnualSeries(facts, "STANDALONE");
    const consolidation = preferred.length > 0 ? "CONSOLIDATED" : series.length > 0 ? "STANDALONE" : "UNKNOWN";
    const latest = series[0];
    const previous = series[1] ?? null;
    const kind = BANKS.test(ticker) ? "BANK" : "NON_FINANCIAL";
    const coreMetrics: MetricResult<unknown>[] = latest ? [
      calculateRoe(latest, previous), calculateRoic(latest, previous, kind), calculateFcf(latest),
      calculateCurrentRatio(latest, kind), calculateGrowth(series),
      calculateRoce(latest, previous, kind), calculateWorkingCapital(latest, kind),
    ] : [
      unavailable("roe", "UNKNOWN", "No comparable annual XBRL series.", "AVERAGE_EQUITY"),
      unavailable("roic", "UNKNOWN", "No comparable annual XBRL series.", "NOPAT_AVERAGE_INVESTED_CAPITAL"),
      unavailable("fcf", "UNKNOWN", "No annual CFO/CapEx XBRL facts.", "CFO_LESS_CAPEX"),
      unavailable("current_ratio", "UNKNOWN", "No annual balance-sheet XBRL facts.", "STANDARD"),
      unavailable("earnings_growth", "UNKNOWN", "No comparable annual XBRL series.", "HISTORICAL_ACTUALS"),
      unavailable("roce", "UNKNOWN", "No comparable annual XBRL series.", "EBIT_AVERAGE_CAPITAL_EMPLOYED"),
      unavailable("working_capital", "UNKNOWN", "No annual balance-sheet XBRL facts.", "STANDARD"),
    ];

    let quote: Awaited<ReturnType<typeof marketDataService.getQuote>> | null = null;
    let fundamentals: Awaited<ReturnType<typeof fundamentalsService.getFundamentals>> | null = null;
    try { quote = await marketDataService.getQuote(`${ticker}.NS`); } catch (error) { errors.push({ source: "Yahoo quote", error: error instanceof Error ? error.message : String(error) }); }
    try { fundamentals = await fundamentalsService.getFundamentals(`${ticker}.NS`); } catch (error) { errors.push({ source: "Yahoo fundamentals", error: error instanceof Error ? error.message : String(error) }); }
    const growth = coreMetrics.find((m) => m.metric === "earnings_growth") as ReturnType<typeof calculateGrowth>;
    const peg = calculatePeg(fundamentals?.trailingPE ?? null, growth);
    if (fundamentals) peg.sources.push({ provider: "Yahoo Finance", sourceLevel: 4, url: "https://finance.yahoo.com/", document: "quoteSummary" });
    coreMetrics.push(peg);

    const fcf = coreMetrics.find((m) => m.metric === "fcf");
    const shares = fundamentals?.marketCap && quote?.price ? fundamentals.marketCap / quote.price : null;
    const dcf = kind === "BANK"
      ? unavailable("dcf", latest?.period ?? "UNKNOWN", "FCFF DCF is not valid for a bank; use a bank-specific excess-return model.", "BANK_NOT_MEANINGFUL")
      : calculateDcf(latest && scalar(fcf!) != null && latest.grossDebt != null && latest.cash != null && shares
        ? { latestFcf: scalar(fcf!)!, debt: latest.grossDebt, cash: latest.cash, sharesOutstanding: shares,
          currentPrice: quote?.price ?? null, period: latest.period,
          sources: [...latest.sources, { provider: "Yahoo Finance", sourceLevel: 4, url: "https://finance.yahoo.com/", document: "market cap/current price" }] }
        : null);
    coreMetrics.push(dcf);

    const evidence = [] as ReturnType<typeof extractDocumentEvidence>;
    if (options.irPageUrl) {
      try {
        const docs = await this.documents.discover(ticker, options.irPageUrl);
        for (const doc of docs.slice(0, 8)) {
          const extracted = await this.documents.extractText(doc);
          const found = extractDocumentEvidence(extracted.text, doc.url);
          evidence.push(...found);
          if (persist) {
            const source = await this.repository.saveSource({ ticker, provider: "COMPANY_IR", sourceLevel: 2,
              documentType: doc.documentType, sourceUrl: doc.url, sourceDocument: doc.title,
              contentHash: extracted.contentHash, mediaType: "application/pdf", cachePath: extracted.cachePath,
              rawPayload: doc.metadata, publishedAt: null });
            await this.repository.saveEvidence(ticker, source.id, found);
          }
        }
      } catch (error) { errors.push({ source: options.irPageUrl, error: error instanceof Error ? error.message : String(error) }); }
    }

    const crossChecks = await this.crossCheckBse(ticker, options.bseCode, latest, errors);
    const ruleMetrics = {
      roe: scalar(coreMetrics.find((m) => m.metric === "roe")!), roic: scalar(coreMetrics.find((m) => m.metric === "roic")!),
      earningsGrowth: growth.value?.epsCagr3yPct ?? growth.value?.epsYoyPct ?? null, fcf: scalar(fcf!),
      currentRatio: scalar(coreMetrics.find((m) => m.metric === "current_ratio")!), peg: scalar(peg),
    };
    const rules = evaluateRules(ruleMetrics);
    if (persist) await this.repository.saveMetrics(ticker, coreMetrics);
    // Scraped panel ratios (Screener) — fills the display for stocks XBRL
    // leaves blank; persisted to the METRICS store only, never to
    // financial_facts (backtest firewall). Non-blocking.
    let scraped: MetricResult[] = [];
    try {
      scraped = await this.screener.fetchRatios(ticker);
      if (persist && scraped.length > 0) await this.repository.saveMetrics(ticker, scraped);
    } catch (error) {
      errors.push({ source: "Screener.in", error: error instanceof Error ? error.message : String(error) });
    }
    const coverage = this.coverage(coreMetrics, series, evidence, crossChecks);
    return { ticker, industryKind: kind, consolidation, filingsFound: filings.length, annualSeries: series,
      metrics: coreMetrics, scrapedRatios: scraped, rules, evidence, crossChecks, coverage, errors, refreshedAt: new Date().toISOString() };
  }

  async refreshMacro(): Promise<Record<string, unknown>> {
    // MoSPI is CONFIG-GATED (upgrade-audit R15): without MOSPI_API_TOKEN the
    // adapter can only return an empty payload, so the network probe is
    // skipped entirely and reported honestly instead of silently fetched.
    const mospiEnabled = Boolean(process.env.MOSPI_API_TOKEN);
    const fredEnabled = this.fred.isConfigured();
    const providers = [
      { name: "RBI", run: () => this.rbi.fetchCurrent() },
      ...(mospiEnabled ? [{ name: "MOSPI", run: () => this.mospi.fetchCurrent() }] : []),
      ...(fredEnabled ? [{ name: "FRED", run: () => this.fred.fetchCurrent() }] : []),
    ];
    const results = await Promise.allSettled(providers.map((p) => p.run()));
    const values = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    if (AppDataSource.isInitialized) await this.repository.saveMacro(values);
    const errors = results.flatMap((result, index) => result.status === "rejected"
      ? [{ provider: providers[index].name, error: result.reason instanceof Error ? result.reason.message : String(result.reason) }] : []);
    if (!mospiEnabled) {
      errors.push({ provider: "MOSPI", error: "skipped — MOSPI_API_TOKEN not configured (adapter latent; no request made)" });
    }
    if (!fredEnabled) {
      errors.push({ provider: "FRED", error: "skipped — FRED_API_KEY not configured (BLOCKED_EXTERNAL; no request made)" });
    }
    return { values, errors, refreshedAt: new Date().toISOString() };
  }

  async portfolio(positions: PortfolioAnalyticsPosition[], windows: CorrelationWindow[] = ["30D", "90D", "1Y"]): Promise<Record<string, unknown>> {
    const exposure = calculatePortfolioExposure(positions);
    const series: Record<string, Awaited<ReturnType<typeof marketDataService.getDailyBars>>> = {};
    const failures: Array<{ ticker: string; error: string }> = [];
    await Promise.all(positions.map(async (position) => {
      try { series[position.ticker] = await marketDataService.getDailyBars(position.ticker, windows.includes("5Y") || windows.includes("3Y") ? "5y" : "2y"); }
      catch (error) { failures.push({ ticker: position.ticker, error: error instanceof Error ? error.message : String(error) }); }
    }));
    return { exposure, correlations: Object.fromEntries(windows.map((window) => [window, calculateCorrelationMatrix(series, window)])),
      methodology: "Pearson correlation of aligned daily returns; never raw prices.", failures };
  }

  async readTicker(ticker: string): Promise<Record<string, unknown>> { return this.repository.readTicker(ticker); }
  async readMacro(): Promise<unknown> { return this.repository.readMacro(); }

  private async crossCheckBse(ticker: string, bseCode: string | undefined, latest: AnnualFinancials | undefined,
    errors: Array<{ source: string; error: string }>): Promise<CrossCheck[]> {
    if (!latest || !bseCode) return [];
    try {
      const summaries = await this.bse.getFinancialSummary(bseCode);
      const row = summaries[0];
      if (!row) return [];
      const output: CrossCheck[] = [];
      for (const [concept, primary, comparison] of [
        ["revenue", latest.revenue, row.revenue], ["net_income", latest.netIncome, row.netIncome], ["eps", latest.eps, row.eps],
      ] as const) {
        if (primary == null || comparison == null) continue;
        // BSE company-results tables state monetary values in ₹ crore; EPS is ₹/share.
        const normalized = concept === "eps" ? comparison : comparison * 10_000_000;
        const differencePct = Math.abs(primary - normalized) / Math.max(1, Math.abs(primary)) * 100;
        output.push({ concept, period: latest.period, primaryValue: primary, comparisonValue: normalized,
          differencePct: Number(differencePct.toFixed(4)), status: differencePct <= 1 ? "MATCH" : "DISCREPANCY",
          sources: [...latest.sources, { provider: "BSE", sourceLevel: 1, url: row.sourceUrl, document: `BSE results ${row.period}` }] });
      }
      return output;
    } catch (error) { errors.push({ source: "BSE", error: error instanceof Error ? error.message : String(error) }); return []; }
  }

  private coverage(metrics: MetricResult<unknown>[], series: AnnualFinancials[], evidence: ReturnType<typeof extractDocumentEvidence>,
    crossChecks: CrossCheck[]): CoverageRow[] {
    const byName = new Map(metrics.map((m) => [m.metric, m]));
    const metric = (name: string): CoverageRow => {
      const item = byName.get(name);
      return { metric: name, status: item?.status ?? "NOT_AVAILABLE", source: item?.sources.map((s) => s.provider).join(", ") || "none", reason: item?.reason };
    };
    return ["roe", "roic", "fcf", "current_ratio", "earnings_growth", "peg", "dcf"].map(metric).concat([
      { metric: "annual_history", status: series.length > 0 ? "AVAILABLE" : "NOT_AVAILABLE", source: "NSE XBRL", reason: series.length ? `${series.length} fiscal periods` : "No parseable annual filings" },
      { metric: "order_book", status: evidence.some((e) => e.category === "ORDER_BOOK") ? "EXTRACTED" : "NOT_AVAILABLE", source: "company IR PDFs", reason: evidence.length ? undefined : "IR page not supplied or no explicit statement" },
      { metric: "bse_cross_check", status: crossChecks.length ? "AVAILABLE" : "NOT_AVAILABLE", source: "BSE results", reason: crossChecks.length ? undefined : "BSE code not supplied or no comparable row" },
    ]);
  }
}

export const intelligenceService = new IntelligenceService();
