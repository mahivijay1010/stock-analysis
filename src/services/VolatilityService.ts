/**
 * V8 R2 + V10 B2 — VolatilityService: thin wiring for the PURE HAR-RV/HAR-X
 * forecaster (quant/volforecast.ts). Bars come from the same DB-cached market
 * data layer every other module uses; ^INDIAVIX comes from the NIFTY-style
 * in-memory index cache (never DB-stored). Nothing is fabricated — an
 * unfittable series returns nulls with the reason in `note`.
 *
 * V10 B2:
 *  - Both plain HAR and HAR-X (z-scored previous-day India VIX) are fit; both
 *    walk-forward OOS R²s are reported and the forecast uses the winner
 *    (`method` + `vixDeltaR2` state it).
 *  - The RBI repo rate is attached as CONTEXT ONLY from STORED macro
 *    observations — never a regressor: policy moves are rare step events,
 *    unfitable on ~250 daily observations (stated in the note).
 */

import { AppDataSource } from "../config/database";
import { MacroObservation } from "../entities";
import { marketDataService } from "./market/MarketDataService";
import { forecastVolatility, VixPoint } from "./quant/volforecast";
import { HttpError, VolatilityForecastResponse } from "../types";

const MIN_BARS = 122; // ~6 months of RV obs after the 22-day HAR warm-up
const REPO_RATE_INDICATOR = "Policy Repo Rate";

export class VolatilityService {
  async getForecast(tickerOrName: string): Promise<VolatilityForecastResponse> {
    const resolved = await marketDataService.resolve(tickerOrName);
    if (!resolved) {
      throw new HttpError(
        404,
        `Could not resolve "${tickerOrName}" to an Indian (NSE/BSE) listing.`
      );
    }
    const bars = await marketDataService.getDailyBars(resolved.ticker, "2y");
    if (bars.length < MIN_BARS) {
      throw new HttpError(
        422,
        `${resolved.ticker} has only ${bars.length} daily bars — need at least ${MIN_BARS} ` +
          `to fit a HAR-RV volatility model honestly.`
      );
    }

    // V10 B2 — India VIX for the HAR-X candidate. A VIX outage degrades to
    // plain HAR with the reason stated; it never fabricates or blocks.
    let vix: VixPoint[] | undefined;
    let vixFetchNote = "";
    try {
      const vixBars = await marketDataService.getIndiaVixBars("2y");
      vix = vixBars.map((b) => ({ date: b.date, close: b.close }));
    } catch (err) {
      vixFetchNote = ` India VIX could not be fetched right now (${(err as Error).message}) — plain HAR only.`;
    }

    const f = forecastVolatility(bars, vix);

    // V10 B2 — repo-rate CONTEXT chip from stored RBI macro observations.
    let repoRatePct: number | null = null;
    try {
      const row = await AppDataSource.getRepository(MacroObservation).findOne({
        where: { indicator: REPO_RATE_INDICATOR },
        order: { retrievedAt: "DESC" },
      });
      const value = row ? Number(row.value) : NaN;
      repoRatePct = Number.isFinite(value) ? value : null;
    } catch {
      repoRatePct = null; // stated below — never fabricated
    }
    const repoNote =
      repoRatePct !== null
        ? ` RBI repo rate ${repoRatePct}% (stored) is shown as CONTEXT ONLY — never a regressor: ` +
          `policy moves are rare step events, unfitable on ~250 daily observations.`
        : ` No stored RBI repo rate found (refresh /api/intelligence/macro) — the repo chip is context ` +
          `only and never a regressor anyway.`;

    return {
      ticker: resolved.ticker,
      forecast1dVolPct: f.forecast1dVolPct,
      forecast5dVolPct: f.forecast5dVolPct,
      historicalAvgVolPct: f.historicalAvgVolPct,
      medianVol1yPct: f.medianVol1yPct,
      regime: f.regime,
      sizingHint: f.sizingHint,
      r2InSample: f.r2InSample,
      r2OutOfSample: f.r2OutOfSample,
      oosSamples: f.oosSamples,
      method: f.method,
      methodology: f.methodology,
      r2OutOfSampleHar: f.r2OutOfSampleHar,
      r2OutOfSampleHarX: f.r2OutOfSampleHarX,
      vixDeltaR2: f.vixDeltaR2,
      repoRatePct,
      note: `${f.note}${vixFetchNote}${repoNote}`,
    };
  }
}

/** Singleton export. */
export const volatilityService = new VolatilityService();
export default volatilityService;
