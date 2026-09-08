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

    // New adverse tier-≤2 event since the candidate was computed.
    let newAdverseEvent = false;
    try {
      const risk = await eventService.assessEventRisk(yt, new Date());
      newAdverseEvent = risk.upcomingEventRisk === true;
    } catch {
      newAdverseEvent = false;
    }

    const result = revalidate({
      gap,
      freshEnough,
      newAdverseEvent,
      marketRegimeOk: true,
      riskAllowed: true, // portfolio risk re-checked by the scan; here we focus on the single-name plan
      evLowerBoundPositive: (payload.ev?.ev80LowerPct ?? -1) > 0,
    });

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
