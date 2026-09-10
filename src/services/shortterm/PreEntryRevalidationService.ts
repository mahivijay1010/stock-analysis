/**
 * PreEntryRevalidationService (Part 12) — before any real entry, re-check the
 * plan against a FRESH quote: gap policy, freshness, new events, regime, risk,
 * EV. A plan generated after yesterday's close never blindly triggers today.
 */

import { AppDataSource } from "../../config/database";
import { ShortTermCandidate } from "../../entities";
import { HttpError } from "../../types";
import { liveMarketDataProvider } from "./LiveMarketDataProvider";
import { eventService } from "../market/EventService";
import { marketDataService } from "../market/MarketDataService";
import { assessRegime } from "../decision/regimeEngine";
import { assessPortfolioRisk } from "./sizing";
import { assessGap, revalidate, GapAssessment } from "./gapPolicy";

export interface RevalidationReport {
  ticker: string;
  ok: boolean;
  referencePrice: number | null;
  freshness: string;
  gap: GapAssessment;
  vetoes: string[];
  recommendation: string;
  planSnapshot: Record<string, unknown>;
}

export class PreEntryRevalidationService {
  async revalidate(ticker: string): Promise<RevalidationReport> {
    const t = ticker.trim().toUpperCase();
    const yt = /\.(NS|BO)$/.test(t) ? t : `${t}.NS`;
    const cand = await AppDataSource.getRepository(ShortTermCandidate)
      .createQueryBuilder("c")
      .where("c.ticker = :yt", { yt })
      .orderBy("c.created_at", "DESC")
      .getOne();
    if (!cand) throw new HttpError(404, `${yt} has no short-term plan to revalidate — run a scan first.`);
    const payload = cand.payload as {
      plan?: {
        entryZoneLow?: number | null;
        entryZoneHigh?: number | null;
        entryTriggerPrice?: number | null;
        initialStop?: number | null;
        target1?: number | null;
        atr14?: number | null;
        entryType?: string;
      };
      setupType?: string;
      ev?: { ev80LowerPct?: number } | null;
    };
    const plan = payload.plan ?? {};

    let quote: Awaited<ReturnType<typeof liveMarketDataProvider.getQuote>> | null = null;
    try {
      quote = await liveMarketDataProvider.getQuote(yt);
    } catch {
      quote = null;
    }
    const status = await liveMarketDataProvider.getMarketStatus();
    const freshEnough = quote != null && (quote.freshness.state === "LIVE" || status.session !== "OPEN");

    const gap = assessGap({
      referencePrice: quote?.price ?? NaN,
      entryZoneLow: plan.entryZoneLow ?? null,
      entryZoneHigh: plan.entryZoneHigh ?? null,
      initialStop: plan.initialStop ?? null,
      target1: plan.target1 ?? null,
      atr14: plan.atr14 ?? null,
      entryType: plan.entryType ?? "PULLBACK_ZONE",
    });

    // P0 #5 — FAIL-CLOSED: every advertised safety control must be VERIFIED.
    // A provider/computation failure counts as "unverified" ⇒ veto, never a
    // silent pass. An unverified event/regime/risk check can NEVER return
    // PROCEED.
    const unverified: string[] = [];

    // (a) New adverse event — unavailable ⇒ cannot rule one out ⇒ veto.
    let newAdverseEvent = false;
    try {
      const risk = await eventService.assessEventRisk(yt, new Date());
      newAdverseEvent = risk.upcomingEventRisk === true;
    } catch {
      unverified.push("event provider unavailable — cannot confirm the absence of an adverse event");
    }

    // (b) Market regime — actually computed (fail-closed on failure).
    let marketRegimeOk = false;
    try {
      const [niftyBars, vixBars, stockBars] = await Promise.all([
        marketDataService.getNiftyBars("1y").catch(() => null),
        marketDataService.getIndiaVixBars("1y").catch(() => null),
        marketDataService.getDailyBars(yt, "1y").catch(() => null),
      ]);
      if (!niftyBars || !stockBars) {
        unverified.push("market/stock bars unavailable — regime not re-verified");
      } else {
        const vixLevel = vixBars && vixBars.length ? vixBars[vixBars.length - 1].close : null;
        const vixPctile =
          vixBars && vixBars.length >= 60 && vixLevel != null ? (vixBars.filter((b) => b.close < vixLevel).length / vixBars.length) * 100 : null;
        const regime = assessRegime({ niftyBars, vixLevel, vixPercentile1y: vixPctile, stockBars, sectorRelativeStrength20pp: null });
        marketRegimeOk = regime.marketRegime !== "bear_high_vol" && !["extended_uptrend", "late_trend", "high_event_risk"].includes(regime.entryRegime);
      }
    } catch {
      unverified.push("regime engine failed — regime not re-verified");
    }

    // (c) Portfolio risk — recomputed from open paper positions (fail-closed).
    let riskAllowed = false;
    try {
      const openPaper: Array<{ loss_at_stop: string | null; sector: string | null }> = await AppDataSource.query(
        `SELECT (metrics->>'lossAtStop') AS loss_at_stop, (plan->>'sector') AS sector FROM short_term_paper_trades WHERE status = 'OPEN'`
      );
      const rm = assessPortfolioRisk({
        budgetInr: 100_000,
        openPositions: openPaper.map((p) => ({ lossAtStop: Number(p.loss_at_stop ?? 0), sector: p.sector ?? "UNKNOWN" })),
        realizedTodayInr: 0,
        realizedWeekInr: 0,
        equityDrawdownPct: null,
      });
      riskAllowed = rm.newEntriesAllowed;
    } catch {
      unverified.push("portfolio risk state unavailable — not re-verified");
    }

    const result = revalidate({
      gap,
      freshEnough,
      newAdverseEvent,
      marketRegimeOk,
      riskAllowed,
      evLowerBoundPositive: (payload.ev?.ev80LowerPct ?? -1) > 0,
    });
    result.vetoes.push(...unverified);
    if (unverified.length > 0) result.ok = false;

    const recommendation = result.ok
      ? "PROCEED — plan still valid on fresh data; place the entry per the plan."
      : gap.decision === "INVALIDATED"
        ? "INVALIDATED — do not enter; the setup is void on today's price."
        : gap.decision === "RECOMPUTE"
          ? "RECOMPUTE — re-run the scan; the gap moved the plan."
          : gap.decision === "DO_NOT_CHASE"
            ? "DO NOT CHASE — price ran away from the zone; wait for a pullback."
            : "WAIT — conditions to enter are not satisfied yet.";

    return {
      ticker: yt,
      ok: result.ok,
      referencePrice: quote?.price ?? null,
      freshness: quote?.freshness.state ?? "STALE",
      gap,
      vetoes: result.vetoes,
      recommendation,
      planSnapshot: plan as Record<string, unknown>,
    };
  }
}

export const preEntryRevalidationService = new PreEntryRevalidationService();
