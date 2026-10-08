/**
 * CompanyResearchProfileService — assembles a STRUCTURED research profile for
 * one company from stored evidence only. Every value carries {value, source,
 * asOf}; sections with no stored data say so instead of guessing. Profiles are
 * versioned and append-only (one row per build), so the AI layer can be
 * re-run on an exact evidence snapshot.
 */

import { AppDataSource } from "../../config/database";
import { CompanyResearchProfile } from "../../entities";
import { candidateFromPayload } from "../capital/CapitalAllocationService";
import { computeStageOneFeatures, SeriesPoint } from "./opportunityFeatures";
import { marketDataService } from "../market/MarketDataService";

export const RESEARCH_VERSION = "company-research-v1";

export interface Sourced<T> {
  value: T;
  source: string;
  asOf: string | null;
}
export interface EvidenceItem {
  id: string;
  section: string;
  statement: string;
  value: number | string | null;
  source: string;
  sourceUrl: string | null;
  asOf: string | null;
  kind: "FACT";
}

export interface ResearchProfile {
  symbol: string;
  researchVersion: string;
  builtAt: string;
  identity: { companyName: string; isin: string | null; exchange: string; series: string | null; instrumentType: string; sector: string | null; industry: string | null; marketCapBucket: string; marketCapSource: string | null; liquidityTier: string; listedDate: string | null; indices: string[] };
  business: { summary: Sourced<string> | null; segments: Sourced<string[]> | null; keyDrivers: Sourced<string[]> | null; majorRisks: Sourced<string[]> | null };
  fundamentals: Record<string, Sourced<number | null>>;
  valuation: { metrics: Record<string, Sourced<number | null>>; context: Sourced<string> | null };
  market: Record<string, Sourced<number | string | null>>;
  events: Array<{ kind: string; fact: string; eventDate: string | null; source: string; sourceUrl: string | null; observedAt: string }>;
  news: Array<{ kind: string; fact: string; sentiment: string | null; materiality: string | null; source: string; sourceUrl: string | null; observedAt: string }>;
  results: Array<{ periodEnd: string; periodType: string; concept: string; value: number; source: string }>;
  shortTerm: { evaluatedAt: string | null; setupType: string | null; action: string | null; tier: string | null; modelHealth: string | null; trend: string | null; entryZoneLow: number | null; entryZoneHigh: number | null; stop: number | null; target1: number | null; target2: number | null; rewardRisk: number | null; ev80LowerPct: number | null; support: number | null; resistance: number | null; whyNotEntry: string[]; source: string };
  coverage: { score: number | null; ohlcv: boolean; fundamentals: boolean; news: boolean; events: boolean; results: boolean };
  globalContext: { globalRegime: string | null; indiaRegime: string | null; transmission: string | null; sectorLabel: string | null; sectorName: string | null; statements: Array<{ text: string; evidence: string }> };
  dataAsOf: Record<string, string | null>;
  gaps: string[];
}

const n = (v: unknown): number | null => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);

export class CompanyResearchProfileService {
  async build(symbolIn: string, opts: { persist?: boolean } = {}): Promise<{ profile: ResearchProfile; evidence: EvidenceItem[]; profileId: string | null }> {
    const symbol = symbolIn.replace(/\.NS$/, "").toUpperCase();
    const [m] = (await AppDataSource.query(`SELECT * FROM security_master WHERE symbol = $1`, [symbol])) as Array<Record<string, unknown>>;
    if (!m) throw new Error(`unknown security ${symbol}`);
    const yahoo = String(m.yahoo_ticker);
    const evidence: EvidenceItem[] = [];
    const gaps: string[] = [];
    const dataAsOf: Record<string, string | null> = {};
    let eid = 0;
    const ev = (section: string, statement: string, value: number | string | null, source: string, asOf: string | null, sourceUrl: string | null = null): string => {
      const id = `E${++eid}`;
      evidence.push({ id, section, statement, value, source, sourceUrl, asOf, kind: "FACT" });
      return id;
    };

    // ── fundamentals + valuation from intelligence_metrics (latest per metric) ──
    const metrics: Array<{ metric: string; value: string | null; period: string | null; calculated_at: string; sources: unknown }> = await AppDataSource.query(
      `SELECT DISTINCT ON (metric) metric, value::text, period, calculated_at, sources FROM intelligence_metrics WHERE ticker IN ($1,$2) ORDER BY metric, calculated_at DESC`,
      [yahoo, symbol]
    );
    const met = new Map(metrics.map((x) => [x.metric, x]));
    const fundamentals: Record<string, Sourced<number | null>> = {};
    const valuation: Record<string, Sourced<number | null>> = {};
    const take = (dest: Record<string, Sourced<number | null>>, key: string, metric: string, label: string) => {
      const x = met.get(metric);
      if (!x) return;
      const v = n(x.value);
      const src = Array.isArray(x.sources) && x.sources.length ? String((x.sources as unknown[])[0]) : "intelligence_metrics";
      const asOf = new Date(x.calculated_at).toISOString();
      dest[key] = { value: v, source: src, asOf };
      if (v != null) ev("fundamentals", `${label} ${v}${x.period ? ` (${x.period})` : ""}`, v, src, asOf);
    };
    take(fundamentals, "revenue", "revenue", "Revenue");
    take(fundamentals, "revenueGrowthPct", "sales_growth_yoy", "Revenue growth YoY %");
    take(fundamentals, "ebitda", "ebitda", "EBITDA");
    take(fundamentals, "operatingMarginPct", "operating_margin", "Operating margin %");
    take(fundamentals, "netProfit", "net_profit", "Net profit");
    take(fundamentals, "profitGrowthPct", "profit_growth_yoy", "Profit growth YoY %");
    take(fundamentals, "eps", "eps", "EPS");
    take(fundamentals, "roePct", "roe", "ROE %");
    take(fundamentals, "rocePct", "roce", "ROCE %");
    take(fundamentals, "debt", "debt", "Debt");
    take(fundamentals, "debtToEquity", "debt_to_equity", "Debt/Equity");
    take(fundamentals, "freeCashFlow", "fcf", "Free cash flow");
    take(fundamentals, "promoterHoldingPct", "promoter_holding", "Promoter holding %");
    take(fundamentals, "promoterHoldingChangeQoQ", "promoter_holding_change_qoq", "Promoter holding change QoQ (pp)");
    take(valuation, "pe", "pe_ratio", "P/E");
    take(valuation, "pb", "price_to_book", "P/B");
    take(valuation, "evToEbitda", "ev_ebitda", "EV/EBITDA");
    take(valuation, "marketCapInr", "market_cap", "Market cap (₹cr)");
    take(valuation, "dividendYieldPct", "dividend_yield", "Dividend yield %");
    take(valuation, "bookValue", "book_value", "Book value");
    if (!metrics.length) gaps.push("no stored fundamentals (intelligence_metrics) — run the filings/ratio refresh for this symbol");
    dataAsOf.fundamentals = metrics.length ? new Date(metrics.map((x) => x.calculated_at).sort().reverse()[0]).toISOString() : null;
    if (!("institutionalHoldingPct" in fundamentals)) gaps.push("institutional (FII/DII) holding not available from any configured source");

    // ── results from financial_facts ──
    const facts: Array<{ concept: string; value: string; period_end: string; period_type: string; source_url: string | null }> = await AppDataSource.query(
      `SELECT concept, value::text, period_end::text, period_type, source_url FROM financial_facts WHERE ticker IN ($1,$2) AND status <> 'REJECTED' ORDER BY period_end DESC, concept LIMIT 60`,
      [yahoo, symbol]
    );
    const results = facts.map((f) => ({ periodEnd: f.period_end, periodType: f.period_type, concept: f.concept, value: Number(f.value), source: f.source_url ?? "nse-xbrl" }));
    for (const r of results.slice(0, 12)) ev("results", `${r.concept} ${r.value} for ${r.periodType} ending ${r.periodEnd}`, r.value, "nse-xbrl", r.periodEnd, r.source.startsWith("http") ? r.source : null);
    dataAsOf.results = results[0]?.periodEnd ?? null;
    if (!results.length) gaps.push("no XBRL financial results on file");

    // ── knowledge facts: business / events / news ──
    const know: Array<{ kind: string; fact: string; detail: Record<string, unknown> | null; source_kind: string; source_url: string | null; observed_at: string; confidence: string }> = await AppDataSource.query(
      `SELECT kind, fact, detail, source_kind, source_url, observed_at::text, confidence FROM stock_knowledge WHERE symbol = $1 AND kind <> 'SURVEILLANCE' ORDER BY observed_at DESC LIMIT 60`,
      [symbol]
    );
    const business: ResearchProfile["business"] = { summary: null, segments: null, keyDrivers: null, majorRisks: null };
    const events: ResearchProfile["events"] = [];
    const news: ResearchProfile["news"] = [];
    for (const k of know) {
      const d = k.detail ?? {};
      if (k.kind === "BUSINESS" && !business.summary) business.summary = { value: k.fact, source: k.source_kind, asOf: k.observed_at };
      if (["CORPORATE_ACTION", "EVENT", "RESULTS", "REGULATORY", "LEGAL", "MANAGEMENT", "GOVERNANCE"].includes(k.kind))
        events.push({ kind: k.kind, fact: k.fact, eventDate: typeof d.eventDate === "string" ? d.eventDate : null, source: k.source_kind, sourceUrl: k.source_url, observedAt: k.observed_at });
      if (k.source_kind === "NEWS") news.push({ kind: k.kind, fact: k.fact, sentiment: typeof d.sentiment === "string" ? d.sentiment : null, materiality: typeof d.materiality === "string" ? d.materiality : null, source: k.source_kind, sourceUrl: k.source_url, observedAt: k.observed_at });
      ev(k.source_kind === "NEWS" ? "news" : "events", `${k.kind}: ${k.fact}`, null, k.source_kind, k.observed_at, k.source_url);
    }
    dataAsOf.news = news[0]?.observedAt ?? null;
    dataAsOf.events = events[0]?.observedAt ?? null;
    if (!business.summary) gaps.push("no business summary on file (web-knowledge job has not covered this symbol)");
    if (!news.length) gaps.push("no news facts on file");
    const surv: Array<{ fact: string; list: string; observed_at: string }> = await AppDataSource.query(
      `SELECT fact, detail->>'list' AS list, observed_at::text FROM stock_knowledge WHERE symbol = $1 AND kind = 'SURVEILLANCE' ORDER BY observed_at DESC LIMIT 1`,
      [symbol]
    );
    if (surv.length) ev("risk", `Exchange surveillance: ${surv[0].list} — ${surv[0].fact}`, surv[0].list, "EXCHANGE", surv[0].observed_at);

    // ── market: delivery series (close-only) + OHLCV features when stored ──
    const series: Array<{ d: string; close: string; qty: string; val: string; deliv: string | null }> = await AppDataSource.query(
      `SELECT trade_date::text AS d, close_price::text AS close, traded_qty::text AS qty, (turnover_lacs*1e5)::text AS val, deliv_pct::text AS deliv FROM nse_delivery WHERE symbol = $1 AND series='EQ' ORDER BY trade_date DESC LIMIT 300`,
      [symbol]
    );
    const pts: SeriesPoint[] = series.reverse().map((p) => ({ date: p.d, close: Number(p.close), volume: Number(p.qty), valueInr: Number(p.val), delivPct: p.deliv != null ? Number(p.deliv) : null }));
    const asOf = pts[pts.length - 1]?.date ?? null;
    let nifty: Map<string, number> | null = null;
    try {
      nifty = new Map((await marketDataService.getNiftyBars("2y")).map((b) => [b.date, b.adjustedClose ?? b.close]));
    } catch { /* relative strength null */ }
    const f = asOf ? computeStageOneFeatures(pts, asOf, nifty) : null;
    const market: ResearchProfile["market"] = {};
    const src = "nse-bhavcopy (close-only)";
    if (f) {
      market.currentPrice = { value: f.price, source: src, asOf };
      market.return20dPct = { value: f.r20Pct, source: src, asOf };
      market.return50dPct = { value: f.r60Pct, source: src, asOf };
      market.return200dPct = { value: f.r120Pct, source: src, asOf };
      market.volatility20AnnPct = { value: f.realizedVol20AnnPct, source: src, asOf };
      market.atrProxyPct = { value: f.atrProxyPct, source: `${src} — close-to-close proxy, not true range`, asOf };
      market.relativeStrength60Pct = { value: f.relNifty60Pct, source: `${src} vs NIFTY`, asOf };
      market.high52w = { value: f.high52, source: src, asOf };
      market.low52w = { value: f.low52, source: src, asOf };
      market.trend = { value: f.trend, source: `${src} SMA50/SMA200`, asOf };
      market.medianDailyValueInr = { value: f.medianValue20Inr, source: src, asOf };
      market.deliveryPct20 = { value: f.delivPct20, source: src, asOf };
      ev("market", `Close ${f.price} on ${asOf}; 20d ${f.r20Pct}%, 60d ${f.r60Pct}%, 52w ${f.low52}–${f.high52}, trend ${f.trend}`, f.price, src, asOf);
    } else gaps.push("no price series on file");
    dataAsOf.price = asOf;

    // ── short-term: the engine's latest persisted evaluation (never recomputed here) ──
    const st: Array<{ payload: Record<string, unknown>; created_at: string }> = await AppDataSource.query(`SELECT payload, created_at FROM short_term_candidates WHERE ticker = $1 ORDER BY created_at DESC LIMIT 1`, [yahoo]);
    const c = st.length ? candidateFromPayload(st[0].payload) : null;
    const feats = st.length ? ((st[0].payload.features ?? {}) as Record<string, unknown>) : {};
    const shortTerm: ResearchProfile["shortTerm"] = {
      evaluatedAt: st.length ? new Date(st[0].created_at).toISOString() : null,
      setupType: c?.setupType ?? null,
      action: c?.action ?? null,
      tier: c?.tier ?? null,
      modelHealth: c?.modelHealth ?? null,
      trend: f?.trend ?? null,
      entryZoneLow: c?.plan.entryZoneLow ?? null,
      entryZoneHigh: c?.plan.entryZoneHigh ?? null,
      stop: c?.plan.initialStop ?? null,
      target1: c?.plan.target1 ?? null,
      target2: c?.plan.target2 ?? null,
      rewardRisk: c?.plan.rewardRiskToTarget1 ?? null,
      ev80LowerPct: c?.ev?.ev80LowerPct ?? null,
      support: n(feats.supportDistPct) != null && c?.currentPrice ? Math.round(c.currentPrice * (1 - Number(feats.supportDistPct) / 100) * 100) / 100 : null,
      resistance: n(feats.resistanceDistPct) != null && c?.currentPrice ? Math.round(c.currentPrice * (1 + Number(feats.resistanceDistPct) / 100) * 100) / 100 : null,
      whyNotEntry: c?.whyNotEntry ?? [],
      source: st.length ? "short_term_candidates (engine evaluation)" : "not evaluated by the short-term engine yet",
    };
    if (c) ev("shortTerm", `Engine: setup ${c.setupType}, action ${c.action}, tier ${c.tier}, model health ${c.modelHealth}${c.plan.initialStop != null ? `, stop ${c.plan.initialStop}, T1 ${c.plan.target1}` : ""}`, c.action, "short_term_candidates", shortTerm.evaluatedAt);
    else gaps.push("not evaluated by the short-term engine yet (not in any scan run)");
    dataAsOf.shortTerm = shortTerm.evaluatedAt;

    let globalContext: ResearchProfile["globalContext"] = { globalRegime: null, indiaRegime: null, transmission: null, sectorLabel: null, sectorName: null, statements: [{ text: "Global context unavailable.", evidence: "none" }] };
    try {
      const { globalIntelligenceService } = await import("../global/GlobalIntelligenceService");
      const gc = await globalIntelligenceService.companyContext((m.industry as string) ?? null);
      globalContext = { globalRegime: gc.globalRegime, indiaRegime: gc.indiaRegime, transmission: gc.transmission, sectorLabel: gc.sector?.label ?? null, sectorName: gc.sector?.name ?? null, statements: gc.statements };
      for (const st of gc.statements) ev("global", st.text, null, "global_market_snapshots", null);
    } catch { /* global layer optional */ }
    const [cov] = (await AppDataSource.query(`SELECT coverage_score, ohlcv_available, fundamentals_available, news_available, announcement_available, corporate_actions_available, financial_results_available FROM security_data_coverage WHERE symbol = $1`, [symbol])) as Array<Record<string, unknown>>;
    const profile: ResearchProfile = {
      symbol,
      researchVersion: RESEARCH_VERSION,
      builtAt: new Date().toISOString(),
      identity: { companyName: String(m.company_name), isin: (m.isin as string) ?? null, exchange: String(m.exchange), series: (m.series as string) ?? null, instrumentType: String(m.instrument_type), sector: (m.sector as string) ?? null, industry: (m.industry as string) ?? null, marketCapBucket: String(m.market_cap_bucket), marketCapSource: (m.market_cap_source as string) ?? null, liquidityTier: String(m.liquidity_tier), listedDate: (m.listed_date as string) ?? null, indices: (m.indices as string[]) ?? [] },
      business,
      fundamentals,
      valuation: { metrics: valuation, context: valuation.pe?.value != null ? { value: `P/E ${valuation.pe.value} as of ${valuation.pe.asOf?.slice(0, 10)}; price as of ${asOf} — different dates`, source: "derived", asOf } : null },
      market,
      events,
      news,
      results,
      shortTerm,
      globalContext,
      coverage: { score: cov ? n(cov.coverage_score) : null, ohlcv: cov?.ohlcv_available === true, fundamentals: cov?.fundamentals_available === true, news: cov?.news_available === true, events: cov?.announcement_available === true || cov?.corporate_actions_available === true, results: cov?.financial_results_available === true },
      dataAsOf,
      gaps,
    };
    let profileId: string | null = null;
    if (opts.persist !== false) {
      const repo = AppDataSource.getRepository(CompanyResearchProfile);
      const row = await repo.save(repo.create({ symbol, researchVersion: RESEARCH_VERSION, dataAsOf, profile: profile as unknown as Record<string, unknown>, evidenceItems: evidence as unknown as Array<Record<string, unknown>>, sourceReferences: evidence.filter((e) => e.sourceUrl).map((e) => ({ id: e.id, url: e.sourceUrl, source: e.source })), coverageScore: profile.coverage.score != null ? profile.coverage.score.toFixed(1) : null }));
      profileId = row.id;
    }
    return { profile, evidence, profileId };
  }

  async latest(symbol: string): Promise<CompanyResearchProfile | null> {
    const rows = await AppDataSource.getRepository(CompanyResearchProfile).find({ where: { symbol: symbol.replace(/\.NS$/, "").toUpperCase() }, order: { builtAt: "DESC" }, take: 1 });
    return rows[0] ?? null;
  }
}

export const companyResearchProfileService = new CompanyResearchProfileService();
