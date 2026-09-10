/**
 * ShortTermScanService (S7/S8/S9) — the free-first scan pipeline:
 *
 *   universe → user filters (price/sector FIRST — never ask an LLM to filter)
 *   → completed-bar features (STAGE 0, zero AI cost) → setup classifier →
 *   distribution forecast → entry/exit plan → EV after costs → risk-based
 *   sizing → HARD GATES → ranking → UP TO N.
 *
 * Persists: scan run, every gated candidate, state transitions (vs the
 * ticker's previous state), transition-deduped alerts, and shadow predictions
 * for passing candidates (paper/shadow discipline before real money).
 * OpenAI is NOT called here — AI summaries ride a separate, budget-governed
 * escalation path (aiAnalyst.ts).
 */

import { AppDataSource } from "../../config/database";
import {
  ShortTermAlert,
  ShortTermCandidate,
  ShortTermScanRun,
  ShortTermShadowPrediction,
  ShortTermTransition,
} from "../../entities";
import { NSE_UNIVERSE } from "../../data/nseUniverse";
import { marketDataService } from "../market/MarketDataService";
import { analysisCloses } from "../market/canonical";
import { buildSectorIndex } from "../research/excessReturns";
import { modelHealthService } from "../monitoring/ModelHealthService";
import { eventService } from "../market/EventService";
import { assessEntryQuality } from "../framework/entryQuality";
import { analyzeBars } from "../quant/engine";
import { liveMarketDataProvider } from "./LiveMarketDataProvider";
import { computeShortTermFeatures } from "./features";
import { classifySetup } from "./setups";
import { buildTradePlan } from "./entryExit";
import { buildShortTermForecast, bracketExpectedValuePct, expectedHoldingDaysFor } from "./model";
import { evaluateGates, rankingScoreV2 } from "./ranking";
import { computePositionSize, assessPortfolioRisk } from "./sizing";
import { computeEvEvidence, evGatePasses } from "./evUncertainty";
import { setupEvidenceService } from "./setupEvidence";
import { assessLevels } from "./plausibility";
import { assessConfirmation } from "./confirmation";
import { computeTier } from "./tiers";
import { detectContradictions } from "./contradictions";
import { assessShortTermHealth } from "./shortTermHealth";
import { assessPortfolioContext } from "./portfolioContext";
import { assessRegime } from "../decision/regimeEngine";
import { adjustedDailyReturns } from "../market/canonical";
import {
  composeCeiling,
  capAction,
  FreshnessV2,
  ShortTermActionV2,
  EvidenceTier,
} from "./actionStates";
import {
  CandidateState,
  DEFAULT_SCAN_PARAMS,
  HORIZON_TD,
  ScanParams,
  ShortTermCandidateView,
  SHORT_TERM_FEATURE_VERSION,
  SHORT_TERM_POLICY_VERSION,
  SHORT_TERM_VERSION,
  STRATEGY_SETUPS,
} from "./types";

/**
 * Geometry-derived action (Stage A only) — where price sits vs the plan,
 * BEFORE any evidence ceiling. ZONE_REACHED is the strongest this returns; it
 * is NEVER ENTRY_CONFIRMED (that requires evidence + confirmation, applied by
 * the ceiling downstream).
 */
function deriveGeometryAction(setupType: string, price: number, plan: ShortTermCandidateView["plan"]): ShortTermActionV2 {
  const constructive = ["PULLBACK_IN_UPTREND", "BREAKOUT_CONFIRMATION", "MOMENTUM_CONTINUATION", "VOLATILITY_CONTRACTION", "MEAN_REVERSION"].includes(setupType);
  if (!constructive || plan.entryType === "NONE") return "NO_SETUP";
  if (plan.entryType === "BREAKOUT_TRIGGER") {
    if (plan.entryTriggerPrice != null && price >= plan.entryTriggerPrice) return "ZONE_REACHED";
    return "SETUP_DETECTED";
  }
  if (plan.entryZoneLow != null && plan.entryZoneHigh != null) {
    if (price >= plan.entryZoneLow && price <= plan.entryZoneHigh) return "ZONE_REACHED";
    return "SETUP_DETECTED";
  }
  return "SETUP_DETECTED";
}

/** Map a V2 action to the persisted CandidateState machine. */
function stateForAction(a: ShortTermActionV2): CandidateState {
  switch (a) {
    case "ENTRY_CONFIRMED":
      return "ENTRY_READY";
    case "ZONE_REACHED":
    case "WAIT_FOR_CONFIRMATION":
      return "WAIT_FOR_ENTRY";
    case "SETUP_DETECTED":
    case "RESEARCH_WATCH":
      return "WATCH";
    case "INVALIDATED":
      return "INVALIDATED";
    default:
      return "SCANNED";
  }
}

export class ShortTermScanService {
  async scan(paramsIn: Partial<ScanParams>): Promise<{
    scanRunId: string;
    params: ScanParams;
    marketStatus: Awaited<ReturnType<typeof liveMarketDataProvider.getMarketStatus>>;
    riskManager: ReturnType<typeof assessPortfolioRisk>;
    candidates: ShortTermCandidateView[];
    watchlist: ShortTermCandidateView[];
    universeSize: number;
    passedGates: number;
    qualifiedCount: number;
    watchlistCount: number;
    emptyMessage: string | null;
  }> {
    const params: ScanParams = { ...DEFAULT_SCAN_PARAMS, ...paramsIn };
    const marketStatus = await liveMarketDataProvider.getMarketStatus();
    const health = await modelHealthService.assess("quant-v1").catch(() => null);

    // Live-shadow evidence per setup×horizon → short-term model live authority (Part 24/25).
    // P0 #3 — live authority is measured in realized net R-MULTIPLE (not %),
    // and only FILLED shadow trades count (NEVER_ENTERED plans are not trades).
    const shadowRows: Array<{ setup_type: string; horizon: string; resolved: string; dates: string; exp: string | null }> = await AppDataSource.query(
      `SELECT setup_type, horizon,
              COUNT(*) FILTER (WHERE outcome IS NOT NULL AND (outcome->>'filled')::boolean IS TRUE)::text AS resolved,
              COUNT(DISTINCT anchor_date) FILTER (WHERE outcome IS NOT NULL AND (outcome->>'filled')::boolean IS TRUE)::text AS dates,
              AVG((outcome->>'netRMultiple')::numeric) FILTER (WHERE outcome IS NOT NULL AND (outcome->>'filled')::boolean IS TRUE)::text AS exp
         FROM short_term_shadow_predictions GROUP BY setup_type, horizon`
    ).catch(() => []);
    const shadowStatsBySetup = new Map<string, { resolved: number; distinctDates: number; expectancyR: number | null }>();
    for (const r of shadowRows)
      shadowStatsBySetup.set(`${r.setup_type}|${r.horizon}`, { resolved: Number(r.resolved), distinctDates: Number(r.dates), expectancyR: r.exp != null ? Number(r.exp) : null });

    // Risk manager over open paper positions (S6): limits block NEW entries only.
    const openPaper: Array<{ loss_at_stop: string | null; sector: string | null }> = await AppDataSource.query(
      `SELECT (metrics->>'lossAtStop') AS loss_at_stop, (plan->>'sector') AS sector
         FROM short_term_paper_trades WHERE status = 'OPEN'`
    ).catch(() => []);
    const realized: Array<{ today: string | null; week: string | null }> = await AppDataSource.query(
      `SELECT COALESCE(SUM(CASE WHEN exit_date = CURRENT_DATE THEN (metrics->>'pnlInr')::numeric END),0)::text AS today,
              COALESCE(SUM(CASE WHEN exit_date > CURRENT_DATE - 7 THEN (metrics->>'pnlInr')::numeric END),0)::text AS week
         FROM short_term_paper_trades WHERE status = 'CLOSED'`
    ).catch(() => [{ today: "0", week: "0" }]);
    const budget = params.budgetInr ?? 100_000;
    const riskManager = assessPortfolioRisk({
      budgetInr: budget,
      openPositions: openPaper.map((p) => ({ lossAtStop: Number(p.loss_at_stop ?? 0), sector: p.sector ?? "UNKNOWN" })),
      realizedTodayInr: Number(realized[0]?.today ?? 0),
      realizedWeekInr: Number(realized[0]?.week ?? 0),
      equityDrawdownPct: null, // populated once paper history exists
    });

    // ── STAGE 0: deterministic scan over the filtered universe ──────────────
    const universe = NSE_UNIVERSE.filter((u) => (params.sector ? u.sector === params.sector : true));
    const nifty = await marketDataService.getNiftyBars("1y");
    const niftyCloses = new Map(nifty.map((b) => [b.date, b.close]));
    // P0 #4 — real regime inputs (fetched once): VIX level + 1y percentile.
    const vixBars = await marketDataService.getIndiaVixBars("1y").catch(() => null);
    const vixLevel = vixBars && vixBars.length ? vixBars[vixBars.length - 1].close : null;
    const vixPctile1y = vixBars && vixBars.length >= 60 && vixLevel != null ? (vixBars.filter((b) => b.close < vixLevel).length / vixBars.length) * 100 : null;
    const regimeAvailable = nifty.length >= 200;

    // Sector indexes from cached bars (one pass).
    const barsByTicker = new Map<string, Awaited<ReturnType<typeof liveMarketDataProvider.getCompletedBars>>>();
    for (const u of universe) {
      try {
        const bars = await liveMarketDataProvider.getCompletedBars(u.ticker, "1y");
        if (bars.length >= 60) barsByTicker.set(u.ticker, bars);
      } catch {
        /* ticker skipped; absence is visible in universeSize vs scanned */
      }
    }
    const bySector = new Map<string, string[]>();
    for (const u of universe) if (barsByTicker.has(u.ticker)) bySector.set(u.sector, [...(bySector.get(u.sector) ?? []), u.ticker]);
    const sectorIdx = new Map<string, Map<string, number>>();
    for (const [sector, members] of bySector) {
      sectorIdx.set(
        sector,
        buildSectorIndex(
          members.map((t) => {
            const bars = barsByTicker.get(t)!;
            const closes = analysisCloses(bars);
            return bars.map((b, i) => ({ date: b.date, close: closes[i] }));
          })
        )
      );
    }

    const today = new Date();
    const views: ShortTermCandidateView[] = [];
    const relVolumeByTicker = new Map<string, number | null>();
    for (const u of universe) {
      const bars = barsByTicker.get(u.ticker);
      if (!bars) continue;
      const f = computeShortTermFeatures(bars, niftyCloses, sectorIdx.get(u.sector) ?? null);
      if (!f) continue;
      relVolumeByTicker.set(u.ticker, f.relVolume);
      // Price filter FIRST (cheap, deterministic).
      if (params.priceMin != null && f.price < params.priceMin) continue;
      if (params.priceMax != null && f.price > params.priceMax) continue;

      const eventRisk = await eventService.assessEventRisk(u.ticker, today).catch(() => null);
      // P0 #4 — REAL regime per stock (was hardcoded null/true). Failure to
      // compute ⇒ regime unknown ⇒ marketRegimeOk false (fail-closed in
      // confirmation, so it cannot reach ENTRY_CONFIRMED blind to regime).
      let regime: ReturnType<typeof assessRegime> | null = null;
      if (regimeAvailable) {
        try {
          regime = assessRegime({ niftyBars: nifty, vixLevel, vixPercentile1y: vixPctile1y, stockBars: bars, sectorRelativeStrength20pp: null, upcomingEventRisk: eventRisk?.upcomingEventRisk === true });
        } catch {
          regime = null;
        }
      }
      const marketRegimeOk = regime != null && regime.marketRegime !== "bear_high_vol";
      const setup = classifySetup(f, {
        marketRegime: regime?.marketRegime ?? null,
        stockRegime: regime?.stockRegime ?? null,
        upcomingEventRisk: eventRisk?.upcomingEventRisk === true,
      });
      // Strategy filter.
      if (params.strategy !== "ALL" && !STRATEGY_SETUPS[params.strategy].includes(setup.setupType)) continue;

      const plan = buildTradePlan(f, setup, params.horizon);
      const forecast = buildShortTermForecast({
        bars,
        niftyBars: nifty,
        horizon: params.horizon,
        setup,
        plan,
        price: f.price,
        calibratedTargetProb: null, // no meta-label model has passed calibration (study-verified)
      });
      forecast.expectedHoldingDays = await expectedHoldingDaysFor(setup.setupType, forecast.expectedHoldingDays);
      plan.expectedHoldingDays = forecast.expectedHoldingDays;
      const ev = bracketExpectedValuePct(forecast, plan, f.price);
      plan.expectedValueAfterCostsPct = ev.evAfterCostsPct;
      plan.expectedShortfallPct = ev.expectedShortfallPct;

      const analysis = analyzeBars(bars);
      const entryQuality = assessEntryQuality({
        baseTimingScore: null,
        price: f.price,
        technicals: analysis.technicals,
        fundamentals: null,
        intervalWidthPct30: forecast.p90Pct != null && forecast.p10Pct != null ? forecast.p90Pct - forecast.p10Pct : null,
        rewardRiskRatio: plan.rewardRiskToTarget1,
        marketRegime: null,
      });

      const lastBarDate = bars[bars.length - 1].date;
      const barAgeDays = Math.max(0, Math.floor((today.getTime() - new Date(lastBarDate).getTime()) / 86400_000));
      const dataQuality = Math.max(0, 100 - f.zeroVolumeBars20 * 20 - Math.max(0, barAgeDays - 1) * 15);
      const gates = evaluateGates({
        features: f,
        setup,
        plan,
        forecast,
        barAgeDays,
        dataQuality,
        modelHealthState: health?.overallState ?? null,
        minAdvInr: params.minAdvInr,
        riskAllowed: riskManager.newEntriesAllowed,
      });

      const entryRef = plan.entryZoneHigh ?? plan.entryTriggerPrice ?? f.price;

      // ── V2 EV uncertainty: the trade's own bracket across bootstrap paths ──
      const evEvidence = plan.initialStop != null && plan.target1 != null
        ? computeEvEvidence({
            dailyReturns: adjustedDailyReturns(bars.slice(-260)),
            entry: entryRef,
            stop: plan.initialStop,
            target1: plan.target1,
            maxHoldDays: HORIZON_TD[params.horizon].max,
            costPct: plan.transactionCostPct,
            slippagePct: plan.estimatedSlippagePct,
          })
        : null;
      const evOk = evGatePasses(evEvidence);

      // ── V2 setup-specific evidence (persisted study) + live authority ─────
      const setupEvidence = await setupEvidenceService.lookup(setup.setupType, params.horizon, null);
      const shadowStats = shadowStatsBySetup.get(`${setup.setupType}|${params.horizon}`) ?? { resolved: 0, distinctDates: 0, expectancyR: null };
      const stHealth = assessShortTermHealth({
        backtestUsableForEntry: setupEvidence.usableForEntry,
        resolvedShadowTrades: shadowStats.resolved,
        distinctShadowDates: shadowStats.distinctDates,
        liveExpectancyR: shadowStats.expectancyR,
      });
      const plausibility = assessLevels({
        entry: entryRef,
        stop: plan.initialStop ?? entryRef,
        target1: plan.target1 ?? entryRef,
        atr14: plan.atr14,
        ev: evEvidence,
        gapPctRecent: f.gapPct,
      });
      entryQuality && (entryQuality.score = Math.max(0, (entryQuality.score ?? 50) - plausibility.qualityPenalty));

      // ── V2 tier + confirmation + freshness semantics ──────────────────────
      const tierRes = computeTier({ setupEvidence, ev: evEvidence, plausibility, shortTermHealthState: stHealth.state, dataQuality });
      const freshnessV2: FreshnessV2 =
        marketStatus.session === "OPEN" ? "DELAYED_INTRADAY" : marketStatus.lastCompletedSession === lastBarDate ? "EOD_FINAL" : barAgeDays > 4 ? "STALE" : "EOD_FINAL";
      const confirmation = assessConfirmation(setup.setupType, f, {
        marketRegimeOk, // P0 #4: real regime (fail-closed when unknown)
        upcomingEventRisk: eventRisk?.upcomingEventRisk === true,
        freshDataOk: freshnessV2 === "EOD_FINAL",
      });
      const modelConfidence = forecast.modelConfidence;

      const geometryAction = deriveGeometryAction(setup.setupType, f.price, plan);

      // Provisional sizing (for affordability) — full sizing recomputed post-gate below.
      const provisionalSizing =
        params.budgetInr != null && plan.initialStop != null
          ? computePositionSize({ budgetInr: params.budgetInr, riskPerTradePct: params.riskPerTradePct, entryPrice: entryRef, stopPrice: plan.initialStop, atrPct: f.atrPct, relVolume: f.relVolume, advInr: f.advInr20 })
          : null;
      const affordable = params.budgetInr == null || (provisionalSizing?.positionSizeShares ?? 0) > 0;

      const contradictions = detectContradictions({
        geometryAction,
        tier: tierRes.tier,
        modelConfidence,
        modelHealthState: stHealth.state,
        freshness: freshnessV2,
        ev: evEvidence,
        setupEvidence,
        positionSizeShares: provisionalSizing?.positionSizeShares ?? null,
        rankingScore: null,
      });

      const ceiling = composeCeiling({
        tier: tierRes.tier as EvidenceTier,
        modelHealthState: stHealth.state,
        modelConfidence,
        freshness: freshnessV2,
        confirmationSatisfied: confirmation.satisfied,
        evLowerBoundPositive: evOk.ok,
        affordable,
        contradictionCeilings: contradictions.map((c) => c.cap as ShortTermActionV2),
      });
      // P0 #1: a stock IN the entry zone is eligible to become ENTRY_CONFIRMED —
      // the ceiling is the sole authority that decides whether it actually does
      // (tier A + confirmation + HEALTHY authority + EV lower bound > 0 + fresh
      // data + affordable + no contradiction). Without this promotion the
      // geometry action topped out at ZONE_REACHED and qualification was
      // structurally unreachable even with perfect evidence.
      const promotedGeometry: ShortTermActionV2 = geometryAction === "ZONE_REACHED" ? "ENTRY_CONFIRMED" : geometryAction;
      const finalAction = capAction(promotedGeometry, ceiling.ceiling);

      // ENTRY-eligibility gates (V2): setup usable + EV lower bound + all deterministic gates.
      const entryEligible = gates.passed && setupEvidence.usableForEntry && evOk.ok && tierRes.tier === "A" && stHealth.state === "HEALTHY";
      const sizing =
        entryEligible && params.budgetInr != null && plan.initialStop != null ? provisionalSizing : provisionalSizing;

      const whyNotEntry: string[] = [];
      if (finalAction !== "ENTRY_CONFIRMED") {
        if (!setupEvidence.usableForEntry) whyNotEntry.push(`setup "${setup.setupType}" has not demonstrated out-of-sample edge (tier ${setupEvidence.evidenceStrength}: ${setupEvidence.note})`);
        if (!evOk.ok) whyNotEntry.push(...evOk.reasons);
        if (modelConfidence === "LOW") whyNotEntry.push("short-term model confidence is LOW");
        if (stHealth.state !== "HEALTHY") whyNotEntry.push(`short-term live authority: ${stHealth.state} — ${stHealth.reasons[0]}`);
        if (freshnessV2 === "DELAYED_INTRADAY") whyNotEntry.push("quote is delayed intraday — awaiting next-session revalidation");
        if (!confirmation.satisfied) whyNotEntry.push(`confirmation not satisfied: ${confirmation.unmet.slice(0, 2).join("; ")}`);
        if (!affordable) whyNotEntry.push("not affordable under the current risk budget");
      }

      plan.expectedValueAfterCostsPct = evEvidence ? evEvidence.meanEvAfterCostsPct : plan.expectedValueAfterCostsPct;
      const freshness = await liveMarketDataProvider.getDataFreshness(`${lastBarDate}T15:30:00+05:30`);
      const risky = (f.atrPct ?? 0) > 4 || (f.realizedVol20AnnPct ?? 0) > 45;
      views.push({
        rank: null,
        ticker: u.ticker,
        name: u.name,
        sector: u.sector,
        currentPrice: f.price,
        freshness,
        freshnessV2,
        action: finalAction,
        state: stateForAction(finalAction),
        setupType: setup.setupType,
        setupScore: setup.setupScore,
        entryQuality: entryQuality?.score ?? null,
        modelHealth: stHealth.state,
        dataQuality,
        riskLevel: risky ? "HIGH" : (f.atrPct ?? 0) > 2.5 ? "MEDIUM" : "LOW",
        whyCandidate: setup.reasons,
        whatCanGoWrong: [
          plan.invalidationReason ?? "Setup can fail without warning; the stop defines the loss.",
          evEvidence ? `Worst-decile outcome ≈ ${evEvidence.expectedShortfallPct}% (${evEvidence.cvarR}R) before the stop caps it.` : "Downside distribution unavailable.",
          "Gap risk: an overnight gap can open beyond the stop — sizing assumes the stop, gaps can exceed it.",
        ],
        changedSincePrevious: null,
        plan,
        sizing,
        forecast,
        gates,
        rankingScore: null,
        aiSummary: null,
        tier: tierRes.tier,
        qualified: entryEligible && finalAction === "ENTRY_CONFIRMED" && affordable,
        geometryAction,
        ceilingReasons: ceiling.reasons,
        whyNotEntry,
        confirmation: { satisfied: confirmation.satisfied, met: confirmation.met, unmet: confirmation.unmet },
        contradictions,
        ev: evEvidence as unknown as Record<string, unknown> | null,
        setupEvidence: setupEvidence as unknown as Record<string, unknown>,
        plausibility: plausibility as unknown as Record<string, unknown>,
      });
    }

    // ── V2 ranking + Qualified vs Research Watchlist split (never forced) ────
    // "Interesting" = passed the base gates OR has a constructive plan worth watching.
    const passedGatesCount = views.filter((v) => v.gates.passed).length;
    const interestingViews = views.filter((v) => v.gates.passed || (v.tier !== "D" && v.geometryAction !== "NO_SETUP"));
    for (const v of interestingViews) {
      const evObj = v.ev as { ev80LowerPct?: number; expectedR?: number; cvarR?: number } | null;
      v.rankingScore = rankingScoreV2({
        evLowerBoundPct: evObj?.ev80LowerPct ?? null,
        expectedR: evObj?.expectedR ?? null,
        cvarR: evObj?.cvarR ?? null,
        tier: v.tier as EvidenceTier,
        confirmationSatisfied: v.confirmation?.satisfied ?? false,
        advInr: v.plan.advInr,
        slippagePct: v.plan.estimatedSlippagePct,
        atrPct: v.currentPrice && v.plan.atr14 ? (v.plan.atr14 / v.currentPrice) * 100 : null,
        relVolume: relVolumeByTicker.get(v.ticker) ?? null, // P0 #4: real relative volume
        setupUsableForEntry: (v.setupEvidence as { usableForEntry?: boolean } | null)?.usableForEntry ?? false,
        setupScore: v.setupScore,
      });
    }
    // Part O: portfolio context — when open paper positions exist, penalize
    // candidates that add correlated / concentrated exposure (marginal risk).
    if (openPaper.length > 0) {
      const openTickers: Array<{ ticker: string; sector: string; capitalInr: number }> = await AppDataSource.query(
        `SELECT ticker, COALESCE(plan->>'sector', 'UNKNOWN') AS sector, COALESCE((metrics->>'capitalRequired')::numeric, 0) AS capital
           FROM short_term_paper_trades WHERE status = 'OPEN'`
      ).then((rows: Array<{ ticker: string; sector: string; capital: string }>) =>
        rows.map((r) => ({ ticker: r.ticker, sector: r.sector, capitalInr: Number(r.capital) }))
      ).catch(() => []);
      const openSeries: Array<{ ticker: string; sector: string; capitalInr: number; returns: number[] }> = [];
      for (const op of openTickers) {
        const bars = barsByTicker.get(op.ticker);
        if (bars) openSeries.push({ ...op, returns: adjustedDailyReturns(bars.slice(-130)) });
      }
      if (openSeries.length > 0) {
        for (const v of interestingViews) {
          const bars = barsByTicker.get(v.ticker);
          if (!bars || v.rankingScore == null) continue;
          const ctxRes = assessPortfolioContext({
            candidateTicker: v.ticker,
            candidateSector: v.sector,
            candidateReturns: adjustedDailyReturns(bars.slice(-130)),
            candidateBeta60: null,
            openPositions: openSeries,
            candidateCapitalInr: v.sizing?.capitalRequired ?? 0,
          });
          if (ctxRes.rankingPenalty > 0) {
            v.rankingScore = Math.round((v.rankingScore - ctxRes.rankingPenalty) * 100) / 100;
            v.whatCanGoWrong.push(...ctxRes.notes.filter((n) => !n.startsWith("no adverse")));
          }
        }
      }
    }

    // QUALIFIED: tier A + ENTRY_CONFIRMED + affordable + gates. RESEARCH: the rest that's interesting.
    const qualified = interestingViews.filter((v) => v.qualified).sort((a, b) => (b.rankingScore ?? -999) - (a.rankingScore ?? -999));
    const watchlist = interestingViews.filter((v) => !v.qualified).sort((a, b) => (b.rankingScore ?? -999) - (a.rankingScore ?? -999));
    qualified.forEach((v, i) => (v.rank = i + 1));
    const limit = params.limit === 0 ? qualified.length : Math.min(Math.max(params.limit, 1), 50);
    const shown = qualified.slice(0, Math.max(limit, 0));
    const watchShown = watchlist.slice(0, params.limit === 0 ? watchlist.length : Math.max(limit, 10));

    // ── Persist: run, candidates, transitions, alerts, shadow predictions ───
    const runRepo = AppDataSource.getRepository(ShortTermScanRun);
    const run = await runRepo.save(
      runRepo.create({
        params: params as unknown as Record<string, unknown>,
        universeSize: universe.length,
        passedGates: passedGatesCount,
        qualifiedShown: shown.length,
        modelVersion: SHORT_TERM_VERSION,
        featureVersion: SHORT_TERM_FEATURE_VERSION,
        policyVersion: SHORT_TERM_POLICY_VERSION,
        dataProvider: liveMarketDataProvider.name,
        dataFreshness: shown[0]?.freshness.state ?? "DELAYED",
        dataTimestamp: new Date(),
        diagnostics: { scanned: views.length, riskManager: riskManager as unknown as Record<string, unknown> },
      })
    );

    const candRepo = AppDataSource.getRepository(ShortTermCandidate);
    const transRepo = AppDataSource.getRepository(ShortTermTransition);
    const alertRepo = AppDataSource.getRepository(ShortTermAlert);
    const shadowRepo = AppDataSource.getRepository(ShortTermShadowPrediction);

    const interesting = interestingViews;
    for (const v of interesting) {
      // Previous state for transition tracking.
      const prev = await candRepo
        .createQueryBuilder("c")
        .where("c.ticker = :t", { t: v.ticker })
        .orderBy("c.created_at", "DESC")
        .getOne();
      const prevState = prev?.state ?? "SCANNED";
      if (prev) {
        const changes: string[] = [];
        const prevPayload = prev.payload as { action?: string; plan?: { initialStop?: number | null; target1?: number | null } };
        if (prevPayload.action !== v.action) changes.push(`action ${prevPayload.action} → ${v.action}`);
        if (prevPayload.plan?.initialStop !== v.plan.initialStop) changes.push(`stop ${prevPayload.plan?.initialStop ?? "—"} → ${v.plan.initialStop ?? "—"}`);
        if (prevPayload.plan?.target1 !== v.plan.target1) changes.push(`T1 ${prevPayload.plan?.target1 ?? "—"} → ${v.plan.target1 ?? "—"}`);
        v.changedSincePrevious = changes.length ? changes : null;
      }
      if (prevState !== v.state) {
        await transRepo.save(
          transRepo.create({ ticker: v.ticker, fromState: prevState, toState: v.state, reason: v.whyCandidate[0] ?? v.action, scanRunId: run.id })
        );
        // Alert ONLY on transition, deduped per day+state.
        const alertType =
          v.state === "ENTRY_READY" ? "ENTRY_ZONE_REACHED" : v.state === "INVALIDATED" ? "ENTRY_INVALIDATED" : `STATE_${v.state}`;
        await alertRepo
          .createQueryBuilder()
          .insert()
          .values({
            ticker: v.ticker,
            alertType,
            message: `${v.ticker}: ${prevState} → ${v.state} (${v.setupType}); ${v.action}`,
            dedupeKey: `${new Date().toISOString().slice(0, 10)}|${v.state}`,
          } as never)
          .orIgnore()
          .execute();
      }
      await candRepo.save(
        candRepo.create({
          scanRunId: run.id,
          ticker: v.ticker,
          state: v.state,
          action: v.action,
          setupType: v.setupType,
          rank: v.rank,
          rankingScore: v.rankingScore != null ? v.rankingScore.toFixed(2) : null,
          passedGates: v.gates.passed,
          payload: v as unknown as Record<string, unknown>,
        })
      );
      // Shadow prediction for every PASSING candidate (S9) — one per anchor.
      if (v.gates.passed) {
        await shadowRepo
          .createQueryBuilder()
          .insert()
          .values({
            ticker: v.ticker,
            anchorDate: v.freshness.lastUpdate?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
            setupType: v.setupType,
            horizon: params.horizon,
            modelVersion: SHORT_TERM_VERSION,
            plan: v.plan as unknown as Record<string, unknown>,
            forecast: v.forecast as unknown as Record<string, unknown>,
          } as never)
          .orIgnore()
          .execute();
      }
    }

    return {
      scanRunId: run.id,
      params,
      marketStatus,
      riskManager,
      candidates: shown, // QUALIFIED trades only (tier A, ENTRY_CONFIRMED, affordable)
      watchlist: watchShown, // interesting but not yet actionable
      universeSize: universe.length,
      passedGates: passedGatesCount,
      qualifiedCount: qualified.length,
      watchlistCount: watchlist.length,
      emptyMessage:
        shown.length === 0
          ? "No statistically attractive short-term setups currently pass the risk and evidence gates. Interesting setups are on the Research Watchlist below."
          : null,
    };
  }
}

export const shortTermScanService = new ShortTermScanService();
