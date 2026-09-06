/**
 * DecisionService (Phase C, spec §9) — the ONE evidence-gated decision path.
 * Publishes immutable DecisionSnapshot rows; every surface reads the latest
 * snapshot, so identical context always shows identical advice (13.14).
 *
 * Publication happens on the evening cron (after issuance) or via the
 * authenticated POST — never on a GET (B1 read/write contract).
 */

import { AppDataSource } from "../../config/database";
import { DecisionSnapshot, ForecastRun, Instrument } from "../../entities";
import { HttpError } from "../../types";
import { forecastService } from "../forecast/ForecastService";
import { sessionCalendarService } from "../forecast/SessionCalendarService";
import { calendarDaysBetween, istDateString } from "../forecast/dates";
import {
  DECISION_POLICY_VERSION,
  evaluateEntryPolicy,
  PolicyInputs,
} from "./policy";
import {
  annualizedVolPct,
  assessHorizonSuitability,
  maxDrawdownPct,
} from "./horizonPolicy";
import { marketDataService } from "../market/MarketDataService";
import { IntelligenceRepository } from "../intelligence/IntelligenceRepository";
import { intelligenceQualityScore } from "../quant/intelligenceQuality";

export class DecisionService {
  /** Latest published snapshot (may be expired — expiry is reported, not hidden). */
  async latest(ticker: string): Promise<{ snapshot: DecisionSnapshot | null; expired: boolean }> {
    const instrument = await this.resolveInstrument(ticker);
    const snapshot = await AppDataSource.getRepository(DecisionSnapshot).findOne({
      where: { instrumentId: instrument.id },
      order: { asOf: "DESC" },
    });
    return { snapshot, expired: snapshot ? snapshot.validUntil.getTime() < Date.now() : false };
  }

  /** Compute policy v1 over stored evidence and publish a new snapshot. */
  async publish(ticker: string): Promise<DecisionSnapshot> {
    const instrument = await this.resolveInstrument(ticker);
    const now = new Date();
    const today = istDateString(now);

    // Latest stored issuance (never issued here — cron/POST /issue owns that).
    const run = await AppDataSource.getRepository(ForecastRun).findOne({
      where: { instrumentId: instrument.id, viewKind: "next30" },
      order: { anchorSessionDate: "DESC", issuedAt: "DESC" },
    });

    const lastObserved = await sessionCalendarService.lastObservedSession(today);

    let issuanceInputs: PolicyInputs["issuance"] = null;
    let validUntil = new Date(now.getTime() + 24 * 3600 * 1000); // fallback: 24h
    if (run) {
      const view = await forecastService.toView(run);
      const sessions = view.days.filter((d) => d.prices != null);
      const first = sessions[0];
      const last = sessions[sessions.length - 1];
      // Annualized vol derived from the issuance's OWN step-1 80% band:
      // p90−p10 ≈ 2 × 1.2816 σ_daily × anchor.
      const annualizedVolPct =
        first && first.prices
          ? ((first.prices.p90 - first.prices.p10) / (2 * 1.2816 * view.anchorPrice)) *
            Math.sqrt(252) *
            100
          : null;
      issuanceInputs = {
        anchorSessionDate: view.anchorSessionDate,
        anchorAgeDays: calendarDaysBetween(view.anchorSessionDate, today),
        anchorIsLatestObservedSession: lastObserved == null || view.anchorSessionDate >= lastObserved,
        targetSessionCount: view.targetSessionCount,
        annualizedVolPct,
        medianReturnPct30: last?.medianReturnPct ?? null,
      };
      // Entry opinions expire at the close of the first upcoming expected session.
      const next = sessions.find((d) => d.date >= today);
      if (next) validUntil = new Date(`${next.date}T15:30:00+05:30`);
    }

    // Measured 30d walk-forward stats for THIS ticker (stored, never recomputed here).
    const measuredRows: Array<{
      samples: number | null;
      hit: string | null;
      band: string | null;
      brier: string | null;
    }> = await AppDataSource.query(
      `SELECT (e->>'samples')::int AS samples,
              e->>'directionHitRatePct' AS hit,
              e->>'withinBandPct' AS band,
              e->>'brierScore' AS brier
         FROM model_performance mp, jsonb_array_elements(mp.horizons) e
        WHERE mp.ticker = $1 AND e->>'horizonDays' = '30'
        ORDER BY mp.ran_at DESC NULLS LAST LIMIT 1`,
      [instrument.yahooTicker]
    );
    const mr = measuredRows[0];
    const measured =
      mr && mr.samples != null && mr.hit != null && mr.band != null && mr.brier != null
        ? {
            samples: mr.samples,
            directionHitRatePct: Number(mr.hit),
            withinBandPct: Number(mr.band),
            brierScore: Number(mr.brier),
          }
        : null;

    // After close: IST time past 15:30, or a non-session day.
    const istNow = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now);
    const afterMarketClose = istNow >= "15:30" || lastObserved !== today;

    const decision = evaluateEntryPolicy({
      ticker: instrument.yahooTicker,
      issuance: issuanceInputs,
      measured,
      afterMarketClose,
    });

    // Risk-character holding-horizon assessment (owner request; spec §9's
    // separate horizon evidence). Measured inputs only: a year of real bars
    // for vol/drawdown + the stored filings quality score when one exists.
    // A failure here never blocks the entry decision — horizon stays null.
    let horizonSuitability: Record<string, unknown> | null = null;
    try {
      const bars = await marketDataService.getDailyBars(instrument.yahooTicker, "1y");
      const closes = bars.map((b) => b.close);
      const rets: number[] = [];
      for (let i = 1; i < closes.length; i++) {
        if (closes[i - 1] > 0) rets.push(closes[i] / closes[i - 1] - 1);
      }
      let qualityScore: number | null = null;
      try {
        const stored = await new IntelligenceRepository().latestStoredMetrics([instrument.yahooTicker]);
        const m = stored.get(instrument.yahooTicker.replace(/\.(NS|BO)$/i, "").toUpperCase());
        if (m) {
          const q = intelligenceQualityScore({
            roic: m.roic,
            fcf: m.fcf,
            revenue: m.revenue,
            currentRatio: m.currentRatio,
            currentRatioNotMeaningful: m.currentRatioNotMeaningful,
            peg: m.peg,
          });
          qualityScore = q ? q.score : null;
        }
      } catch {
        qualityScore = null; // stored-metrics read failure = no evidence, stated
      }
      horizonSuitability = assessHorizonSuitability({
        ticker: instrument.yahooTicker,
        barCount: bars.length,
        annualizedVolPct: annualizedVolPct(rets),
        maxDrawdownPct: maxDrawdownPct(closes),
        qualityScore,
      }) as unknown as Record<string, unknown>;
    } catch {
      horizonSuitability = null;
    }

    const repo = AppDataSource.getRepository(DecisionSnapshot);
    return repo.save(
      repo.create({
        instrumentId: instrument.id,
        ticker: instrument.yahooTicker,
        decisionStatus: decision.decisionStatus,
        evidenceStatus: decision.evidenceStatus,
        riskLevel: decision.riskLevel,
        intendedHorizon: decision.intendedHorizon,
        reasons: decision.reasons,
        risks: decision.risks,
        holdingsReviewNote: decision.holdingsReviewNote,
        horizonSuitability,
        inputs: {
          runId: run?.id ?? null,
          issuance: issuanceInputs,
          measured,
          afterMarketClose,
          lastObservedSession: lastObserved,
        },
        asOf: now,
        validUntil,
        modelVersion: run?.modelVersion ?? "none",
        decisionPolicyVersion: DECISION_POLICY_VERSION,
      })
    );
  }

  /** Publish for every followed/held instrument (evening cron; idempotent enough — one snapshot per run). */
  async publishForAll(): Promise<{ published: number; failed: Array<{ ticker: string; error: string }> }> {
    const rows: Array<{ ticker: string }> = await AppDataSource.query(
      `SELECT DISTINCT i.yahoo_ticker AS ticker FROM instruments i
        WHERE i.id IN (SELECT instrument_id FROM watchlist_items)
           OR i.id IN (SELECT instrument_id FROM ledger_transactions WHERE type IN ('BUY','SELL'))
        ORDER BY ticker`
    );
    let published = 0;
    const failed: Array<{ ticker: string; error: string }> = [];
    for (const r of rows) {
      try {
        await this.publish(r.ticker);
        published++;
      } catch (e) {
        failed.push({ ticker: r.ticker, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { published, failed };
  }

  private async resolveInstrument(ticker: string): Promise<Instrument> {
    const t = ticker.trim().toUpperCase();
    const candidates = [t, t.endsWith(".NS") ? t : `${t}.NS`];
    const found = await AppDataSource.getRepository(Instrument)
      .createQueryBuilder("i")
      .where("i.yahoo_ticker IN (:...c)", { c: candidates })
      .getOne();
    if (!found) throw new HttpError(404, `${ticker} is not in the supported instrument universe.`);
    return found;
  }
}

export const decisionService = new DecisionService();
export default decisionService;
