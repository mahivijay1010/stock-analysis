/**
 * Forecast vintages + drift engine (upgrade Parts 10/11).
 *
 * Two explicit concepts, both from IMMUTABLE forecast_runs rows:
 *   ORIGINAL FORECAST — the oldest next-30 issuance whose window still covers
 *     today; used for scoring/accountability, never rewritten;
 *   CURRENT FORECAST — the latest issuance (freshest anchor).
 *
 * Drift state (deterministic thresholds, fixed here before observing outputs):
 *   INVALIDATED — price outside the original 80% band at today's offset, OR
 *                 |price − median| > 1.5 forecast-σ, OR stock regime has
 *                 flipped to downtrend since issuance;
 *   DRIFTING    — |price − median| > 1.0 ATR(14), OR > 1.0 forecast-σ, OR a
 *                 tier ≤ 2 material event arrived after issuance, OR volume
 *                 anomaly (last session > 2.5× 20d average);
 *   NORMAL      — none of the above.
 *
 * The original run is NEVER modified: drift produces a new assessment (and
 * the nightly cron may issue a NEW current forecast), preserving every old
 * prediction for validation.
 */

import { AppDataSource } from "../../config/database";
import { ForecastRun, Instrument, StructuredMarketEvent } from "../../entities";
import { HttpError } from "../../types";
import { forecastService } from "./ForecastService";
import { istDateString } from "./dates";
import { marketDataService } from "../market/MarketDataService";
import { analysisCloses } from "../market/canonical";

export const DRIFT_VERSION = "forecast-drift-v1";

export type DriftState = "NORMAL" | "DRIFTING" | "INVALIDATED";

export interface VintageSummary {
  runId: string;
  issuedAt: string;
  anchorSessionDate: string;
  anchorPrice: number;
  medianAtToday: number | null;
  p10AtToday: number | null;
  p90AtToday: number | null;
  medianReturnPct30: number | null;
  insideBand80: boolean | null;
  errorPct: number | null; // (price − median)/median × 100 at today's offset
}

export interface DriftAssessment {
  version: string;
  ticker: string;
  asOf: string;
  currentPrice: number | null;
  original: VintageSummary | null;
  current: VintageSummary | null;
  drift: {
    state: DriftState;
    reasons: string[];
    distanceAtr: number | null;
    distanceSigma: number | null;
    regimeChanged: boolean;
    materialEventArrived: boolean;
    volumeAnomaly: boolean;
  } | null;
}

export class ForecastDriftService {
  private async summarize(run: ForecastRun, today: string, price: number | null): Promise<VintageSummary> {
    const view = await forecastService.toView(run);
    const rows = view.days.filter((d) => d.prices != null);
    // Today's offset row: the latest forecast day ≤ today (carry rows excluded above).
    const atToday = [...rows].reverse().find((d) => d.date <= today) ?? null;
    const median = atToday?.prices?.p50 ?? null;
    const last = rows[rows.length - 1] ?? null;
    return {
      runId: run.id,
      issuedAt: run.issuedAt.toISOString(),
      anchorSessionDate: view.anchorSessionDate,
      anchorPrice: view.anchorPrice,
      medianAtToday: median,
      p10AtToday: atToday?.prices?.p10 ?? null,
      p90AtToday: atToday?.prices?.p90 ?? null,
      medianReturnPct30: last?.medianReturnPct ?? null,
      insideBand80:
        price != null && atToday?.prices ? price >= atToday.prices.p10 && price <= atToday.prices.p90 : null,
      errorPct: price != null && median != null && median > 0 ? Math.round(((price - median) / median) * 10000) / 100 : null,
    };
  }

  async assess(ticker: string): Promise<DriftAssessment> {
    const t = ticker.trim().toUpperCase();
    const yahooTicker = /\.(NS|BO)$/.test(t) ? t : `${t}.NS`;
    const instrument = await AppDataSource.getRepository(Instrument)
      .createQueryBuilder("i")
      .where("i.yahoo_ticker = :yt", { yt: yahooTicker })
      .getOne();
    if (!instrument) throw new HttpError(404, `${ticker} is not in the supported instrument universe.`);

    const today = istDateString(new Date());
    const runs = await AppDataSource.getRepository(ForecastRun).find({
      where: { instrumentId: instrument.id, viewKind: "next30" },
      order: { anchorSessionDate: "DESC", issuedAt: "DESC" },
      take: 40,
    });
    if (runs.length === 0) {
      return { version: DRIFT_VERSION, ticker: yahooTicker, asOf: new Date().toISOString(), currentPrice: null, original: null, current: null, drift: null };
    }
    const cutoff = new Date(Date.now() - 35 * 86400_000).toISOString().slice(0, 10);
    const active = runs.filter((r) => r.anchorSessionDate >= cutoff);
    const currentRun = runs[0];
    const originalRun = active.length > 0 ? active[active.length - 1] : currentRun;

    let price: number | null = null;
    let atr14: number | null = null;
    let volumeAnomaly = false;
    try {
      const bars = await marketDataService.getDailyBars(yahooTicker, "6mo");
      const closes = analysisCloses(bars);
      price = closes[closes.length - 1] ?? null;
      if (bars.length > 15) {
        let s = 0;
        for (let i = bars.length - 14; i < bars.length; i++) {
          const tr = Math.max(
            bars[i].high - bars[i].low,
            Math.abs(bars[i].high - closes[i - 1]),
            Math.abs(bars[i].low - closes[i - 1])
          );
          s += tr;
        }
        atr14 = s / 14;
      }
      const vols = bars.slice(-21, -1).map((b) => b.volume).filter((v) => v > 0);
      const avg = vols.length >= 10 ? vols.reduce((a, b) => a + b, 0) / vols.length : null;
      const lastVol = bars[bars.length - 1]?.volume ?? 0;
      volumeAnomaly = avg != null && lastVol > 2.5 * avg;
    } catch {
      /* price/ATR unavailable ⇒ drift falls back to what it can compute */
    }

    const original = await this.summarize(originalRun, today, price);
    const current = originalRun.id === currentRun.id ? original : await this.summarize(currentRun, today, price);

    // Regime change + material events since the ORIGINAL issuance.
    let regimeChanged = false;
    try {
      const snaps: Array<{ stock_regime: string }> = await AppDataSource.query(
        `SELECT inputs->'regime'->>'stockRegime' AS stock_regime
           FROM decision_snapshots WHERE instrument_id = $1 AND as_of >= $2
          ORDER BY as_of ASC`,
        [instrument.id, originalRun.issuedAt]
      );
      const states = snaps.map((s) => s.stock_regime).filter(Boolean);
      regimeChanged = states.length >= 2 && states[0] !== states[states.length - 1];
      if (states.length > 0 && states[states.length - 1] === "downtrend") regimeChanged = true;
    } catch {
      regimeChanged = false;
    }
    const materialEvents = await AppDataSource.getRepository(StructuredMarketEvent)
      .createQueryBuilder("e")
      .where("e.ticker = :base", { base: yahooTicker.replace(/\.(NS|BO)$/, "") })
      .andWhere("e.source_tier <= 2")
      .andWhere("e.announced_at > :since", { since: originalRun.issuedAt })
      .getCount()
      .catch(() => 0);

    const reasons: string[] = [];
    let state: DriftState = "NORMAL";
    const median = original.medianAtToday;
    const sigma =
      original.p90AtToday != null && original.p10AtToday != null ? (original.p90AtToday - original.p10AtToday) / (2 * 1.2816) : null;
    const distanceAtr = price != null && median != null && atr14 != null && atr14 > 0 ? (price - median) / atr14 : null;
    const distanceSigma = price != null && median != null && sigma != null && sigma > 0 ? (price - median) / sigma : null;

    if (original.insideBand80 === false) {
      state = "INVALIDATED";
      reasons.push("Price is outside the original 80% interval at today's offset.");
    } else if (distanceSigma != null && Math.abs(distanceSigma) > 1.5) {
      state = "INVALIDATED";
      reasons.push(`Price is ${Math.abs(distanceSigma).toFixed(1)} forecast-σ from the original median.`);
    } else {
      if (distanceAtr != null && Math.abs(distanceAtr) > 1.0) {
        state = "DRIFTING";
        reasons.push(`Price has moved ${Math.abs(distanceAtr).toFixed(1)} ATR from the original median.`);
      }
      if (distanceSigma != null && Math.abs(distanceSigma) > 1.0) {
        state = "DRIFTING";
        reasons.push(`Price is ${Math.abs(distanceSigma).toFixed(1)} forecast-σ from the original median.`);
      }
      if (regimeChanged) {
        state = "DRIFTING";
        reasons.push("The stock regime has changed since the original issuance.");
      }
      if (materialEvents > 0) {
        state = "DRIFTING";
        reasons.push(`${materialEvents} tier-≤2 event(s) announced after the original issuance.`);
      }
      if (volumeAnomaly && state === "DRIFTING") {
        reasons.push("Last session's volume exceeded 2.5× its 20-session average.");
      }
    }
    if (state === "NORMAL") reasons.push("Price remains consistent with the original forecast distribution.");
    if (state !== "NORMAL") {
      reasons.push("The historical forecast remains unchanged for accountability; the current vintage is issued separately.");
    }

    return {
      version: DRIFT_VERSION,
      ticker: yahooTicker,
      asOf: new Date().toISOString(),
      currentPrice: price,
      original,
      current,
      drift: {
        state,
        reasons,
        distanceAtr: distanceAtr != null ? Math.round(distanceAtr * 100) / 100 : null,
        distanceSigma: distanceSigma != null ? Math.round(distanceSigma * 100) / 100 : null,
        regimeChanged,
        materialEventArrived: materialEvents > 0,
        volumeAnomaly,
      },
    };
  }
}

export const forecastDriftService = new ForecastDriftService();
