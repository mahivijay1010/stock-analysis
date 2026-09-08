/**
 * ForecastService (Phase C, spec §5) — ONE forecast engine producing IMMUTABLE
 * issuances, with observations graded separately.
 *
 * Every issuance stores: issuedAt, featureCutoffAt, anchor session + price,
 * price basis, exact calendar window, model/calibration/policy versions, and a
 * sha256 input manifest over every (date, close) bar used. Reality is recorded
 * in forecast_outcomes; a forecast row is never rewritten.
 *
 * Distribution: the SAME seeded bootstrap engine used everywhere else
 * (simulateDailyQuantiles) — per-trading-day cumulative-return quantiles from
 * the stock's own real daily returns. p10–p90 is the 80% interval, p05–p95 the
 * 90%; they are never relabeled, and a per-date interval is not a whole-month
 * path guarantee.
 */

import { createHash } from "crypto";
import { AppDataSource } from "../../config/database";
import { ForecastOutcome, ForecastPoint, ForecastRun, Instrument } from "../../entities";
import { marketDataService } from "../market/MarketDataService";
import { Bar } from "../market/types";
import { adjustedDailyReturns } from "../market/canonical";
import { simulateDailyQuantiles } from "../quant/montecarlo";
import { HttpError } from "../../types";
import { sessionCalendarService, ResolvedDay } from "./SessionCalendarService";
import { addCalendarDays, istDateString, monthBounds, monthKey } from "./dates";

export const FORECAST_VERSIONS = {
  /** Distribution engine: seeded bootstrap MC over the stock's own returns. */
  model: "bootstrap-mc-v1",
  /**
   * Raw sample quantiles, no post-hoc calibration layer applied — stated
   * honestly rather than pretending a calibration step that doesn't exist.
   */
  calibration: "raw-quantiles-v0",
  /** Product policy: spec §5 windows, states, and labeling rules. */
  policy: "spec5-v1",
} as const;

const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

export interface DailyForecastRow {
  date: string; // IST calendar date
  marketState: "expected_session" | "weekend" | "expected_closed";
  tradingDayOffset: number | null;
  prices: {
    p05: number;
    p10: number;
    p25: number;
    p50: number;
    p75: number;
    p90: number;
    p95: number;
    mean: number;
  } | null;
  medianReturnPct: number | null;
  pop: number | null;
  carriesForwardFrom: string | null;
  outcome: {
    state: ForecastOutcome["state"];
    observedClose: number | null;
    realizedReturnPct: number | null;
    insideBand80: boolean | null;
    insideBand90: boolean | null;
  } | null;
}

export interface IssuanceView {
  runId: string;
  ticker: string;
  viewKind: "next30" | "month";
  periodKey: string | null;
  revision: number;
  issuedAt: string;
  featureCutoffAt: string;
  anchorSessionDate: string;
  anchorPrice: number;
  priceBasis: string;
  windowStart: string;
  windowEnd: string;
  targetSessionCount: number;
  versions: typeof FORECAST_VERSIONS;
  inputHash: string;
  days: DailyForecastRow[];
  realityCheck: string;
}

const REALITY_CHECK =
  "Quantiles are frequencies across 10,000 bootstrap simulations of this stock's own past returns — " +
  "measured uncertainty, not a promise. p10–p90 is an 80% interval per date (p05–p95: 90%); " +
  "that is NOT an 80% guarantee for the whole path. Direction accuracy of this system measures " +
  "≈ a coin flip; the calibrated ranges are the product. Future sessions are provisional until confirmed.";

export class ForecastService {
  // ── issuance ───────────────────────────────────────────────────────────────

  /**
   * Rolling "next 30 calendar days" issuance: window = calendar dates AFTER
   * forecastDateIST through forecastDateIST+30 inclusive. One run per
   * (instrument, anchor session) — the seeded engine over identical inputs is
   * bit-identical, so re-requests on the same anchor reuse the stored run.
   */
  async issueNext30(ticker: string): Promise<ForecastRun> {
    const instrument = await this.resolveInstrument(ticker);
    const { bars, anchor } = await this.loadBars(instrument.yahooTicker);

    const existing = await AppDataSource.getRepository(ForecastRun).findOne({
      where: { instrumentId: instrument.id, viewKind: "next30", anchorSessionDate: anchor.date },
    });
    if (existing) return existing;

    const forecastDate = istDateString(new Date());
    const windowStart = addCalendarDays(forecastDate, 1);
    const windowEnd = addCalendarDays(forecastDate, 30);
    return this.issue(instrument, bars, anchor, {
      viewKind: "next30",
      periodKey: null,
      revision: 0,
      windowStart,
      windowEnd,
    });
  }

  /**
   * Calendar-month issuance for periodKey "YYYY-MM". revision 0 = the original
   * monthly snapshot; each later refresh appends the next revision ("latest
   * outlook") and NEVER moves the original. A mid-month original covers only
   * the remaining days — earlier days show actuals, not backfilled forecasts.
   */
  async issueMonth(ticker: string, periodKey: string, opts?: { refresh?: boolean }): Promise<ForecastRun> {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodKey)) {
      throw new HttpError(400, `periodKey must be YYYY-MM, got "${periodKey}"`);
    }
    const instrument = await this.resolveInstrument(ticker);
    const runRepo = AppDataSource.getRepository(ForecastRun);
    const prior = await runRepo.find({
      where: { instrumentId: instrument.id, viewKind: "month", periodKey },
      order: { revision: "DESC" },
    });

    if (prior.length > 0 && !opts?.refresh) return prior[0];

    const { bars, anchor } = await this.loadBars(instrument.yahooTicker);
    if (opts?.refresh && prior.length > 0 && prior[0].anchorSessionDate === anchor.date) {
      // Same anchor ⇒ identical seeded output; refuse to spam identical revisions.
      return prior[0];
    }

    const today = istDateString(new Date());
    const { start, end } = monthBounds(periodKey);
    if (end <= anchor.date) {
      throw new HttpError(400, `Month ${periodKey} is already complete relative to the data anchor (${anchor.date}).`);
    }
    // Forecast only genuinely-future days: after both today and the anchor.
    const windowStart = [start, addCalendarDays(today, 1), addCalendarDays(anchor.date, 1)]
      .sort()
      .pop() as string;

    return this.issue(instrument, bars, anchor, {
      viewKind: "month",
      periodKey,
      revision: prior.length > 0 ? prior[0].revision + 1 : 0,
      windowStart,
      windowEnd: end,
    });
  }

  private async issue(
    instrument: Instrument,
    bars: Bar[],
    anchor: { date: string; close: number },
    spec: {
      viewKind: "next30" | "month";
      periodKey: string | null;
      revision: number;
      windowStart: string;
      windowEnd: string;
    }
  ): Promise<ForecastRun> {
    await sessionCalendarService.reconcile().catch(() => undefined); // best effort
    const days = await sessionCalendarService.resolveRange(spec.windowStart, spec.windowEnd);

    // Trading-day offsets count from the ACTUAL completed-session anchor:
    // sessions strictly after the anchor date, in calendar order.
    let offset = 0;
    const offsets = new Map<string, number>();
    for (const d of days) {
      if ((d.state === "session" || d.state === "projected_session") && d.date > anchor.date) {
        offsets.set(d.date, ++offset);
      }
    }
    const steps = offset;
    if (steps < 1) {
      throw new HttpError(400, `No future sessions inside ${spec.windowStart}..${spec.windowEnd} — nothing to forecast.`);
    }

    const returns = this.dailyReturns(bars);
    const sim = simulateDailyQuantiles(returns, steps);

    const manifest = {
      ticker: instrument.yahooTicker,
      barCount: bars.length,
      firstBarDate: bars[0]?.date ?? null,
      lastBarDate: anchor.date,
      returnPoolSize: sim.poolSize,
      paths: sim.paths,
      seed: sim.seed,
      steps: sim.steps,
      versions: FORECAST_VERSIONS,
    };
    const inputHash = createHash("sha256")
      .update(JSON.stringify(manifest))
      .update(bars.map((b) => `${b.date}:${b.close}`).join("|"))
      .digest("hex");

    const now = new Date();
    // Feature cutoff = the anchor session's close (15:30 IST) — the newest datum used.
    const featureCutoffAt = new Date(`${anchor.date}T15:30:00+05:30`);

    return AppDataSource.transaction(async (em) => {
      const run = await em.getRepository(ForecastRun).save(
        em.getRepository(ForecastRun).create({
          instrumentId: instrument.id,
          ticker: instrument.yahooTicker,
          viewKind: spec.viewKind,
          periodKey: spec.periodKey,
          revision: spec.revision,
          issuedAt: now,
          featureCutoffAt,
          anchorSessionDate: anchor.date,
          anchorPrice: anchor.close.toFixed(4),
          priceBasis: "close",
          modelVersion: FORECAST_VERSIONS.model,
          calibrationVersion: FORECAST_VERSIONS.calibration,
          policyVersion: FORECAST_VERSIONS.policy,
          inputManifest: manifest,
          inputHash,
          windowStart: spec.windowStart,
          windowEnd: spec.windowEnd,
          targetSessionCount: steps,
          notes:
            spec.viewKind === "month" && spec.revision > 0
              ? "Latest-outlook refresh: a NEW issuance; the original snapshot is unchanged."
              : null,
        })
      );

      let lastSession: string | null = null;
      const points = days.map((d) => {
        const off = offsets.get(d.date) ?? null;
        const step = off ? sim.perStep[off - 1] : null;
        const price = (frac: number) => (anchor.close * (1 + frac)).toFixed(4);
        const point = em.getRepository(ForecastPoint).create({
          runId: run.id,
          targetDate: d.date,
          marketState: this.toMarketState(d),
          tradingDayOffset: off,
          priceP05: step ? price(step.q.p05) : null,
          priceP10: step ? price(step.q.p10) : null,
          priceP25: step ? price(step.q.p25) : null,
          priceP50: step ? price(step.q.p50) : null,
          priceP75: step ? price(step.q.p75) : null,
          priceP90: step ? price(step.q.p90) : null,
          priceP95: step ? price(step.q.p95) : null,
          priceMean: step ? price(step.mean) : null,
          medianReturnPct: step ? (step.q.p50 * 100).toFixed(4) : null,
          pop: step ? step.pop.toFixed(4) : null,
          carriesForwardFrom: step ? null : lastSession,
        });
        if (off) lastSession = d.date;
        return point;
      });
      await em.getRepository(ForecastPoint).save(points, { chunk: 50 });
      return run;
    });
  }

  private toMarketState(d: ResolvedDay): ForecastPoint["marketState"] {
    if (d.state === "weekend") return "weekend";
    if (d.state === "closed") return "expected_closed";
    return "expected_session";
  }

  // ── views (read-only: GETs NEVER create canonical records — B1 contract) ──

  /**
   * Latest stored next-30-days issuance, or an honest "none yet". Issuance
   * happens on the evening cron (daily cadence, spec §5) or via the
   * authenticated POST /api/forecast/:ticker/issue — never on a GET.
   */
  async getDailyView(
    ticker: string
  ): Promise<{ available: true; view: IssuanceView } | { available: false; reason: string }> {
    const instrument = await this.resolveInstrument(ticker);
    const run = await this.latestNext30Run(instrument.id);
    if (!run) {
      return {
        available: false,
        reason:
          `No forecast issuance exists for ${instrument.yahooTicker} yet. Issuances are created ` +
          `nightly for followed/held instruments, or on demand via POST /api/forecast/:ticker/issue.`,
      };
    }
    return { available: true, view: await this.toView(run) };
  }

  private async latestNext30Run(instrumentId: string): Promise<ForecastRun | null> {
    return AppDataSource.getRepository(ForecastRun).findOne({
      where: { instrumentId, viewKind: "next30" },
      order: { anchorSessionDate: "DESC", issuedAt: "DESC" },
    });
  }

  /**
   * Nightly issuance sweep (spec §5 "daily forecasts"): a fresh next-30 run for
   * every watchlisted/held instrument whose anchor moved. Idempotent — the
   * partial unique index dedupes per (instrument, anchor session).
   */
  async issueDailyForAll(): Promise<{ issued: number; reused: number; failed: Array<{ ticker: string; error: string }> }> {
    const targets = await this.followedOrHeldTickers();
    let issued = 0;
    let reused = 0;
    const failed: Array<{ ticker: string; error: string }> = [];
    for (const ticker of targets) {
      try {
        const before = Date.now();
        const run = await this.issueNext30(ticker);
        if (run.createdAt.getTime() >= before) issued++;
        else reused++;
      } catch (e) {
        failed.push({ ticker, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { issued, reused, failed };
  }

  /**
   * Calendar-month view: the ORIGINAL snapshot, the separately-labeled latest
   * outlook (when one exists), and observed actuals for every day of the month.
   */
  async getMonthView(
    ticker: string,
    periodKey: string
  ): Promise<{
    period: string;
    ticker: string;
    original: IssuanceView | null;
    latestOutlook: IssuanceView | null;
    actuals: Array<{ date: string; close: number }>;
    realityCheck: string;
  }> {
    const instrument = await this.resolveInstrument(ticker);
    const runs = await AppDataSource.getRepository(ForecastRun).find({
      where: { instrumentId: instrument.id, viewKind: "month", periodKey },
      order: { revision: "ASC" },
    });
    const original = runs.find((r) => r.revision === 0) ?? null;
    const latest = runs.length > 0 ? runs[runs.length - 1] : null;

    const { start, end } = monthBounds(periodKey);
    const actualRows: Array<{ d: string; c: string }> = await AppDataSource.query(
      `SELECT h.trading_date::text AS d, h.close_price::text AS c
         FROM stock_history h JOIN stocks s ON s.id = h.stock_id
        WHERE s.ticker = $1 AND h.trading_date BETWEEN $2::date AND $3::date
        ORDER BY d`,
      [instrument.yahooTicker, start, end]
    );

    return {
      period: periodKey,
      ticker: instrument.yahooTicker,
      original: original ? await this.toView(original) : null,
      latestOutlook: latest && original && latest.id !== original.id ? await this.toView(latest) : null,
      actuals: actualRows.map((r) => ({ date: r.d, close: Number(r.c) })),
      realityCheck: REALITY_CHECK,
    };
  }

  async toView(run: ForecastRun): Promise<IssuanceView> {
    const points = await AppDataSource.getRepository(ForecastPoint).find({
      where: { runId: run.id },
      order: { targetDate: "ASC" },
    });
    const outcomes = await AppDataSource.getRepository(ForecastOutcome)
      .createQueryBuilder("o")
      .innerJoin("o.point", "p")
      .where("p.run_id = :rid", { rid: run.id })
      .orderBy("o.revision", "DESC")
      .getMany();
    const latestOutcome = new Map<string, ForecastOutcome>();
    for (const o of outcomes) if (!latestOutcome.has(o.pointId)) latestOutcome.set(o.pointId, o);

    const num = (v: string | null | undefined): number | null => (v == null ? null : Number(v));
    return {
      runId: run.id,
      ticker: run.ticker,
      viewKind: run.viewKind,
      periodKey: run.periodKey ?? null,
      revision: run.revision,
      issuedAt: run.issuedAt.toISOString(),
      featureCutoffAt: run.featureCutoffAt.toISOString(),
      anchorSessionDate: String(run.anchorSessionDate),
      anchorPrice: Number(run.anchorPrice),
      priceBasis: run.priceBasis,
      windowStart: String(run.windowStart),
      windowEnd: String(run.windowEnd),
      targetSessionCount: run.targetSessionCount,
      versions: FORECAST_VERSIONS,
      inputHash: run.inputHash,
      days: points.map((p) => {
        const o = latestOutcome.get(p.id) ?? null;
        return {
          date: String(p.targetDate),
          marketState: p.marketState,
          tradingDayOffset: p.tradingDayOffset ?? null,
          prices:
            p.priceP50 == null
              ? null
              : {
                  p05: num(p.priceP05)!,
                  p10: num(p.priceP10)!,
                  p25: num(p.priceP25)!,
                  p50: num(p.priceP50)!,
                  p75: num(p.priceP75)!,
                  p90: num(p.priceP90)!,
                  p95: num(p.priceP95)!,
                  mean: num(p.priceMean)!,
                },
          medianReturnPct: num(p.medianReturnPct),
          pop: num(p.pop),
          carriesForwardFrom: p.carriesForwardFrom ? String(p.carriesForwardFrom) : null,
          outcome: o
            ? {
                state: o.state,
                observedClose: num(o.observedClose),
                realizedReturnPct: num(o.realizedReturnPct),
                insideBand80: o.insideBand80 ?? null,
                insideBand90: o.insideBand90 ?? null,
              }
            : null,
        };
      }),
      realityCheck: REALITY_CHECK,
    };
  }

  // ── verification (observations, never rewrites) ───────────────────────────

  /**
   * Grade matured expected-session points against real closes. Appends
   * ForecastOutcome rows (latest revision wins); NEVER touches runs/points.
   * Explicit states: verified / no_session (date turned out closed) /
   * missing_data (session happened, no observation after grace) / pending.
   */
  async verifyOutcomes(opts?: { graceDays?: number }): Promise<{
    examined: number;
    verified: number;
    noSession: number;
    missingData: number;
    pending: number;
  }> {
    const graceDays = opts?.graceDays ?? 2;
    const today = istDateString(new Date());
    await sessionCalendarService.reconcile().catch(() => undefined);

    // Matured session-points whose latest outcome is absent or still pending.
    const rows: Array<{
      point_id: string;
      run_id: string;
      target_date: string;
      ticker: string;
      anchor_price: string;
      p05: string | null;
      p10: string | null;
      p90: string | null;
      p95: string | null;
      last_state: string | null;
      last_rev: number | null;
    }> = await AppDataSource.query(
      `SELECT p.id AS point_id, r.id AS run_id, p.target_date::text AS target_date,
              r.ticker, r.anchor_price::text AS anchor_price,
              p.price_p05::text AS p05, p.price_p10::text AS p10,
              p.price_p90::text AS p90, p.price_p95::text AS p95,
              o.state AS last_state, o.revision AS last_rev
         FROM forecast_points p
         JOIN forecast_runs r ON r.id = p.run_id
         LEFT JOIN LATERAL (
            SELECT state, revision FROM forecast_outcomes
             WHERE point_id = p.id ORDER BY revision DESC LIMIT 1
         ) o ON true
        WHERE p.market_state = 'expected_session'
          AND p.target_date <= $1::date
          AND (o.state IS NULL OR o.state = 'pending')
        ORDER BY p.target_date`,
      [today]
    );

    const counters = { examined: rows.length, verified: 0, noSession: 0, missingData: 0, pending: 0 };
    if (rows.length === 0) return counters;

    const calendar = new Map(
      (
        await sessionCalendarService.resolveRange(
          rows.reduce((a, r) => (r.target_date < a ? r.target_date : a), rows[0].target_date),
          today
        )
      ).map((d) => [d.date, d])
    );

    for (const row of rows) {
      const closeRow: Array<{ c: string }> = await AppDataSource.query(
        `SELECT h.close_price::text AS c FROM stock_history h JOIN stocks s ON s.id = h.stock_id
          WHERE s.ticker = $1 AND h.trading_date = $2::date LIMIT 1`,
        [row.ticker, row.target_date]
      );
      const nextRev = (row.last_rev ?? -1) + 1;
      const save = (o: Partial<ForecastOutcome>) =>
        AppDataSource.getRepository(ForecastOutcome).save(
          AppDataSource.getRepository(ForecastOutcome).create({
            pointId: row.point_id,
            revision: nextRev,
            ...o,
          } as ForecastOutcome)
        );

      if (closeRow.length > 0) {
        const close = Number(closeRow[0].c);
        const anchor = Number(row.anchor_price);
        const inRange = (lo: string | null, hi: string | null) =>
          lo != null && hi != null ? close >= Number(lo) && close <= Number(hi) : null;
        await save({
          state: "verified",
          observedClose: close.toFixed(4),
          observedSessionDate: row.target_date,
          realizedReturnPct: (((close - anchor) / anchor) * 100).toFixed(4),
          insideBand80: inRange(row.p10, row.p90),
          insideBand90: inRange(row.p05, row.p95),
          verifiedAt: new Date(),
        });
        counters.verified++;
        continue;
      }

      const day = calendar.get(row.target_date);
      if (day && (day.state === "closed" || day.state === "weekend")) {
        await save({
          state: "no_session",
          note: `Calendar reconciled ${row.target_date} as closed (${day.basis}).`,
        });
        counters.noSession++;
      } else if (row.target_date <= addCalendarDays(today, -graceDays)) {
        await save({
          state: "missing_data",
          note: `No observation for ${row.ticker} on ${row.target_date} after ${graceDays}-day grace.`,
        });
        counters.missingData++;
      } else if (row.last_state !== "pending") {
        await save({ state: "pending", note: "Awaiting close data." });
        counters.pending++;
      } else {
        counters.pending++;
      }
    }
    return counters;
  }

  // ── monthly renewal (idempotent, downtime-recovering) ─────────────────────

  /**
   * Ensure the CURRENT IST month has an original snapshot for every instrument
   * on any watchlist or held in any account. Idempotent: the partial unique
   * index makes double-issuance impossible; a missed month-start is recovered
   * on the next invocation (mid-month originals forecast the remaining month).
   * Resets NOTHING: ownership, cost basis, lifetime P&L and accuracy history
   * are untouched — only the reporting period rolls.
   */
  async renewMonthly(): Promise<{ period: string; issued: string[]; skipped: string[]; failed: Array<{ ticker: string; error: string }> }> {
    const period = monthKey(istDateString(new Date()));
    const targets = await this.followedOrHeldTickers();
    const issued: string[] = [];
    const skipped: string[] = [];
    const failed: Array<{ ticker: string; error: string }> = [];
    for (const ticker of targets) {
      try {
        const before = Date.now();
        const run = await this.issueMonth(ticker, period);
        (run.createdAt.getTime() >= before ? issued : skipped).push(ticker);
      } catch (e) {
        failed.push({ ticker, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { period, issued, skipped, failed };
  }

  /** Instruments on any watchlist or ever transacted — the forecast target set. */
  private async followedOrHeldTickers(): Promise<string[]> {
    const rows: Array<{ ticker: string }> = await AppDataSource.query(
      `SELECT DISTINCT i.yahoo_ticker AS ticker FROM instruments i
        WHERE i.id IN (SELECT instrument_id FROM watchlist_items)
           OR i.id IN (SELECT instrument_id FROM ledger_transactions
                        WHERE type IN ('BUY','SELL'))
        ORDER BY ticker`
    );
    return rows.map((r) => r.ticker);
  }

  // ── holdings projection (same distribution, transformed — spec §5) ────────

  /**
   * Transform each holding's OWN forecast distribution into position value and
   * P&L: value quantile = qty × price quantile (exact monotone transform); P&L
   * = value − remaining cost basis. NO second model. Portfolio rows are per
   * position; quantiles are NOT summed across positions (medians don't add —
   * stated on the response instead of faked).
   */
  async holdingsProjection(positions: Array<{ ticker: string; qty: number; costBasis: number }>): Promise<{
    positions: Array<{
      ticker: string;
      qty: number;
      costBasis: number;
      anchorSessionDate: string;
      horizonDate: string; // last expected session in the window
      value: { p10: number; p50: number; p90: number };
      pnl: { p10: number; p50: number; p90: number };
      pop: number | null; // P(position gains vs anchor) — equals P(return>0)
      runId: string;
    }>;
    unavailable: string[]; // held tickers with no stored issuance yet
    note: string;
  }> {
    const out = [];
    const unavailable: string[] = [];
    for (const pos of positions) {
      if (pos.qty <= 0) continue;
      const daily = await this.getDailyView(pos.ticker);
      if (!daily.available) {
        unavailable.push(pos.ticker);
        continue;
      }
      const view = daily.view;
      const sessions = view.days.filter((d) => d.prices != null);
      const last = sessions[sessions.length - 1];
      if (!last || !last.prices) {
        unavailable.push(pos.ticker);
        continue;
      }
      const v = (price: number) => round4(pos.qty * price);
      out.push({
        ticker: view.ticker,
        qty: pos.qty,
        costBasis: pos.costBasis,
        anchorSessionDate: view.anchorSessionDate,
        horizonDate: last.date,
        value: { p10: v(last.prices.p10), p50: v(last.prices.p50), p90: v(last.prices.p90) },
        pnl: {
          p10: round4(v(last.prices.p10) - pos.costBasis),
          p50: round4(v(last.prices.p50) - pos.costBasis),
          p90: round4(v(last.prices.p90) - pos.costBasis),
        },
        pop: last.pop,
        runId: view.runId,
      });
    }
    return {
      positions: out,
      unavailable,
      note:
        "Per-position transforms of each stock's own forecast distribution (value = qty × price quantile; " +
        "P&L = value − cost basis). Quantiles are NOT summed across positions — the sum of per-stock " +
        "medians is not the median of the portfolio, so no fake portfolio-level band is shown.",
    };
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private async resolveInstrument(ticker: string): Promise<Instrument> {
    const t = ticker.trim().toUpperCase();
    const candidates = [t, t.endsWith(".NS") ? t : `${t}.NS`];
    const repo = AppDataSource.getRepository(Instrument);
    const found = await repo
      .createQueryBuilder("i")
      .where("i.yahoo_ticker IN (:...c)", { c: candidates })
      .getOne();
    if (!found) {
      throw new HttpError(404, `${ticker} is not in the supported instrument universe.`);
    }
    return found;
  }

  private async loadBars(yahooTicker: string): Promise<{ bars: Bar[]; anchor: { date: string; close: number } }> {
    const bars = await marketDataService.getDailyBars(yahooTicker, "1y");
    if (bars.length < 61) {
      throw new HttpError(422, `Only ${bars.length} daily bars available for ${yahooTicker} — at least 61 needed for a forecast.`);
    }
    const lastBar = bars[bars.length - 1];
    return { bars, anchor: { date: lastBar.date, close: lastBar.close } };
  }

  private dailyReturns(bars: Bar[]): number[] {
    // Phase 1: corporate-action-safe returns (adjustedClose ?? close).
    return adjustedDailyReturns(bars);
  }
}

export const forecastService = new ForecastService();
export default forecastService;
