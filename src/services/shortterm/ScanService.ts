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
import { buildShortTermForecast, bracketExpectedValuePct } from "./model";
import { evaluateGates } from "./ranking";
import { computePositionSize, assessPortfolioRisk } from "./sizing";
import {
  CandidateState,
  DEFAULT_SCAN_PARAMS,
  HORIZON_TD,
  ScanParams,
  ShortTermAction,
  ShortTermCandidateView,
  SHORT_TERM_FEATURE_VERSION,
  SHORT_TERM_POLICY_VERSION,
  SHORT_TERM_VERSION,
  STRATEGY_SETUPS,
} from "./types";

function deriveActionState(view: {
  passed: boolean;
  setupType: string;
  price: number;
  plan: ShortTermCandidateView["plan"];
}): { action: ShortTermAction; state: CandidateState } {
  if (!view.passed) {
    const constructive = ["PULLBACK_IN_UPTREND", "BREAKOUT_CONFIRMATION", "MOMENTUM_CONTINUATION", "VOLATILITY_CONTRACTION", "MEAN_REVERSION"].includes(view.setupType);
    if (view.setupType === "HIGH_EVENT_RISK" || view.setupType === "LATE_TREND" || view.setupType === "FAILED_BREAKOUT")
      return { action: "NO_TRADE", state: "SCANNED" };
    return constructive ? { action: "WATCH", state: "WATCH" } : { action: "NO_TRADE", state: "SCANNED" };
  }
  const p = view.plan;
  if (p.entryType === "BREAKOUT_TRIGGER") {
    // Breakout setups: confirmed on the completed bar only when the setup type says so.
    if (view.setupType === "BREAKOUT_CONFIRMATION") return { action: "ENTRY_ZONE", state: "ENTRY_READY" };
    return { action: "BREAKOUT_CONFIRMATION", state: "WAIT_FOR_ENTRY" };
  }
  if (p.entryZoneLow != null && p.entryZoneHigh != null) {
    if (view.price >= p.entryZoneLow && view.price <= p.entryZoneHigh) return { action: "ENTRY_ZONE", state: "ENTRY_READY" };
    return { action: "WAIT_FOR_ENTRY", state: "WAIT_FOR_ENTRY" };
  }
  return { action: "WATCH", state: "WATCH" };
}

export class ShortTermScanService {
  async scan(paramsIn: Partial<ScanParams>): Promise<{
    scanRunId: string;
    params: ScanParams;
    marketStatus: Awaited<ReturnType<typeof liveMarketDataProvider.getMarketStatus>>;
    riskManager: ReturnType<typeof assessPortfolioRisk>;
    candidates: ShortTermCandidateView[];
    universeSize: number;
    passedGates: number;
    emptyMessage: string | null;
  }> {
    const params: ScanParams = { ...DEFAULT_SCAN_PARAMS, ...paramsIn };
    const marketStatus = await liveMarketDataProvider.getMarketStatus();
    const health = await modelHealthService.assess("quant-v1").catch(() => null);

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
    for (const u of universe) {
      const bars = barsByTicker.get(u.ticker);
      if (!bars) continue;
      const f = computeShortTermFeatures(bars, niftyCloses, sectorIdx.get(u.sector) ?? null);
      if (!f) continue;
      // Price filter FIRST (cheap, deterministic).
      if (params.priceMin != null && f.price < params.priceMin) continue;
      if (params.priceMax != null && f.price > params.priceMax) continue;

      const eventRisk = await eventService.assessEventRisk(u.ticker, today).catch(() => null);
      const setup = classifySetup(f, {
        marketRegime: null,
        stockRegime: null,
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
      const sizing =
        gates.passed && params.budgetInr != null && plan.initialStop != null
          ? computePositionSize({
              budgetInr: params.budgetInr,
              riskPerTradePct: params.riskPerTradePct,
              entryPrice: entryRef,
              stopPrice: plan.initialStop,
              atrPct: f.atrPct,
              relVolume: f.relVolume,
              advInr: f.advInr20,
            })
          : null;

      const { action, state } = deriveActionState({ passed: gates.passed, setupType: setup.setupType, price: f.price, plan });
      const freshness = await liveMarketDataProvider.getDataFreshness(`${lastBarDate}T15:30:00+05:30`);

      const risky = (f.atrPct ?? 0) > 4 || (f.realizedVol20AnnPct ?? 0) > 45;
      views.push({
        rank: null,
        ticker: u.ticker,
        name: u.name,
        sector: u.sector,
        currentPrice: f.price,
        freshness,
        action,
        state,
        setupType: setup.setupType,
        setupScore: setup.setupScore,
        entryQuality: entryQuality?.score ?? null,
        modelHealth: health?.overallState ?? "UNKNOWN",
        dataQuality,
        riskLevel: risky ? "HIGH" : (f.atrPct ?? 0) > 2.5 ? "MEDIUM" : "LOW",
        whyCandidate: setup.reasons,
        whatCanGoWrong: [
          plan.invalidationReason ?? "Setup can fail without warning; the stop defines the loss.",
          `Expected shortfall in the worst decile ≈ ${plan.expectedShortfallPct ?? "n/a"}% before the stop caps it.`,
          "Gap risk: an overnight gap can open beyond the stop — position sizing assumes the stop, gaps can exceed it.",
        ],
        changedSincePrevious: null,
        plan,
        sizing,
        forecast,
        gates,
        rankingScore: null,
        aiSummary: null,
      });
    }

    // ── Gates → ranking → UP TO N (never forced) ────────────────────────────
    const passing = views.filter((v) => v.gates.passed);
    const scored = passing
      .map((v) => ({ v, s: v.plan.expectedValueAfterCostsPct != null ? rankingScoreFromView(v) : -999 }))
      .sort((a, b) => b.s - a.s);
    scored.forEach((x, i) => {
      x.v.rankingScore = x.s;
      x.v.rank = i + 1;
    });
    const limit = params.limit === 0 ? scored.length : Math.min(Math.max(params.limit, 1), 50);
    const shown = scored.slice(0, Math.max(limit, 0)).map((x) => x.v);

    // ── Persist: run, candidates, transitions, alerts, shadow predictions ───
    const runRepo = AppDataSource.getRepository(ShortTermScanRun);
    const run = await runRepo.save(
      runRepo.create({
        params: params as unknown as Record<string, unknown>,
        universeSize: universe.length,
        passedGates: passing.length,
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

    const interesting = views.filter((v) => v.gates.passed || v.state !== "SCANNED");
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
      candidates: shown,
      universeSize: universe.length,
      passedGates: passing.length,
      emptyMessage:
        shown.length === 0
          ? "No statistically attractive short-term setups currently pass the risk and evidence gates."
          : null,
    };
  }
}

/** Ranking objective over the assembled view (EV + R:R + entry quality + liquidity − penalties). */
function rankingScoreFromView(v: ShortTermCandidateView): number {
  const ev = v.plan.expectedValueAfterCostsPct ?? 0;
  const excess = v.forecast.expectedExcessReturnPct ?? 0;
  const rr = Math.min(3, v.plan.rewardRiskToTarget1 ?? 0);
  const eq = (v.entryQuality ?? 50) / 100;
  const liq = Math.min(1, (v.plan.advInr ?? 0) / 100_000_000);
  let score = ev * 8 + excess * 3 + rr * 6 + eq * 10 + liq * 4 + v.setupScore / 10;
  score -= v.plan.estimatedSlippagePct * 10;
  if ((v.plan.atr14 ?? 0) > 0 && v.currentPrice != null && v.currentPrice > 0) {
    const atrPct = ((v.plan.atr14 as number) / v.currentPrice) * 100;
    if (atrPct > 4) score -= (atrPct - 4) * 3;
  }
  if (v.riskLevel === "HIGH") score -= 5;
  return Math.round(score * 100) / 100;
}

export const shortTermScanService = new ShortTermScanService();
