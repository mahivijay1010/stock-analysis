/**
 * IntradayForecastService — produce 1m/5m forecasts for the live universe,
 * log each one BEFORE its horizon elapses, and grade it against what actually
 * happened.
 *
 * The point is the grading, not the forecast. Anyone can print a direction for
 * 151 stocks; the question is whether those calls survive contact with the
 * tape, and the only way to answer it is to commit to each call in advance and
 * score it afterwards. That is what this does, in memory, within the session.
 *
 * Design rules:
 *  - A forecast is recorded at the instant it is made, with the base price it
 *    is measured against. It is never edited afterwards — only graded.
 *  - Grading uses the price at or after `resolveAt`, taken from the live feed.
 *    If no price is available the forecast expires UNGRADED rather than being
 *    quietly scored against a stale price.
 *  - Nothing here feeds a decision. The forecasts raise no authority; they
 *    exist to be measured (docs/system-trust-review.md §14).
 */

import { CompletedBar } from "./types";
import {
  FORECAST_HORIZONS_MIN,
  ForecastHorizonMin,
  GradedForecast,
  HorizonScore,
  IntradayForecast,
  INTRADAY_FORECAST_VERSION,
  EntryExitPlan,
  buildEntryExitPlan,
  forecastOne,
  gradeForecast,
  scoreHorizon,
} from "./intradayForecast";

/** Keep at most this many graded rows per horizon (a session's worth). */
const MAX_GRADED_PER_HORIZON = 20_000;

/**
 * A forecast is abandoned if it cannot be graded within this long past its
 * resolve time — the feed has moved on and scoring it later would be scoring
 * it against the wrong moment.
 */
const GRADE_DEADLINE_MS = 90_000;

export interface IntradayForecastRow extends IntradayForecast {
  /** Latest graded result for this ticker+horizon, if any. */
  lastOutcome: "CORRECT" | "WRONG" | null;
  /** Entry/exit levels for this forecast, with its horizon's measured accuracy attached. */
  plan: EntryExitPlan;
}

export interface IntradaySnapshot {
  modelVersion: string;
  asOf: number;
  /** Current open forecasts, newest per ticker+horizon. */
  forecasts: IntradayForecastRow[];
  /** Live scorecard per horizon — shown beside every forecast in the UI. */
  scores: HorizonScore[];
  /** Forecasts made but never graded (no price at resolve time). */
  expiredUngraded: number;
  headline: string;
}

export class IntradayForecastService {
  /** Open forecasts keyed `securityId|horizon`. */
  private readonly open = new Map<string, IntradayForecast>();
  /** Graded history per horizon. */
  private readonly graded = new Map<ForecastHorizonMin, GradedForecast[]>();
  private expiredUngraded = 0;
  private lastOutcomeByKey = new Map<string, "CORRECT" | "WRONG">();

  constructor(private readonly now: () => number = Date.now) {
    for (const h of FORECAST_HORIZONS_MIN) this.graded.set(h, []);
  }

  private key(securityId: string, horizonMin: number): string {
    return `${securityId}|${horizonMin}`;
  }

  /**
   * Produce forecasts for one security from its completed bars.
   *
   * Only replaces an existing open forecast once that one has been graded or
   * expired, so a forecast can never be silently withdrawn before its horizon
   * elapses — which would let losing calls disappear.
   */
  forecast(securityId: string, ticker: string, bars: CompletedBar[]): IntradayForecast[] {
    const now = this.now();
    const made: IntradayForecast[] = [];
    for (const horizonMin of FORECAST_HORIZONS_MIN) {
      const k = this.key(securityId, horizonMin);
      if (this.open.has(k)) continue; // a call is already outstanding; let it resolve
      const f = forecastOne({ securityId, ticker, bars, horizonMin, now });
      if (f) {
        this.open.set(k, f);
        made.push(f);
      }
    }
    return made;
  }

  /**
   * Grade every open forecast whose horizon has elapsed, using current prices.
   *
   * `priceOf` returns the live price for a securityId, or null when unknown.
   * A missing price expires the forecast ungraded — counted and surfaced, not
   * hidden, because silently dropping unresolvable calls would bias the score.
   */
  grade(priceOf: (securityId: string) => number | null): GradedForecast[] {
    const now = this.now();
    const out: GradedForecast[] = [];

    for (const [k, f] of [...this.open.entries()]) {
      if (now < f.resolveAt) continue;

      const price = priceOf(f.securityId);
      if (price == null) {
        if (now - f.resolveAt > GRADE_DEADLINE_MS) {
          this.open.delete(k);
          this.expiredUngraded++;
        }
        continue;
      }

      const g = gradeForecast(f, price, now);
      this.open.delete(k);
      if (!g) {
        this.expiredUngraded++;
        continue;
      }

      const list = this.graded.get(f.horizonMin);
      if (list) {
        list.push(g);
        if (list.length > MAX_GRADED_PER_HORIZON) list.shift();
      }
      this.lastOutcomeByKey.set(k, g.outcome);
      out.push(g);
    }
    return out;
  }

  scores(): HorizonScore[] {
    return FORECAST_HORIZONS_MIN.map((h) => scoreHorizon(h, this.graded.get(h) ?? []));
  }

  /** Most recent graded forecasts, newest first — the live results feed. */
  recentGraded(limit = 50): GradedForecast[] {
    const all: GradedForecast[] = [];
    for (const list of this.graded.values()) all.push(...list);
    return all.sort((a, b) => b.gradedAt - a.gradedAt).slice(0, Math.max(1, Math.min(500, limit)));
  }

  /**
   * Everything this service knows about ONE security: its open calls and its
   * graded history, newest first.
   *
   * Per-ticker history is what makes a forecast checkable by eye — a hit rate
   * across 151 stocks can hide a model that is systematically wrong on the
   * one name you happen to care about.
   */
  forSecurity(securityId: string): {
    open: IntradayForecastRow[];
    graded: GradedForecast[];
    correct: number;
    wrong: number;
  } {
    const scoreByHorizon = new Map(this.scores().map((s) => [s.horizonMin, s]));
    const open = [...this.open.values()]
      .filter((f) => f.securityId === securityId)
      .map((f) => ({
        ...f,
        lastOutcome: this.lastOutcomeByKey.get(this.key(f.securityId, f.horizonMin)) ?? null,
        plan: buildEntryExitPlan(f, scoreByHorizon.get(f.horizonMin)!),
      }));
    const graded: GradedForecast[] = [];
    for (const list of this.graded.values()) {
      for (const g of list) if (g.securityId === securityId) graded.push(g);
    }
    graded.sort((a, b) => b.gradedAt - a.gradedAt);
    return {
      open: open.sort((a, b) => a.horizonMin - b.horizonMin),
      graded,
      correct: graded.filter((g) => g.outcome === "CORRECT").length,
      wrong: graded.filter((g) => g.outcome === "WRONG").length,
    };
  }

  snapshot(): IntradaySnapshot {
    const scores = this.scores();
    const scoreByHorizon = new Map(scores.map((s) => [s.horizonMin, s]));
    const forecasts: IntradayForecastRow[] = [...this.open.values()]
      .map((f) => ({
        ...f,
        lastOutcome: this.lastOutcomeByKey.get(this.key(f.securityId, f.horizonMin)) ?? null,
        plan: buildEntryExitPlan(f, scoreByHorizon.get(f.horizonMin)!),
      }))
      .sort((a, b) => a.ticker.localeCompare(b.ticker) || a.horizonMin - b.horizonMin);

    return {
      modelVersion: INTRADAY_FORECAST_VERSION,
      asOf: this.now(),
      forecasts,
      scores,
      expiredUngraded: this.expiredUngraded,
      headline: this.headline(scores),
    };
  }

  /**
   * One sentence, chosen to be the least flattering true statement available —
   * the same rule the Evidence tab's headline follows.
   */
  private headline(scores: HorizonScore[]): string {
    const proven = scores.filter((s) => !s.unproven);
    const withData = scores.filter((s) => s.graded > 0);

    if (withData.length === 0) {
      return "No forecast has been graded yet. Nothing on this screen has been shown to predict anything.";
    }
    if (proven.length === 0) {
      const parts = withData.map((s) => `${s.horizonMin}m: ${s.note}`);
      return `No horizon has demonstrated an edge. ${parts.join("; ")}. These forecasts are measured, not tradeable.`;
    }
    const parts = scores.map((s) => `${s.horizonMin}m ${s.hitRatePct != null ? s.hitRatePct.toFixed(1) + "%" : "n/a"} of ${s.graded}`);
    return `${parts.join(", ")}. A single session above 50% is not evidence of skill — it is one session.`;
  }

  /** Test/ops hook: drop all state. */
  reset(): void {
    this.open.clear();
    for (const h of FORECAST_HORIZONS_MIN) this.graded.set(h, []);
    this.lastOutcomeByKey.clear();
    this.expiredUngraded = 0;
  }
}

export const intradayForecastService = new IntradayForecastService();
