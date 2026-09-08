/**
 * EvidenceGraphService (OpenAI-first upgrade, Part 2) — assembles the
 * per-stock evidence graph from DETERMINISTIC, stored sources only.
 *
 *   STOCK → BUSINESS / FUNDAMENTALS / VALUATION / TECHNICAL STATE /
 *           MARKET+SECTOR+STOCK REGIME / EVENTS / FORECASTS / CALIBRATION /
 *           MODEL HEALTH / EXPECTED VALUE / RISKS / POSITION CONTEXT
 *
 * Every fact is an EvidenceFact with provenance (source, url, authority tier,
 * asOf, availableAt, retrievedAt, quality, isPrimarySource) and a stable
 * evidenceId. AI roles receive SECTION SLICES of this graph and must cite
 * evidenceIds; AI interpretations are stored separately (ai_reviews) and can
 * never overwrite these facts.
 *
 * The graph reads the LATEST PUBLISHED DecisionSnapshot plus stored tables —
 * the same discipline as the committee: AI reasons about what the
 * deterministic system computed, never about fresher data it computed itself.
 */

import { AppDataSource } from "../../config/database";
import { DecisionSnapshot, Instrument, StructuredMarketEvent } from "../../entities";
import { fundamentalsService } from "../market/FundamentalsService";
import { marketDataService } from "../market/MarketDataService";
import { analyzeBars } from "../quant/engine";
import { IntelligenceRepository } from "../intelligence/IntelligenceRepository";
import { createHash } from "crypto";

export const EVIDENCE_GRAPH_VERSION = "evidence-graph-v1";

export interface EvidenceFact {
  id: string;
  value: unknown;
  source: string;
  sourceUrl: string | null;
  /** 1 exchange filing · 2 IR/exchange data · 3 government · 4 publications · 5 derived/internal. */
  sourceAuthority: number;
  asOf: string | null;
  availableAt: string | null;
  retrievedAt: string | null;
  quality: "HIGH" | "MEDIUM" | "LOW";
  isPrimarySource: boolean;
}

export interface EvidenceGraph {
  version: string;
  ticker: string;
  builtAt: string;
  /** sha256 over the graph's factual content — the AI-cache key input (Part 24). */
  evidenceHash: string;
  sections: {
    business: EvidenceFact[];
    fundamentals: EvidenceFact[];
    valuation: EvidenceFact[];
    technicalState: EvidenceFact[];
    regime: EvidenceFact[];
    events: EvidenceFact[];
    forecasts: EvidenceFact[];
    calibration: EvidenceFact[];
    modelHealth: EvidenceFact[];
    expectedValue: EvidenceFact[];
    risks: EvidenceFact[];
    positionContext: EvidenceFact[];
  };
  /** Stated, not hidden: sections that had no evidence available. */
  emptySections: string[];
}

const fact = (
  id: string,
  value: unknown,
  over: Partial<Omit<EvidenceFact, "id" | "value">> = {}
): EvidenceFact => ({
  id,
  value,
  source: over.source ?? "stocksense-deterministic",
  sourceUrl: over.sourceUrl ?? null,
  sourceAuthority: over.sourceAuthority ?? 5,
  asOf: over.asOf ?? null,
  availableAt: over.availableAt ?? null,
  retrievedAt: over.retrievedAt ?? null,
  quality: over.quality ?? "MEDIUM",
  isPrimarySource: over.isPrimarySource ?? false,
});

export class EvidenceGraphService {
  async build(ticker: string, positionContext?: Record<string, unknown> | null): Promise<EvidenceGraph> {
    const t = ticker.trim().toUpperCase();
    const yahooTicker = /\.(NS|BO)$/.test(t) ? t : `${t}.NS`;
    const base = yahooTicker.replace(/\.(NS|BO)$/, "");

    const instrument = await AppDataSource.getRepository(Instrument)
      .createQueryBuilder("i")
      .where("i.yahoo_ticker = :yt", { yt: yahooTicker })
      .getOne();

    const snapshot = instrument
      ? await AppDataSource.getRepository(DecisionSnapshot).findOne({
          where: { instrumentId: instrument.id },
          order: { asOf: "DESC" },
        })
      : null;
    const snapAsOf = snapshot?.asOf?.toISOString() ?? null;
    const inputs = (snapshot?.inputs ?? {}) as Record<string, any>;
    const sc = (snapshot?.scoreCard ?? null) as Record<string, any> | null;

    const sections: EvidenceGraph["sections"] = {
      business: [],
      fundamentals: [],
      valuation: [],
      technicalState: [],
      regime: [],
      events: [],
      forecasts: [],
      calibration: [],
      modelHealth: [],
      expectedValue: [],
      risks: [],
      positionContext: [],
    };

    // ── business ────────────────────────────────────────────────────────────
    if (instrument) {
      sections.business.push(
        fact("biz:name", instrument.name, { source: "instrument-registry", quality: "HIGH" }),
        fact("biz:sector", instrument.sector ?? null, { source: "instrument-registry" })
      );
    }

    // ── fundamentals (Yahoo snapshot + XBRL-derived metrics, each with provenance) ──
    const yahoo = await fundamentalsService.getFundamentals(yahooTicker).catch(() => null);
    if (yahoo) {
      const y = (id: string, v: unknown) =>
        sections.fundamentals.push(
          fact(`fund:${id}`, v, {
            source: "yahoo-quoteSummary",
            sourceUrl: "https://finance.yahoo.com/",
            sourceAuthority: 4,
            retrievedAt: yahoo.asOf,
            asOf: yahoo.asOf,
            quality: v == null ? "LOW" : "MEDIUM",
          })
        );
      y("revenueGrowthPct", yahoo.revenueGrowthPct);
      y("earningsGrowthPct", yahoo.earningsGrowthPct);
      y("operatingMarginPct", yahoo.operatingMarginPct);
      y("netMarginPct", yahoo.netMarginPct);
      y("returnOnEquityPct", yahoo.returnOnEquityPct);
      y("freeCashflow", yahoo.freeCashflow);
      y("totalDebt", yahoo.totalDebt);
      y("currentRatio", yahoo.currentRatio);
      y("nextEarningsDate", yahoo.nextEarningsDate);
    }
    try {
      const stored = await new IntelligenceRepository().latestStoredMetrics([base]);
      const m = stored.get(base) as Record<string, any> | undefined;
      if (m) {
        for (const key of ["roic", "roe", "roce", "fcf", "current_ratio", "working_capital", "peg"]) {
          if (m[key] != null) {
            sections.fundamentals.push(
              fact(`fund:xbrl:${key}`, m[key], {
                source: "nse-xbrl-filings",
                sourceAuthority: 1,
                isPrimarySource: true,
                quality: "HIGH",
              })
            );
          }
        }
      }
    } catch {
      /* stored-metrics read failure ⇒ facts simply absent, stated via emptySections */
    }
    const fc = inputs.fundamentalsCompleteness as Record<string, any> | null;
    if (fc) {
      sections.fundamentals.push(
        fact("fund:completeness", { xbrlPct: fc.xbrlCompletenessPct, yahooPct: fc.yahooCompletenessPct }, { asOf: snapAsOf, quality: "HIGH" })
      );
    }

    // ── valuation ───────────────────────────────────────────────────────────
    if (yahoo) {
      const v = (id: string, val: unknown) =>
        sections.valuation.push(
          fact(`val:${id}`, val, { source: "yahoo-quoteSummary", sourceAuthority: 4, retrievedAt: yahoo.asOf, asOf: yahoo.asOf })
        );
      v("trailingPE", yahoo.trailingPE);
      v("pegRatio", yahoo.pegRatio);
      v("priceToBook", yahoo.priceToBook);
      v("enterpriseToEbitda", yahoo.enterpriseToEbitda);
      v("dividendYieldPct", yahoo.dividendYieldPct);
      v("marketCap", yahoo.marketCap);
      v("beta", yahoo.beta);
    }

    // ── technical state (scorecard + latest stored analysis facts) ──────────
    if (sc) {
      sections.technicalState.push(
        fact("tech:setupScore", sc.setupScore, { asOf: snapAsOf, quality: "HIGH" }),
        fact("tech:entryQualityScore", sc.entryTimingScore, { asOf: snapAsOf, quality: "HIGH" })
      );
    }
    try {
      // Deterministic technicals from DB-cached adjusted bars (same engine the
      // product uses) — computed, not imagined, and always reproducible.
      const bars = await marketDataService.getDailyBars(yahooTicker, "1y");
      if (bars.length >= 60) {
        const analysis = analyzeBars(bars);
        const tech = analysis.technicals as unknown as Record<string, any>;
        const lastBar = bars[bars.length - 1]?.date ?? null;
        const push = (id: string, v: unknown) =>
          sections.technicalState.push(fact(`tech:${id}`, v, { asOf: lastBar, quality: "HIGH", source: "quant-engine (adjusted bars)" }));
        push("lastClose", bars[bars.length - 1]?.close ?? null);
        push("rsi14", tech.rsi14 ?? null);
        push("sma20", tech.sma20 ?? null);
        push("sma50", tech.sma50 ?? null);
        push("sma200", tech.sma200 ?? null);
        push("annualVolatilityPct", tech.annualVolatilityPct ?? null);
        push("week52PositionPct", tech.week52?.positionPct ?? null);
        push("volumeRatio20d", tech.volumeRatio20d ?? null);
        push("returns", tech.returns ?? null);
      }
    } catch {
      /* bars unavailable ⇒ technical facts absent, stated via emptySections */
    }

    // ── regime ──────────────────────────────────────────────────────────────
    const regime = inputs.regime as Record<string, any> | null;
    if (regime) {
      sections.regime.push(
        fact("regime:market", regime.marketRegime, { asOf: snapAsOf, quality: "HIGH" }),
        fact("regime:sector", regime.sectorRegime ?? null, { asOf: snapAsOf }),
        fact("regime:stock", regime.stockRegime, { asOf: snapAsOf, quality: "HIGH" }),
        fact("regime:entry", regime.entryRegime, { asOf: snapAsOf, quality: "HIGH" }),
        fact("regime:reasons", regime.regimeReasons ?? [], { asOf: snapAsOf })
      );
    }

    // ── events (point-in-time, tiered — primary sources marked) ─────────────
    const events: StructuredMarketEvent[] = await AppDataSource.getRepository(StructuredMarketEvent)
      .createQueryBuilder("e")
      .where("e.ticker = :base", { base })
      .andWhere("e.announced_at <= now()")
      .orderBy("e.announced_at", "DESC")
      .limit(25)
      .getMany()
      .catch(() => []);
    for (const e of events) {
      sections.events.push(
        fact(
          `evt:${e.id}`,
          { eventType: e.eventType, eventDate: e.eventDate, headline: e.headline ?? null },
          {
            source: e.source,
            sourceUrl: e.url ?? null,
            sourceAuthority: e.sourceTier,
            availableAt: e.announcedAt.toISOString(),
            asOf: e.eventDate,
            isPrimarySource: e.sourceTier <= 2,
            quality: e.sourceTier <= 2 ? "HIGH" : "MEDIUM",
          }
        )
      );
    }
    const eventRisk = inputs.eventRisk as Record<string, any> | null;
    if (eventRisk) {
      sections.events.push(fact("evt:riskAssessment", { upcomingEventRisk: eventRisk.upcomingEventRisk, reasons: eventRisk.reasons }, { asOf: snapAsOf, quality: "HIGH" }));
    }

    // ── forecasts / calibration / model health / EV / risks (snapshot truth) ─
    const issuance = inputs.issuance as Record<string, any> | null;
    if (issuance) {
      sections.forecasts.push(
        fact("fcst:anchorSessionDate", issuance.anchorSessionDate, { asOf: snapAsOf, quality: "HIGH" }),
        fact("fcst:medianReturnPct30", issuance.medianReturnPct30, { asOf: snapAsOf }),
        fact("fcst:annualizedVolPct", issuance.annualizedVolPct, { asOf: snapAsOf }),
        fact("fcst:method", "seeded bootstrap — historical scenario frequencies (uncalibrated)", { quality: "HIGH" })
      );
    }
    const measured = inputs.measured as Record<string, any> | null;
    if (measured) {
      sections.forecasts.push(
        fact("fcst:measured30d", measured, { asOf: snapAsOf, quality: "HIGH" }),
        fact("fcst:effectiveSamples", sc?.forecastConfidence?.effectiveSamples ?? null, { asOf: snapAsOf, quality: "HIGH" })
      );
    }
    const dp = inputs.directionProbability as Record<string, any> | null;
    if (dp) {
      sections.calibration.push(
        fact("cal:directionProbabilityStatement", dp.statement, { asOf: snapAsOf, quality: "HIGH" }),
        fact("cal:status", dp.status, { asOf: snapAsOf, quality: "HIGH" }),
        fact("cal:calibratedProbability", dp.calibratedProbability, { asOf: snapAsOf })
      );
    }
    if (sc?.forecastConfidence) {
      sections.calibration.push(
        fact("cal:brier", sc.forecastConfidence.brier ?? null, { asOf: snapAsOf }),
        fact("cal:brierSkill", sc.forecastConfidence.brierSkill ?? null, { asOf: snapAsOf }),
        fact("cal:bandCoveragePct", sc.forecastConfidence.bandCoveragePct ?? null, { asOf: snapAsOf })
      );
    }
    const mh = inputs.modelHealth as Record<string, any> | null;
    if (mh) {
      sections.modelHealth.push(
        fact("health:overallState", mh.overallState, { asOf: snapAsOf, quality: "HIGH" }),
        fact("health:horizons", mh.horizons ?? [], { asOf: snapAsOf })
      );
    }
    const ev = (snapshot?.expectedValue ?? null) as Record<string, any> | null;
    if (ev) {
      sections.expectedValue.push(
        fact("ev:evAfterCostsPct", ev.evAfterCostsPct ?? null, { asOf: snapAsOf, quality: "HIGH" }),
        fact("ev:expectedReturnPct", ev.expectedReturnPct ?? null, { asOf: snapAsOf }),
        fact("ev:rewardRiskRatio", ev.rewardRiskRatio ?? null, { asOf: snapAsOf }),
        fact("ev:transactionCostPct", ev.transactionCostPct ?? null, { asOf: snapAsOf })
      );
    }
    if (sc?.risk) {
      sections.risks.push(
        fact("risk:score", sc.risk.score ?? null, { asOf: snapAsOf, quality: "HIGH" }),
        fact("risk:band", sc.risk.band ?? null, { asOf: snapAsOf }),
        fact("risk:reasons", sc.risk.reasons ?? [], { asOf: snapAsOf })
      );
    }
    if (snapshot) {
      sections.risks.push(
        fact("risk:gateDecision", snapshot.decisionStatus, { asOf: snapAsOf, quality: "HIGH" }),
        fact("risk:unmetGates", snapshot.unmetGates ?? [], { asOf: snapAsOf, quality: "HIGH" })
      );
    }

    // ── position context (ONLY what the caller explicitly supplied — Part 26) ─
    if (positionContext) {
      const allowed = ["holdsPosition", "purchasePrice", "quantity", "investmentHorizon", "riskTolerance", "maximumAcceptableLoss"];
      for (const k of allowed) {
        if (positionContext[k] !== undefined) {
          sections.positionContext.push(fact(`pos:${k}`, positionContext[k], { source: "user-supplied", quality: "HIGH" }));
        }
      }
    }

    const emptySections = Object.entries(sections)
      .filter(([, v]) => v.length === 0)
      .map(([k]) => k);

    // Cache key hashes FACTUAL CONTENT only ({id, value} pairs) — provenance
    // timestamps like retrievedAt change every fetch and must not bust the
    // AI cache when the underlying values are unchanged (Part 24).
    const factual = Object.fromEntries(
      Object.entries(sections).map(([k, facts]) => [k, facts.map((f) => ({ id: f.id, value: f.value }))])
    );
    const evidenceHash = createHash("sha256")
      .update(EVIDENCE_GRAPH_VERSION)
      .update(JSON.stringify(factual))
      .digest("hex");

    return {
      version: EVIDENCE_GRAPH_VERSION,
      ticker: yahooTicker,
      builtAt: new Date().toISOString(),
      evidenceHash,
      sections,
      emptySections,
    };
  }

  /** Role-scoped slice: each analyst receives ONLY its relevant sections (Part 13). */
  slice(graph: EvidenceGraph, keys: Array<keyof EvidenceGraph["sections"]>): string {
    const out: Record<string, unknown> = {
      ticker: graph.ticker,
      builtAt: graph.builtAt,
      note: "Facts carry provenance (source, authority tier 1-5, asOf/availableAt). Cite ids in citedEvidenceIds. Missing sections are stated.",
    };
    for (const k of keys) out[k] = graph.sections[k];
    out.emptySections = graph.emptySections.filter((s) => keys.includes(s as keyof EvidenceGraph["sections"]));
    return JSON.stringify(out);
  }
}

export const evidenceGraphService = new EvidenceGraphService();
