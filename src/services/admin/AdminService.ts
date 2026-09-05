/**
 * AdminService (Module V2-D) — paper-trading desk + daily guidance for the
 * single "admin" account (seeded idempotently on boot: start = cash = ₹1,000).
 *
 *  - recordTrade(): BUY opens a lot (cash − cost − fees, cash-sufficiency
 *    enforced); SELL closes/reduces the oldest OPEN lots FIFO (owned-qty
 *    enforced) and books realizedPnl NET of fees.
 *  - getAccount(): open positions with live P&L + advice, realized P&L,
 *    DERIVED equity curve (never stored), goal tracker.
 *  - getDailyPlan(): best affordable candidate from the SAME cached universe
 *    scan the top-picks endpoint uses (no extra scanning), honest
 *    noPickReason when nothing qualifies, exit advice, goal tracker, and a
 *    REQUIRED realityCheck computed from LIVE ModelPerformance numbers.
 *
 * Advice engine (shared by /account and /daily-plan):
 *   live ≤ stop → SELL_NOW_STOP_HIT; live ≥ target → BOOK_PROFIT_TARGET_HIT;
 *   quant score < 45 (re-analyzed from DB bars) → EXIT_MOMENTUM_LOST; else HOLD.
 *
 * NEVER fabricates data: every price is a real quote/bar, every accuracy
 * number comes from measured ModelPerformance rows.
 */

import { IsNull, Not } from "typeorm";
import { AppDataSource } from "../../config/database";
import { PaperAccount } from "../../entities/PaperAccount";
import { PaperTrade } from "../../entities/PaperTrade";
import { ModelPerformance } from "../../entities/ModelPerformance";
import { PredictionLog } from "../../entities/PredictionLog";
import { marketDataService } from "../market/MarketDataService";
import { macroService } from "../market/MacroService";
import { computeTradeBreakdown } from "./executionStats";
import { analyzeBars } from "../quant/engine";
import { stockService } from "../StockService";
import { buildTradePlan } from "../framework/plan";
import { IntelligenceRepository } from "../intelligence/IntelligenceRepository";
import { intelligenceQualityScore } from "../quant/intelligenceQuality";
import {
  estimateBuyFees,
  estimateSellFees,
  estimateRoundTripFees,
} from "../framework/fees";
import { portfolioService } from "../portfolio/PortfolioService";
import {
  AdminAccountResponse,
  AdminSettingsRequest,
  Bar,
  DailyPlanPick,
  DailyPlanResponse,
  ForecastLock,
  ForecastLockRow,
  ForecastLocksResponse,
  ForecastLockVerdict,
  GoalMilestone,
  GoalTracker,
  HttpError,
  LockedForecastHorizon,
  LivePredictionStats,
  LossGuard,
  OpenPositionView,
  PaperTradeView,
  PositionAdvice,
  PredictionAuditResponse,
  EntryContextSnapshot,
  RecordTradeRequest,
  RecordTradeResponse,
  TradeReviewRow,
  TradeStats,
  VerifiedPredictionRow,
} from "../../types";

const ADMIN_ACCOUNT_NAME = "admin";
const ADMIN_START_CAPITAL = 1000;
const MODEL_VERSION = "quant-v1";
const MOMENTUM_EXIT_SCORE = 45;
const MIN_DIRECTION_PROB_7D = 0.55;
const AFFORDABILITY_FACTOR = 0.98; // price must be ≤ cash × 0.98

// Dynamic goal defaults (the original ₹1,000 → ₹1,00,000-in-30-days reference).
const DEFAULT_TARGET_AMOUNT = 100000;
const DEFAULT_TARGET_DAYS = 30;
const SETTINGS_CAPITAL_MIN = 100;
const SETTINGS_CAPITAL_MAX = 100_000_000; // ₹10 crore
const SETTINGS_TARGET_MAX = 1_000_000_000;
const SETTINGS_DAYS_MIN = 1;
const SETTINGS_DAYS_MAX = 365;

/**
 * Milestones along the geometric equity path from start → target over `days`:
 * checkpoints at 25/50/75/100% of the timeline (deduped), each at
 * start × (target/start)^(day/days). Fully dynamic — no hardcoded amounts.
 */
function milestonesFor(start: number, target: number, days: number): GoalMilestone[] {
  if (!(start > 0) || !(target > 0) || !(days >= 1) || target <= start) {
    return [{ day: Math.max(1, Math.round(days)), target: Math.round(target * 100) / 100 }];
  }
  const fractions = [0.25, 0.5, 0.75, 1];
  const milestones: GoalMilestone[] = [];
  const seen = new Set<number>();
  for (const f of fractions) {
    const day = Math.max(1, Math.round(days * f));
    if (seen.has(day)) continue;
    seen.add(day);
    const t = f === 1 ? target : start * Math.pow(target / start, day / days);
    milestones.push({ day, target: Math.round(t * 100) / 100 });
  }
  return milestones;
}

function round2(x: number): number {
  const r = Math.round(x * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

const inr = (x: number): string =>
  `₹${x.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** YYYY-MM-DD in Asia/Kolkata. */
function istDateString(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** dateStr (YYYY-MM-DD) + n calendar days → YYYY-MM-DD. */
function addCalendarDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Whole calendar days from one YYYY-MM-DD to another (b − a). */
function calendarDaysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

function tradeToView(t: PaperTrade): PaperTradeView {
  return {
    id: t.id,
    ticker: t.ticker,
    name: t.name ?? null,
    side: t.side,
    qty: t.qty,
    price: round2(t.price),
    fees: round2(t.fees),
    executedAt: new Date(t.executedAt).toISOString(),
    status: t.status,
    stopLoss: t.stopLoss ?? null,
    target: t.target ?? null,
    exitPrice: t.exitPrice ?? null,
    exitAt: t.exitAt ? new Date(t.exitAt).toISOString() : null,
    realizedPnl: t.realizedPnl ?? null,
    note: t.note ?? null,
  };
}

export class AdminService {
  private seedPromise: Promise<PaperAccount> | null = null;
  private readonly intelligenceRepository = new IntelligenceRepository();

  // ── Seeding ───────────────────────────────────────────────────────────────

  /** Idempotent: creates the 'admin' account (₹1,000) if it does not exist. */
  async ensureSeeded(): Promise<PaperAccount> {
    if (!this.seedPromise) {
      this.seedPromise = this.seedAccount().catch((err) => {
        this.seedPromise = null; // allow retry on next call
        throw err;
      });
    }
    return this.seedPromise;
  }

  private async seedAccount(): Promise<PaperAccount> {
    const repo = AppDataSource.getRepository(PaperAccount);
    let account = await repo.findOne({ where: { name: ADMIN_ACCOUNT_NAME } });
    if (account) return account;
    try {
      account = await repo.save(
        repo.create({
          name: ADMIN_ACCOUNT_NAME,
          startCapital: ADMIN_START_CAPITAL,
          cash: ADMIN_START_CAPITAL,
        })
      );
      console.log(
        `✓ Seeded paper account '${ADMIN_ACCOUNT_NAME}' with ${inr(ADMIN_START_CAPITAL)}`
      );
      return account;
    } catch {
      // Concurrent boot inserted it first — re-read (unique name).
      const existing = await repo.findOne({ where: { name: ADMIN_ACCOUNT_NAME } });
      if (existing) return existing;
      throw new Error("Failed to seed the admin paper account");
    }
  }

  private async getAccountRow(): Promise<PaperAccount> {
    const account = await this.ensureSeeded();
    // Re-read for fresh cash (ensureSeeded caches the boot-time row).
    const fresh = await AppDataSource.getRepository(PaperAccount).findOne({
      where: { id: account.id },
    });
    return fresh ?? account;
  }

  // ── Trades ────────────────────────────────────────────────────────────────

  async recordTrade(req: RecordTradeRequest): Promise<RecordTradeResponse> {
    const side = req.side;
    if (side !== "BUY" && side !== "SELL") {
      throw new HttpError(400, '"side" must be "BUY" or "SELL".');
    }
    const qty = Math.floor(Number(req.qty));
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new HttpError(400, '"qty" must be a positive integer.');
    }
    if (!req.ticker || typeof req.ticker !== "string" || !req.ticker.trim()) {
      throw new HttpError(400, '"ticker" is required, e.g. { "ticker": "SBIN", "side": "BUY", "qty": 5 }.');
    }

    const resolved = await marketDataService.resolve(req.ticker.trim());
    if (!resolved) {
      throw new HttpError(404, `Could not resolve "${req.ticker}" to an Indian (NSE/BSE) listing.`);
    }
    const ticker = resolved.ticker;

    // Execution price: explicit price or the live quote (real data only).
    let price: number;
    if (req.price !== undefined) {
      const p = Number(req.price);
      if (!Number.isFinite(p) || p <= 0) {
        throw new HttpError(400, '"price" must be a positive number when provided.');
      }
      price = p;
    } else {
      try {
        price = (await marketDataService.getQuote(ticker)).price;
      } catch {
        const bars = await marketDataService.getDailyBars(ticker, "3mo");
        if (bars.length === 0) {
          throw new HttpError(502, `No live quote or recent bars available for ${ticker}.`);
        }
        price = bars[bars.length - 1].close;
      }
    }

    const account = await this.getAccountRow();
    return side === "BUY"
      ? this.executeBuy(account, ticker, resolved.name, qty, price)
      : this.executeSell(account, ticker, qty, price);
  }

  private async executeBuy(
    account: PaperAccount,
    ticker: string,
    name: string,
    qty: number,
    price: number
  ): Promise<RecordTradeResponse> {
    const turnover = qty * price;
    const fees = estimateBuyFees(turnover);
    const totalCost = round2(turnover + fees);
    if (totalCost > account.cash) {
      throw new HttpError(
        400,
        `Insufficient cash: ${qty} × ${inr(price)} + ${inr(fees)} fees = ${inr(totalCost)}, ` +
          `but the account has only ${inr(account.cash)}.`
      );
    }

    // Best-effort stop/target from a fresh quant analysis of DB bars — the
    // advice engine uses these. Null (never invented) if analysis fails.
    let stopLoss: number | null = null;
    let target: number | null = null;
    let quantScore: number | null = null;
    let forecastLock: ForecastLock | null = null;
    try {
      const bars = await marketDataService.getDailyBars(ticker, "1y");
      if (bars.length >= 60) {
        const analysis = analyzeBars(bars);
        quantScore = analysis.score; // V10 B4 — already computed here
        const plan = buildTradePlan({
          entry: price,
          atr14: analysis.technicals.atr14,
          annualVolatilityPct: analysis.technicals.annualVolatilityPct,
          recommendation: analysis.recommendation === "AVOID" ? "HOLD" : analysis.recommendation,
        });
        if (plan) {
          stopLoss = plan.stopLoss;
          target = plan.target;
        }
        // Forecast Lock — freeze the purchase-day 7d/30d prediction from the
        // SAME analysis so reality can grade it later. Never recomputed.
        const baseClose = bars[bars.length - 1].close;
        const nowIst = istDateString(new Date());
        const toLocked = (h: 7 | 30) => {
          const p = analysis.predictions.find((x) => x.horizonDays === h);
          return p
            ? {
                expectedPrice: p.expectedPrice,
                lowPrice: p.lowPrice,
                highPrice: p.highPrice,
                expectedReturnPct: p.expectedReturnPct,
                targetDate: addCalendarDays(nowIst, h),
              }
            : null;
        };
        forecastLock = {
          lockedAt: new Date().toISOString(),
          baseClose: round2(baseClose),
          h7: toLocked(7),
          h30: toLocked(30),
        };
      }
    } catch {
      // stop/target/forecast stay null — recorded honestly as unavailable
    }

    // V10 B4 — entry-context snapshot from values ALREADY computed/cached in
    // the buy path (never an extra fetch): quantScore from the analysis above,
    // entryTimingScore from the fresh cached scan (if any), regime from the
    // macro cache (peek only), intelligenceQuality from STORED metrics (a DB
    // read, no NSE/Yahoo call). Anything unavailable stays honestly null.
    const entryContext = {
      ...(await this.buildEntryContext(ticker, quantScore)),
      forecastLock,
    };

    const savedTrade = await AppDataSource.transaction(async (em) => {
      const trade = em.getRepository(PaperTrade).create({
        accountId: account.id,
        ticker,
        name,
        side: "BUY" as const,
        qty,
        price,
        fees,
        executedAt: new Date(),
        status: "OPEN" as const,
        stopLoss,
        target,
        note: null,
        entryContext,
      });
      const saved = await em.getRepository(PaperTrade).save(trade);
      account.cash = round2(account.cash - totalCost);
      await em.getRepository(PaperAccount).save(account);
      return saved;
    });

    return {
      side: "BUY",
      ticker,
      name,
      qty,
      price: round2(price),
      fees,
      realizedPnl: null,
      cash: account.cash,
      trade: tradeToView(savedTrade),
      closedLots: [],
      message:
        `Bought ${qty} × ${ticker} @ ${inr(price)} (${inr(fees)} fees). ` +
        `Cash left ${inr(account.cash)}.` +
        (stopLoss !== null && target !== null
          ? ` Plan: stop ${inr(stopLoss)}, target ${inr(target)}.`
          : " No stop/target could be computed from DB bars."),
    };
  }

  /**
   * V10 B4 — snapshot what the system believes about this ticker RIGHT NOW,
   * using ONLY already-computed/cached/stored values (SPEC_V10: "never fetch
   * extra"). masterScore is null by design: the 8-phase framework runs only
   * in full Analyze calls, which the buy path deliberately does not trigger.
   */
  private async buildEntryContext(
    ticker: string,
    quantScore: number | null
  ): Promise<EntryContextSnapshot> {
    const scanEntry = stockService.peekScanEntry(ticker); // fresh cache only
    const regime = macroService.peekRegime()?.regime ?? null; // cache only

    let intelligenceQuality: number | null = null;
    try {
      const stored = await this.intelligenceRepository.latestStoredMetrics([ticker]);
      const s = stored.get(ticker.replace(/\.(NS|BO)$/i, "").toUpperCase());
      if (s) {
        intelligenceQuality =
          intelligenceQualityScore({
            roic: s.roic,
            fcf: s.fcf,
            revenue: s.revenue,
            currentRatio: s.currentRatio,
            currentRatioNotMeaningful: s.currentRatioNotMeaningful,
            peg: s.peg,
          })?.score ?? null;
      }
    } catch {
      intelligenceQuality = null; // stored-metrics read failed — honest null
    }

    return {
      quantScore,
      masterScore: null,
      entryTimingScore: scanEntry?.entryScore ?? null,
      intelligenceQuality,
      regime,
    };
  }

  // ── Forecast Lock — purchase-day predictions vs reality (frozen, graded) ──

  /**
   * Every BUY freezes the model's 7d/30d forecast at that moment. This view
   * NEVER recomputes a locked forecast — it only tracks live price against it
   * and, once the horizon matures, grades it against the REAL close. Trades
   * made before this feature carry no lock and are honestly absent.
   */
  async getForecastLocks(): Promise<ForecastLocksResponse> {
    const account = await this.getAccountRow();
    const repo = AppDataSource.getRepository(PaperTrade);
    const trades = await repo.find({
      where: { accountId: account.id, side: "BUY" },
      order: { executedAt: "DESC" },
      take: 100,
    });

    const today = istDateString(new Date());
    const rows: ForecastLockRow[] = [];
    const priceCache = new Map<string, number | null>();
    const barsCache = new Map<string, Bar[]>();

    for (const t of trades) {
      if (rows.length >= 50) break;
      const lock = t.entryContext?.forecastLock ?? null;
      if (!lock || (!lock.h7 && !lock.h30)) continue;

      if (!priceCache.has(t.ticker)) {
        priceCache.set(t.ticker, await this.livePriceFor(t.ticker));
      }
      const livePrice = priceCache.get(t.ticker) ?? null;
      const buyDate = istDateString(t.executedAt);
      const daysElapsed = Math.max(0, calendarDaysBetween(buyDate, today));

      // Grade a horizon once its target date has passed, using the REAL close
      // on/before the target date (never the live quote — the forecast was
      // about a specific date).
      const grade = async (h: LockedForecastHorizon | null): Promise<ForecastLockVerdict | null> => {
        if (!h || today < h.targetDate) return null;
        if (!barsCache.has(t.ticker)) {
          try {
            barsCache.set(t.ticker, await marketDataService.getDailyBars(t.ticker, "6mo"));
          } catch {
            barsCache.set(t.ticker, []);
          }
        }
        const bars = barsCache.get(t.ticker)!;
        let actual: Bar | null = null;
        for (let i = bars.length - 1; i >= 0; i--) {
          if (bars[i].date <= h.targetDate) {
            actual = bars[i];
            break;
          }
        }
        if (!actual || !(lock.baseClose > 0)) return null;
        const actualReturnPct = round2((actual.close / lock.baseClose - 1) * 100);
        return {
          actualPrice: round2(actual.close),
          actualDate: actual.date,
          actualReturnPct,
          withinBand: actual.close >= h.lowPrice && actual.close <= h.highPrice,
          directionHit:
            Math.sign(actual.close - lock.baseClose) === Math.sign(h.expectedPrice - lock.baseClose),
          errorPct: round2(Math.abs(h.expectedReturnPct - actualReturnPct)),
        };
      };

      const verdict7 = await grade(lock.h7);
      const verdict30 = await grade(lock.h30);
      const matured30 = lock.h30 ? today >= lock.h30.targetDate : false;

      rows.push({
        tradeId: t.id,
        ticker: t.ticker,
        name: t.name ?? null,
        qty: t.qty,
        tradeStatus: t.status,
        buyPrice: round2(t.price),
        buyDate,
        lock,
        live: {
          price: livePrice != null ? round2(livePrice) : null,
          vsBaseClosePct:
            livePrice != null && lock.baseClose > 0
              ? round2((livePrice / lock.baseClose - 1) * 100)
              : null,
          positionPnl:
            livePrice != null ? round2((livePrice - t.price) * t.qty) : null,
        },
        daysElapsed,
        daysRemaining30: lock.h30 ? Math.max(0, calendarDaysBetween(today, lock.h30.targetDate)) : 0,
        status: matured30 ? "MATURED" : "TRACKING",
        verdict7,
        verdict30,
      });
    }

    return {
      rows,
      note:
        "Each forecast was frozen the moment you bought and is NEVER recomputed — this section exists so reality can grade the model. " +
        "Verdicts use the real close on the target date (vs the forecast's own anchor close), separately from your position P&L. " +
        "Trades recorded before this feature carry no locked forecast and are not shown.",
      updatedAt: new Date().toISOString(),
    };
  }

  private async executeSell(
    account: PaperAccount,
    ticker: string,
    qty: number,
    price: number
  ): Promise<RecordTradeResponse> {
    const repo = AppDataSource.getRepository(PaperTrade);
    const openLots = await repo.find({
      where: { accountId: account.id, ticker, status: "OPEN", side: "BUY" },
      order: { executedAt: "ASC" },
    });
    const owned = openLots.reduce((s, l) => s + l.qty, 0);
    if (qty > owned) {
      throw new HttpError(
        400,
        `Cannot sell ${qty} × ${ticker}: only ${owned} share${owned === 1 ? "" : "s"} held.`
      );
    }

    const proceeds = qty * price;
    const sellFees = estimateSellFees(proceeds);
    const now = new Date();

    const { closedViews, totalPnl } = await AppDataSource.transaction(async (em) => {
      const tradeRepo = em.getRepository(PaperTrade);
      const closedLots: PaperTrade[] = [];
      let remaining = qty;
      let pnlSum = 0;

      for (const lot of openLots) {
        if (remaining <= 0) break;
        const sold = Math.min(remaining, lot.qty);
        const buyFeePortion = lot.fees * (sold / lot.qty);
        const sellFeePortion = sellFees * (sold / qty);
        const pnl = round2((price - lot.price) * sold - buyFeePortion - sellFeePortion);
        pnlSum += pnl;

        if (sold === lot.qty) {
          lot.status = "CLOSED";
          lot.exitPrice = price;
          lot.exitAt = now;
          lot.realizedPnl = pnl;
          lot.fees = round2(lot.fees + sellFeePortion);
          await tradeRepo.save(lot);
          closedLots.push(lot);
        } else {
          // Split the lot: the sold part becomes its own CLOSED row.
          lot.qty -= sold;
          lot.fees = round2(lot.fees - buyFeePortion);
          await tradeRepo.save(lot);
          const closedPart = tradeRepo.create({
            accountId: account.id,
            ticker,
            name: lot.name ?? null,
            side: "BUY" as const,
            qty: sold,
            price: lot.price,
            fees: round2(buyFeePortion + sellFeePortion),
            executedAt: lot.executedAt,
            status: "CLOSED" as const,
            stopLoss: lot.stopLoss ?? null,
            target: lot.target ?? null,
            exitPrice: price,
            exitAt: now,
            realizedPnl: pnl,
            note: `partial exit of lot ${lot.id}`,
            // V10 B4 — the split lot keeps its BUY-time context so closed
            // rows never lose their factor snapshot.
            entryContext: lot.entryContext ?? null,
          });
          closedLots.push(await tradeRepo.save(closedPart));
        }
        remaining -= sold;
      }

      account.cash = round2(account.cash + proceeds - sellFees);
      await em.getRepository(PaperAccount).save(account);
      return { closedViews: closedLots.map(tradeToView), totalPnl: round2(pnlSum) };
    });

    const name = openLots[0]?.name ?? null;
    return {
      side: "SELL",
      ticker,
      name,
      qty,
      price: round2(price),
      fees: sellFees,
      realizedPnl: totalPnl,
      cash: account.cash,
      trade: null,
      closedLots: closedViews,
      message:
        `Sold ${qty} × ${ticker} @ ${inr(price)} (${inr(sellFees)} fees). ` +
        `Realized P&L ${totalPnl >= 0 ? "+" : ""}${inr(totalPnl)} net of fees. Cash ${inr(account.cash)}.`,
    };
  }

  // ── Account view ──────────────────────────────────────────────────────────

  async getAccount(): Promise<AdminAccountResponse> {
    const account = await this.getAccountRow();
    const repo = AppDataSource.getRepository(PaperTrade);
    const allTrades = await repo.find({
      where: { accountId: account.id },
      order: { executedAt: "DESC" },
    });
    const openLots = allTrades
      .filter((t) => t.status === "OPEN")
      .sort((a, b) => a.executedAt.getTime() - b.executedAt.getTime());

    const openPositions = await this.buildOpenPositions(openLots);
    const equity = round2(
      account.cash + openPositions.reduce((s, p) => s + p.livePrice * p.trade.qty, 0)
    );
    const realizedPnl = round2(
      allTrades.reduce((s, t) => s + (t.realizedPnl ?? 0), 0)
    );
    const equityCurve = await this.deriveEquityCurve(account, allTrades, openPositions);
    const goals = this.buildGoalTracker(account, equity);

    return {
      account: {
        name: account.name,
        startCapital: round2(account.startCapital),
        cash: round2(account.cash),
      },
      equity,
      openPositions,
      realizedPnl,
      equityCurve,
      goals,
      history: allTrades.map(tradeToView),
    };
  }

  /** Live price + advice for each open lot (advice engine per V2-D spec). */
  private async buildOpenPositions(openLots: PaperTrade[]): Promise<OpenPositionView[]> {
    const views: OpenPositionView[] = [];
    const scoreCache = new Map<string, number | null>();
    const priceCache = new Map<string, number | null>();

    for (const lot of openLots) {
      let livePrice = priceCache.get(lot.ticker);
      if (livePrice === undefined) {
        livePrice = await this.livePriceFor(lot.ticker);
        priceCache.set(lot.ticker, livePrice);
      }
      const effectivePrice = livePrice ?? lot.price;
      const unrealizedPnl = round2((effectivePrice - lot.price) * lot.qty);
      const unrealizedPnlPct =
        lot.price > 0 ? round2(((effectivePrice - lot.price) / lot.price) * 100) : 0;

      let advice: PositionAdvice;
      let adviceReason: string;
      if (livePrice === null) {
        advice = "HOLD";
        adviceReason = `No live price available for ${lot.ticker} right now — showing entry price; re-check later.`;
      } else if (lot.stopLoss != null && livePrice <= lot.stopLoss) {
        advice = "SELL_NOW_STOP_HIT";
        adviceReason = `Live ${inr(livePrice)} ≤ stop-loss ${inr(lot.stopLoss)} — exit now, protect capital.`;
      } else if (lot.target != null && livePrice >= lot.target) {
        advice = "BOOK_PROFIT_TARGET_HIT";
        adviceReason = `Live ${inr(livePrice)} ≥ target ${inr(lot.target)} — book the profit per the 3:1 plan.`;
      } else if (
        lot.stopLoss != null &&
        lot.stopLoss < lot.price &&
        livePrice >= lot.price + (lot.price - lot.stopLoss)
      ) {
        // Up ≥1R with the stop still below entry: veteran rule — never let a
        // 1R winner turn into a loss. Raise the stop to breakeven and trail.
        advice = "RAISE_STOP_TRAIL";
        adviceReason =
          `Up ${inr(livePrice - lot.price)} (≥1R, one full risk unit) from entry ${inr(lot.price)} — ` +
          `raise the stop from ${inr(lot.stopLoss)} to breakeven ${inr(lot.price)} and trail it. ` +
          `The trade can no longer lose money once the stop sits at entry.`;
      } else {
        if (!scoreCache.has(lot.ticker)) {
          scoreCache.set(lot.ticker, await this.quantScoreFor(lot.ticker));
        }
        const score = scoreCache.get(lot.ticker) ?? null;
        if (score !== null && score < MOMENTUM_EXIT_SCORE) {
          advice = "EXIT_MOMENTUM_LOST";
          adviceReason = `Quant score ${score}/100 has dropped below ${MOMENTUM_EXIT_SCORE} — momentum lost, consider exiting.`;
        } else {
          advice = "HOLD";
          adviceReason =
            score !== null
              ? `Quant score ${score}/100; live ${inr(livePrice)} is between stop ${
                  lot.stopLoss != null ? inr(lot.stopLoss) : "n/a"
                } and target ${lot.target != null ? inr(lot.target) : "n/a"}.`
              : `Live ${inr(livePrice)} is between stop and target; quant score unavailable right now.`;
        }
      }

      views.push({
        trade: tradeToView(lot),
        livePrice: round2(effectivePrice),
        unrealizedPnl,
        unrealizedPnlPct,
        advice,
        adviceReason,
      });
    }
    return views;
  }

  private async livePriceFor(ticker: string): Promise<number | null> {
    try {
      return (await marketDataService.getQuote(ticker)).price;
    } catch {
      try {
        const bars = await marketDataService.getDailyBars(ticker, "3mo");
        return bars.length ? bars[bars.length - 1].close : null;
      } catch {
        return null;
      }
    }
  }

  private async quantScoreFor(ticker: string): Promise<number | null> {
    try {
      const bars = await marketDataService.getDailyBars(ticker, "1y");
      if (bars.length < 60) return null;
      return analyzeBars(bars).score;
    } catch {
      return null;
    }
  }

  // ── Equity curve (DERIVED on request — never stored) ──────────────────────

  /**
   * Reconstructs the daily equity curve from the trade ledger + daily closes:
   *   buy event  at executedAt: cash −= qty×price + buyFees(qty×price)
   *   exit event at exitAt:     cash += qty×price + buyFees + realizedPnl
   * (the exit identity holds exactly because realizedPnl is net of all fees).
   * Open lots are valued at the close on-or-before each date.
   */
  private async deriveEquityCurve(
    account: PaperAccount,
    allTrades: PaperTrade[],
    openPositions: OpenPositionView[]
  ): Promise<Array<{ date: string; equity: number }>> {
    const startDate = istDateString(this.challengeStart(account));
    const today = istDateString(new Date());

    interface CashEvent {
      date: string;
      delta: number;
      ticker: string;
      qty: number; // + open, − close
    }
    const events: CashEvent[] = [];
    for (const t of allTrades) {
      if (t.side !== "BUY") continue;
      const buyFees = estimateBuyFees(t.qty * t.price);
      events.push({
        date: istDateString(t.executedAt),
        delta: -(t.qty * t.price + buyFees),
        ticker: t.ticker,
        qty: t.qty,
      });
      if (t.status === "CLOSED" && t.exitAt) {
        events.push({
          date: istDateString(t.exitAt),
          delta: t.qty * t.price + buyFees + (t.realizedPnl ?? 0),
          ticker: t.ticker,
          qty: -t.qty,
        });
      }
    }
    events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    // Daily closes for involved tickers (from the DB-cached bars — no scan).
    const tickers = Array.from(new Set(events.map((e) => e.ticker)));
    const barsByTicker = new Map<string, Bar[]>();
    for (const ticker of tickers) {
      try {
        barsByTicker.set(ticker, await marketDataService.getDailyBars(ticker, "1y"));
      } catch {
        barsByTicker.set(ticker, []);
      }
    }
    const livePriceByTicker = new Map<string, number>();
    for (const p of openPositions) livePriceByTicker.set(p.trade.ticker, p.livePrice);

    const closeOnOrBefore = (ticker: string, date: string, fallback: number): number => {
      const bars = barsByTicker.get(ticker) ?? [];
      for (let i = bars.length - 1; i >= 0; i--) {
        if (bars[i].date <= date) return bars[i].close;
      }
      return fallback;
    };

    const curve: Array<{ date: string; equity: number }> = [];
    let cash = account.startCapital;
    const holdings = new Map<string, { qty: number; lastPrice: number }>();
    let eventIdx = 0;
    let date = startDate;
    let guard = 0;
    while (date <= today && guard < 1500) {
      guard++;
      while (eventIdx < events.length && events[eventIdx].date <= date) {
        const ev = events[eventIdx];
        cash += ev.delta;
        const h = holdings.get(ev.ticker) ?? { qty: 0, lastPrice: 0 };
        h.qty += ev.qty;
        holdings.set(ev.ticker, h);
        eventIdx++;
      }
      let positionsValue = 0;
      for (const [ticker, h] of holdings) {
        if (h.qty <= 0) continue;
        // Today's point uses the live quote (matches `equity`); historical
        // points use the official daily close on-or-before that date.
        const live = date === today ? livePriceByTicker.get(ticker) : undefined;
        const close = live ?? closeOnOrBefore(ticker, date, h.lastPrice);
        h.lastPrice = close;
        positionsValue += h.qty * close;
      }
      curve.push({ date, equity: round2(cash + positionsValue) });
      date = addCalendarDays(date, 1);
    }
    if (curve.length === 0) {
      curve.push({ date: today, equity: round2(account.cash) });
    }
    return curve;
  }

  // ── Goal tracker ──────────────────────────────────────────────────────────

  /** When the current challenge run started (reset-aware). */
  private challengeStart(account: PaperAccount): Date {
    return account.challengeStartedAt ?? account.createdAt;
  }

  /** Effective dynamic goal parameters (user-configurable, with the original defaults). */
  private goalParams(account: PaperAccount): { start: number; target: number; days: number } {
    return {
      start: account.startCapital > 0 ? account.startCapital : ADMIN_START_CAPITAL,
      target: account.targetAmount ?? DEFAULT_TARGET_AMOUNT,
      days: account.targetDays ?? DEFAULT_TARGET_DAYS,
    };
  }

  private buildGoalTracker(account: PaperAccount, currentEquity: number): GoalTracker {
    const { start, target, days } = this.goalParams(account);
    const milestones = milestonesFor(start, target, days);
    const startedAt = this.challengeStart(account);
    const msElapsed = Date.now() - startedAt.getTime();
    const currentDay = Math.max(1, Math.floor(msElapsed / 86_400_000) + 1);

    const next = milestones.find((m) => m.day >= currentDay) ?? milestones[milestones.length - 1];
    const daysRemaining = Math.max(1, next.day - currentDay + 1);

    const requiredDaily =
      currentEquity > 0 && next.target > currentEquity
        ? (Math.pow(next.target / currentEquity, 1 / daysRemaining) - 1) * 100
        : 0;
    const achievedDaily =
      currentEquity > 0 ? (Math.pow(currentEquity / start, 1 / currentDay) - 1) * 100 : -100;

    // On track = at or above the geometric path from start to the final target.
    const pathEquity =
      target > start
        ? start * Math.pow(target / start, Math.min(currentDay, days) / days)
        : start;
    const onTrack = currentEquity >= pathEquity;

    return {
      milestones,
      startedAt: startedAt.toISOString(),
      currentEquity: round2(currentEquity),
      currentDay,
      onTrack,
      requiredDailyReturnPctToNextMilestone: round2(requiredDaily),
      achievedAvgDailyReturnPct: round2(achievedDaily),
    };
  }

  // ── Settings (dynamic capital + target) ───────────────────────────────────

  /**
   * Update the goal (targetAmount/targetDays) in place; changing startCapital
   * (or passing confirmReset) RESETS the challenge: deletes all paper trades,
   * sets cash = startCapital and restarts the day counter. Destructive resets
   * require confirmReset: true — the UI double-confirms before sending it.
   */
  async updateSettings(req: AdminSettingsRequest): Promise<AdminAccountResponse> {
    const account = await this.getAccountRow();

    let targetAmount: number | undefined;
    if (req.targetAmount !== undefined) {
      const t = Number(req.targetAmount);
      if (!Number.isFinite(t) || t < SETTINGS_CAPITAL_MIN || t > SETTINGS_TARGET_MAX) {
        throw new HttpError(
          400,
          `"targetAmount" must be between ₹${SETTINGS_CAPITAL_MIN.toLocaleString("en-IN")} and ₹${SETTINGS_TARGET_MAX.toLocaleString("en-IN")}.`
        );
      }
      targetAmount = round2(t);
    }
    let targetDays: number | undefined;
    if (req.targetDays !== undefined) {
      const d = Math.floor(Number(req.targetDays));
      if (!Number.isFinite(d) || d < SETTINGS_DAYS_MIN || d > SETTINGS_DAYS_MAX) {
        throw new HttpError(400, `"targetDays" must be an integer between ${SETTINGS_DAYS_MIN} and ${SETTINGS_DAYS_MAX}.`);
      }
      targetDays = d;
    }
    let startCapital: number | undefined;
    if (req.startCapital !== undefined) {
      const s = Number(req.startCapital);
      if (!Number.isFinite(s) || s < SETTINGS_CAPITAL_MIN || s > SETTINGS_CAPITAL_MAX) {
        throw new HttpError(
          400,
          `"startCapital" must be between ₹${SETTINGS_CAPITAL_MIN.toLocaleString("en-IN")} and ₹${SETTINGS_CAPITAL_MAX.toLocaleString("en-IN")}.`
        );
      }
      startCapital = round2(s);
    }
    if (targetAmount === undefined && targetDays === undefined && startCapital === undefined && !req.confirmReset) {
      throw new HttpError(400, "Provide at least one of startCapital, targetAmount, targetDays (or confirmReset to restart).");
    }

    const wantsReset = startCapital !== undefined || req.confirmReset === true;
    if (startCapital !== undefined && req.confirmReset !== true) {
      throw new HttpError(
        400,
        "Changing startCapital resets the challenge and erases the paper trade history — send confirmReset: true to proceed."
      );
    }

    const effectiveTarget = targetAmount ?? account.targetAmount ?? DEFAULT_TARGET_AMOUNT;
    const effectiveStart = startCapital ?? account.startCapital;
    if (effectiveTarget <= effectiveStart) {
      throw new HttpError(
        400,
        `"targetAmount" (${inr(effectiveTarget)}) must be greater than the start capital (${inr(effectiveStart)}).`
      );
    }

    await AppDataSource.transaction(async (em) => {
      if (wantsReset) {
        await em.getRepository(PaperTrade).delete({ accountId: account.id });
        account.startCapital = effectiveStart;
        account.cash = effectiveStart;
        account.challengeStartedAt = new Date();
      }
      if (targetAmount !== undefined) account.targetAmount = targetAmount;
      if (targetDays !== undefined) account.targetDays = targetDays;
      await em.getRepository(PaperAccount).save(account);
    });

    return this.getAccount();
  }

  // ── Reality check (computed from LIVE ModelPerformance — never hardcoded) ──

  private async buildRealityCheck(start: number, target: number, days: number): Promise<string> {
    const impliedDailyPct = target > start ? (Math.pow(target / start, 1 / days) - 1) * 100 : 0;
    const totalPct = start > 0 ? (target / start - 1) * 100 : 0;

    let measured = "";
    let band = "";
    try {
      const accuracy = await stockService.getAccuracy();
      const h1 = accuracy.overall.find((h) => h.horizonDays === 1);
      if (h1 && h1.samples > 0) {
        const hit = h1.directionHitRatePct;
        const typicalMove = h1.avgAbsErrorPct; // ≈ typical 1-day move (mean abs error vs near-zero predictions)
        measured =
          `Measured 1-day direction accuracy across the universe is currently ${hit.toFixed(1)}% ` +
          `over ${h1.samples.toLocaleString("en-IN")} backtest samples, with a typical 1-day move of ~${typicalMove.toFixed(2)}%.`;
        // Realistic month band from the measured numbers: daily edge ± 1.65σ√21.
        const edgePerDay = ((2 * hit) / 100 - 1) * typicalMove;
        const monthEdge = edgePerDay * 21;
        const monthSigma = typicalMove * Math.sqrt(21);
        const lo = Math.round(monthEdge - 1.65 * monthSigma);
        const hi = Math.round(monthEdge + 1.65 * monthSigma);
        band =
          ` At those measured odds, a disciplined month realistically lands around ` +
          `${lo}%..${hi >= 0 ? "+" : ""}${hi}% — not +${totalPct.toFixed(0)}%.`;
      } else {
        measured =
          "No measured backtest accuracy is available yet (ModelPerformance is empty) — run the seed/backtest script for honest odds.";
      }
    } catch (err) {
      measured = `Measured accuracy could not be loaded right now (${(err as Error).message}).`;
    }

    return (
      `Reality check: turning ${inr(start)} into ${inr(target)} in ${days} day${days === 1 ? "" : "s"} ` +
      `is a total of +${totalPct.toFixed(0)}% and implies ~${impliedDailyPct.toFixed(1)}%/day compounded. ` +
      measured +
      ` These milestones are aspirational targets, not promises — no honest statistical model supports ` +
      `~${impliedDailyPct.toFixed(1)}%/day compounded returns${impliedDailyPct > 1 ? "" : " being guaranteed"}.` +
      band
    );
  }

  // ── Daily plan ────────────────────────────────────────────────────────────

  async getDailyPlan(): Promise<DailyPlanResponse> {
    const account = await this.getAccountRow();
    const cash = round2(account.cash);

    const marketRegime = await macroService.getMarketRegime().catch(() => null);

    // Candidate scan — REUSES the cached top-picks scan (no extra fetching).
    let pick: DailyPlanPick | null = null;
    let noPickReason: string | undefined;
    try {
      const scan = await stockService.getScanSnapshot();
      const budget = cash * AFFORDABILITY_FACTOR;
      const buys = scan.entries.filter((e) => e.recommendation === "BUY");
      const affordable = buys.filter((e) => e.price <= budget);
      const withPlans = affordable
        .map((e) => ({
          e,
          plan: buildTradePlan({
            entry: e.price,
            atr14: e.atr14,
            annualVolatilityPct: e.annualVolatilityPct,
            recommendation: e.recommendation,
          }),
        }))
        .filter((c) => c.plan !== null);
      const meetingRR = withPlans.filter((c) => c.plan!.meetsRewardRisk);
      const confident = meetingRR.filter(
        (c) => (c.e.directionProb7d ?? 0) >= MIN_DIRECTION_PROB_7D
      );
      confident.sort((a, b) => b.e.score - a.e.score);

      const best = confident[0];
      if (best && best.plan) {
        const e = best.e;
        const plan = best.plan;
        let qty = Math.floor(budget / e.price);
        while (qty > 0 && qty * e.price + estimateBuyFees(qty * e.price) > cash) qty -= 1;
        if (qty > 0) {
          const invested = round2(qty * e.price);
          const fees = estimateRoundTripFees(invested);
          const perf = await this.historicalOddsFor(e.ticker);
          pick = {
            ticker: e.ticker,
            name: e.name,
            price: round2(e.price),
            qty,
            invested,
            score: e.score,
            directionProb7d: e.directionProb7d ?? 0,
            entry: plan.entry,
            stopLoss: plan.stopLoss,
            target: plan.target,
            maxLoss: round2(qty * (plan.entry - plan.stopLoss)),
            potentialGain: round2(qty * (plan.target - plan.entry)),
            fees: fees.roundTrip,
            reasons: e.topReasons,
            historicalOdds: perf,
          };
        }
      }
      if (!pick) {
        noPickReason =
          `No affordable BUY setup today: of ${scan.scannedCount} stocks scanned, ` +
          `${buys.length} are BUY-rated, ${affordable.length} trade at or under your ` +
          `${inr(budget)} budget (cash ${inr(cash)} × 0.98), ${meetingRR.length} of those pass the ` +
          `3:1 reward-risk plausibility check, and ${confident.length} also have a 7-day up-probability ≥ 55%. ` +
          `Holding cash is the right move — forcing a trade that fails these filters is how small accounts die.`;
      }
    } catch (err) {
      noPickReason = `Universe scan unavailable right now (${(err as Error).message}) — no pick can be made honestly today.`;
    }

    // Exit advice for open positions (same advice engine as /account).
    const repo = AppDataSource.getRepository(PaperTrade);
    const openLots = await repo.find({
      where: { accountId: account.id, status: "OPEN", side: "BUY" },
      order: { executedAt: "ASC" },
    });
    const positions = await this.buildOpenPositions(openLots);
    const exitAdvice = positions.map((p) => ({
      ticker: p.trade.ticker,
      action: p.advice,
      reason: p.adviceReason,
    }));

    // Prop-desk daily loss limit: when hit, withhold ALL new-trade suggestions.
    const lossGuard = await this.computeLossGuard(account, positions);
    if (lossGuard.halted) {
      pick = null;
      noPickReason = lossGuard.message;
    }

    const equity = round2(
      cash + positions.reduce((s, p) => s + p.livePrice * p.trade.qty, 0)
    );
    const goalTracker = this.buildGoalTracker(account, equity);
    const { start, target, days } = this.goalParams(account);
    const realityCheck = await this.buildRealityCheck(start, target, days);

    // Multi-stock split of the available cash (same filters as the pick).
    let allocation: DailyPlanResponse["allocation"] = null;
    let allocationReason: string | undefined;
    if (lossGuard.halted) {
      allocationReason = lossGuard.message;
    } else if (cash >= 100) {
      try {
        // The daily desk is a swing desk — short-term strategy by design.
        const suggested = await portfolioService.suggest(cash, "short-term");
        allocation = suggested.allocation;
        allocationReason = suggested.reason;
      } catch (err) {
        allocationReason = `Allocation could not be computed right now (${(err as Error).message}).`;
      }
    } else {
      allocationReason = `Available cash ${inr(cash)} is below the ₹100 minimum for a new position.`;
    }

    const response: DailyPlanResponse = {
      asOf: new Date().toISOString(),
      cash,
      marketRegime,
      pick,
      allocation,
      exitAdvice,
      goalTracker,
      lossGuard,
      realityCheck,
    };
    if (noPickReason) response.noPickReason = noPickReason;
    if (allocationReason) response.allocationReason = allocationReason;
    return response;
  }

  // ── Daily loss guard (prop-desk rule: cap the damage a single day can do) ──

  /**
   * Counts today's realized P&L plus current open-position drawdown against a
   * 3%-of-equity cap. Conservative: the full open drawdown counts even if part
   * of it accrued on earlier days — a veteran would rather stop early than
   * argue with the accountant. When halted, the daily plan withholds new picks.
   */
  private async computeLossGuard(
    account: PaperAccount,
    positions: OpenPositionView[]
  ): Promise<LossGuard> {
    const todayIst = istDateString(new Date());
    const repo = AppDataSource.getRepository(PaperTrade);
    const recentClosed = await repo.find({
      where: { accountId: account.id, status: "CLOSED" },
      order: { exitAt: "DESC" },
      take: 100,
    });
    const todayRealizedPnl = round2(
      recentClosed
        .filter((t) => t.exitAt && istDateString(t.exitAt) === todayIst)
        .reduce((s, t) => s + (t.realizedPnl ?? 0), 0)
    );
    const openUnrealizedPnl = round2(positions.reduce((s, p) => s + p.unrealizedPnl, 0));
    const equityNow = round2(
      account.cash + positions.reduce((s, p) => s + p.livePrice * p.trade.qty, 0)
    );
    const limitPct = 3;
    const limit = round2(Math.max(1, (equityNow * limitPct) / 100));
    const effectiveDrawdown = round2(
      Math.min(0, todayRealizedPnl) + Math.min(0, openUnrealizedPnl)
    );
    const halted = -effectiveDrawdown >= limit;
    const message = halted
      ? `Daily loss limit hit: realized today ${inr(todayRealizedPnl)} plus open drawdown ` +
        `${inr(Math.min(0, openUnrealizedPnl))} exceeds the ${limitPct}% cap (${inr(limit)}). ` +
        `No new trades today — the prop-desk rule that stops one bad day from becoming a bad month. ` +
        `Manage the open positions per their exit advice and reassess tomorrow.`
      : `Daily loss guard: cap ${limitPct}% of equity (${inr(limit)}). Counted so far — realized today ` +
        `${inr(todayRealizedPnl)}, open drawdown ${inr(Math.min(0, openUnrealizedPnl))}. New trades allowed.`;
    return { limitPct, limit, todayRealizedPnl, openUnrealizedPnl, effectiveDrawdown, halted, message };
  }

  // ── Prediction audit — the validation loop the desk exists for ─────────────

  /**
   * Confronts every VERIFIED live prediction with what actually happened
   * (the 18:30 IST job fills actuals from real closes), compares live hit
   * rates to the walk-forward backtest baseline, classifies every closed
   * paper trade against its own stop/target plan, and computes expectancy
   * (Zerodha Varsity Module 9 / Van Tharp). Hits build trust; misses point
   * at what to fix. No number here is fabricated.
   */
  async getPredictionAudit(): Promise<PredictionAuditResponse> {
    const account = await this.getAccountRow();
    const logRepo = AppDataSource.getRepository(PredictionLog);
    const tradeRepo = AppDataSource.getRepository(PaperTrade);
    const toNum = (x: unknown): number | null => {
      if (x === null || x === undefined) return null;
      const n = Number(x);
      return Number.isFinite(n) ? n : null;
    };

    const [verified, pendingCount] = await Promise.all([
      logRepo.find({
        where: { actualReturn: Not(IsNull()) },
        order: { targetDate: "DESC" },
        take: 500,
      }),
      logRepo.count({ where: { actualReturn: IsNull() } }),
    ]);

    const allRows: VerifiedPredictionRow[] = verified.map((l) => {
      const base = toNum(l.basePrice);
      const exp = toNum(l.expectedPrice);
      const predictedPct =
        base != null && exp != null && base > 0
          ? round2((exp / base - 1) * 100)
          : round2(toNum(l.expectedReturn) ?? 0);
      const low = toNum(l.low80Pct);
      const high = toNum(l.high80Pct);
      const actualPct = round2(toNum(l.actualReturn) ?? 0);
      const withinBand = low != null && high != null ? actualPct >= low && actualPct <= high : null;
      return {
        ticker: l.ticker,
        predictionDate: String(l.predictionDate),
        horizonDays: l.horizonDays ?? 0,
        targetDate: l.targetDate ? String(l.targetDate) : null,
        predictedPct,
        low80Pct: low != null ? round2(low) : null,
        high80Pct: high != null ? round2(high) : null,
        actualPct,
        hit: l.predictionCorrect === true,
        withinBand,
        errorPct: round2(Math.abs(predictedPct - actualPct)),
        recommendationGiven: l.recommendationGiven ?? null,
      };
    });

    const byHorizon = new Map<number, VerifiedPredictionRow[]>();
    for (const r of allRows) {
      const arr = byHorizon.get(r.horizonDays) ?? [];
      arr.push(r);
      byHorizon.set(r.horizonDays, arr);
    }
    const liveStats: LivePredictionStats[] = [...byHorizon.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([h, rs]) => {
        const banded = rs.filter((r) => r.withinBand !== null);
        return {
          horizonDays: h,
          samples: rs.length,
          hitRatePct: round2((rs.filter((r) => r.hit).length / rs.length) * 100),
          avgAbsErrorPct: round2(rs.reduce((s, r) => s + r.errorPct, 0) / rs.length),
          withinBandPct: banded.length
            ? round2((banded.filter((r) => r.withinBand).length / banded.length) * 100)
            : null,
        };
      });

    const accuracy = await stockService.getAccuracy().catch(() => null);
    const baseline = accuracy?.overall ?? [];

    let verdict: string;
    if (allRows.length < 30) {
      verdict =
        `Only ${allRows.length} live prediction${allRows.length === 1 ? "" : "s"} verified so far ` +
        `(${pendingCount.toLocaleString("en-IN")} pending — the 18:30 IST job verifies matured ones each trading day). ` +
        `Below ~30 samples any hit rate is statistical noise. The loop is running; judge it once the sample grows.`;
    } else {
      const live1 = liveStats.find((s) => s.horizonDays === 1);
      const base1 = baseline.find((b) => b.horizonDays === 1);
      if (live1 && base1 && live1.samples >= 30) {
        const diff = round2(live1.hitRatePct - base1.directionHitRatePct);
        verdict =
          diff <= -5
            ? `Live 1-day direction accuracy ${live1.hitRatePct}% is ${Math.abs(diff)}pp BELOW the backtest baseline ` +
              `(${base1.directionHitRatePct.toFixed(1)}%) over ${live1.samples} verified predictions — investigate: ` +
              `market regime may have shifted since the backtest window, news gaps land outside any model's sight, ` +
              `or the live sample is still thin. If it persists past ~100 samples, re-run the backtest and recalibrate.`
            : diff >= 5
              ? `Live 1-day direction accuracy ${live1.hitRatePct}% is ${diff}pp ABOVE the backtest baseline ` +
                `(${base1.directionHitRatePct.toFixed(1)}%) over ${live1.samples} predictions — pleasant, but treat it ` +
                `as small-sample luck, not a new normal. Do not size up because of it.`
              : `Live 1-day direction accuracy ${live1.hitRatePct}% vs backtest baseline ${base1.directionHitRatePct.toFixed(1)}% ` +
                `over ${live1.samples} verified predictions — consistent within noise. The model is behaving as measured; ` +
                `edge comes from the risk discipline built on top of it.`;
      } else {
        verdict = `Verified predictions exist across horizons, but the 1-day sample is still below 30 — the headline comparison unlocks as evidence accumulates.`;
      }
    }

    const closed = await tradeRepo.find({
      where: { accountId: account.id, status: "CLOSED" },
      order: { exitAt: "DESC" },
      take: 200,
    });
    const tradeReview: TradeReviewRow[] = closed.slice(0, 30).map((t) => {
      const exit = t.exitPrice != null ? Number(t.exitPrice) : null;
      const target = t.target != null ? Number(t.target) : null;
      const stop = t.stopLoss != null ? Number(t.stopLoss) : null;
      let outcome: TradeReviewRow["outcome"];
      let planNote: string;
      if (exit != null && target != null && exit >= target * 0.995) {
        outcome = "TARGET_HIT";
        planNote = "Exited at/above the 3:1 target — the model's call and the discipline both worked.";
      } else if (exit != null && stop != null && exit <= stop * 1.005) {
        outcome = "STOPPED_OUT";
        planNote =
          "Stop-loss did its job: loss capped at plan size. Being stopped ~half the time is expected — the 3:1 payoff when right is what pays for it.";
      } else {
        outcome = "MANUAL_EXIT";
        planNote = "Closed before stop or target — this outcome reflects the trader's call, not the model's plan.";
      }
      return {
        ticker: t.ticker,
        name: t.name ?? null,
        qty: t.qty,
        entry: round2(Number(t.price)),
        exit: exit != null ? round2(exit) : null,
        stopLoss: stop != null ? round2(stop) : null,
        target: target != null ? round2(target) : null,
        realizedPnl: t.realizedPnl != null ? round2(Number(t.realizedPnl)) : null,
        outcome,
        planNote,
        exitAt: t.exitAt ? new Date(t.exitAt).toISOString() : null,
      };
    });

    const pnls = closed.map((t) => t.realizedPnl).filter((p): p is number => p != null);
    // V9: the win/loss/expectancy math is shared with ExecutionAnalyticsService
    // via executionStats.computeTradeBreakdown — one formula, never duplicated.
    const breakdown = computeTradeBreakdown(pnls);
    let tradeStats: TradeStats;
    if (!breakdown) {
      tradeStats = {
        closedTrades: 0,
        winRatePct: null,
        avgWin: null,
        avgLoss: null,
        expectancy: null,
        note: "No closed paper trades yet — record BUYs from the daily plan and close them per the exit advice; expectancy unlocks from the first close.",
      };
    } else {
      tradeStats = {
        closedTrades: breakdown.count,
        winRatePct: round2(breakdown.winRate * 100),
        avgWin: round2(breakdown.avgWin),
        avgLoss: round2(breakdown.avgLoss),
        expectancy: breakdown.expectancy,
        note:
          `Expectancy = (Win% × Avg Win) − (Loss% × Avg Loss) = ${inr(breakdown.expectancy)} per trade over ` +
          `${breakdown.count} closed paper trade${breakdown.count === 1 ? "" : "s"}. Positive expectancy plus position ` +
          `sizing is what makes an account survive (Zerodha Varsity Module 9 — Risk Management; Van Tharp). ` +
          `Win rate alone means nothing without the payoff ratio.`,
      };
    }

    const openLots = await tradeRepo.find({
      where: { accountId: account.id, status: "OPEN", side: "BUY" },
      order: { executedAt: "ASC" },
    });
    const positions = await this.buildOpenPositions(openLots);
    const lossGuard = await this.computeLossGuard(account, positions);

    return {
      recent: allRows.slice(0, 60),
      pendingCount,
      liveStats,
      baseline,
      verdict,
      tradeReview,
      tradeStats,
      lossGuard,
      methodology:
        "The loop: every analysis and every 08:45 IST morning scan logs the model's prediction per horizon " +
        "(expected % with its 80% band) BEFORE the outcome is knowable. After close, the 18:30 IST job fills in " +
        "what actually happened from real NSE closes. This page is the model confronting reality: hits earn trust, " +
        "misses get investigated (regime shift, news gaps, thin samples) instead of hidden. Paper trades add the " +
        "execution layer — did price reach the plan's target or stop? — and expectancy math (Zerodha Varsity " +
        "Module 9, Van Tharp) turns those closes into the one number that decides survival.",
      updatedAt: new Date().toISOString(),
    };
  }

  /** Per-ticker measured 7d odds from ModelPerformance (live, never hardcoded). */
  private async historicalOddsFor(ticker: string): Promise<string> {
    try {
      const row = await AppDataSource.getRepository(ModelPerformance).findOne({
        where: { ticker, modelVersion: MODEL_VERSION },
        order: { ranAt: "DESC" },
      });
      const h7 = row?.horizons?.find((h) => h.horizonDays === 7);
      if (h7 && h7.samples > 0) {
        return `7d direction hit rate for this stock: ${h7.directionHitRatePct.toFixed(1)}% (${h7.samples} samples)`;
      }
      return "No measured 7d backtest accuracy for this stock yet.";
    } catch {
      return "Historical accuracy could not be loaded right now.";
    }
  }
}

/** Singleton export. */
export const adminService = new AdminService();
export default adminService;
