/**
 * PaperTradingService — runs the paper pilot: the full decision flow on fake
 * money, finally exercising the whole apparatus against reality. Each cycle:
 *   1. resolve OPEN positions against real bars (stop / target / time exit);
 *   2. mark the remaining book to market;
 *   3. build candidates from the Conviction Board + breaker + regime;
 *   4. decide orders (the composed risk stack) and FILL them (intended vs actual);
 *   5. snapshot equity.
 * This is what turns "the system says" into "the system did".
 */

import { AppDataSource } from "../../config/database";
import { PaperPilotAccount, PaperPilotPosition, PaperPilotEquity } from "../../entities";
import { marketDataService } from "../market/MarketDataService";
import { istDateString } from "../forecast/dates";
import { Bar } from "../market/types";
import { convictionBoardService } from "./ConvictionBoardService";
import { riskControlService } from "./RiskControlService";
import { regimeService } from "./RegimeService";
import { decidePaperOrders, markToMarket, fillSlippageBps, PaperCandidate, OpenPosition } from "./paperPortfolio";

const ACCOUNT_NAME = "paper-pilot";
const STARTING_CAPITAL = 100000;
const MAX_HOLD_SESSIONS = 12;

function dailyReturns(bars: Bar[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].adjustedClose ?? bars[i - 1].close;
    const cur = bars[i].adjustedClose ?? bars[i].close;
    if (prev > 0) out.push(cur / prev - 1);
  }
  return out;
}

export interface CycleSummary {
  date: string;
  resolved: number;
  opened: number;
  rejected: number;
  breakerBlocked: boolean;
  regime: string | null;
  equityInr: number;
  cashInr: number;
  note: string;
}

export class PaperTradingService {
  private async ensureAccount(): Promise<PaperPilotAccount> {
    const repo = AppDataSource.getRepository(PaperPilotAccount);
    let acct = await repo.findOne({ where: { name: ACCOUNT_NAME } });
    if (!acct) acct = await repo.save(repo.create({ name: ACCOUNT_NAME, startingCapitalInr: String(STARTING_CAPITAL), cashInr: String(STARTING_CAPITAL) }));
    return acct;
  }

  /** Run one paper-trading cycle. Idempotent per day (re-running the same day
   *  re-resolves + re-snapshots but won't double-open — one open per ticker). */
  async runCycle(todayIn?: string): Promise<CycleSummary> {
    const today = todayIn ?? istDateString(new Date());
    const acct = await this.ensureAccount();
    const posRepo = AppDataSource.getRepository(PaperPilotPosition);
    let cash = Number(acct.cashInr);

    // ── 1. Resolve open positions against real bars ────────────────────────
    const open = await posRepo.find({ where: { accountId: acct.id, status: "OPEN" } });
    let resolved = 0;
    for (const p of open) {
      let bars: Bar[];
      try {
        bars = await marketDataService.getDailyBars(p.ticker, "6mo");
      } catch {
        continue;
      }
      const exit = resolveExit(bars, p.entryDate, Number(p.stop), Number(p.target), MAX_HOLD_SESSIONS, today);
      if (!exit) continue; // still open
      const qty = p.qty;
      const proceeds = qty * exit.price;
      const cost = qty * Number(p.entryPrice);
      const pnl = proceeds - cost;
      const riskPerShare = Number(p.entryPrice) - Number(p.stop);
      const realizedR = riskPerShare > 0 ? (exit.price - Number(p.entryPrice)) / riskPerShare : null;
      p.status = "CLOSED";
      p.exitPrice = String(round2(exit.price));
      p.exitDate = exit.date;
      p.exitReason = exit.reason;
      p.realizedPnlInr = String(round2(pnl));
      p.realizedR = realizedR != null ? String(round4(realizedR)) : null;
      await posRepo.save(p);
      cash += proceeds;
      resolved++;
    }

    // ── 2+3. Build candidates from the board, with breaker + regime ────────
    const stillOpen = await posRepo.find({ where: { accountId: acct.id, status: "OPEN" } });
    const openTickers = new Set(stillOpen.map((p) => p.ticker));
    const board = await convictionBoardService.board().catch(() => null);
    const breaker = await riskControlService.circuitBreaker().catch(() => null);
    const regime = await regimeService.detect().catch(() => null);

    const pool = board ? [...board.high, ...board.medium].filter((s) => !openTickers.has(s.ticker)).slice(0, 12) : [];
    const candidates: PaperCandidate[] = [];
    for (const s of pool) {
      if (s.entry == null || s.stop == null || s.target1 == null) continue;
      let returns: number[] = [];
      try {
        returns = dailyReturns(await marketDataService.getDailyBars(s.ticker, "6mo")).slice(-90);
      } catch {
        returns = [];
      }
      candidates.push({
        ticker: s.ticker,
        sector: s.industry ?? null,
        setupType: s.setupType,
        entry: s.entry,
        stop: s.stop,
        target1: s.target1,
        rewardToRisk: s.rewardRiskToT1 ?? 0,
        pWin: null, // no calibrated model yet ⇒ fixed-risk sizing
        convictionScore: s.score,
        tradeabilityBlocked: s.tradeabilityBlocked,
        returns,
      });
    }

    // Open positions for the correlation/limit checks.
    const openForLimits: OpenPosition[] = [];
    for (const p of stillOpen) {
      let returns: number[] = [];
      try {
        returns = dailyReturns(await marketDataService.getDailyBars(p.ticker, "6mo")).slice(-90);
      } catch {
        returns = [];
      }
      openForLimits.push({ ticker: p.ticker, sector: p.sector ?? null, qty: p.qty, entryPrice: Number(p.entryPrice), valueInr: p.qty * Number(p.entryPrice), returns });
    }

    const capital = STARTING_CAPITAL;
    const plan = decidePaperOrders({
      cashInr: cash,
      capitalInr: capital,
      openPositions: openForLimits,
      candidates,
      regime: regime?.regime ?? null,
      breakerCanEnter: breaker?.canEnter ?? true,
    });

    // ── 4. Fill new orders (limit-style: fill at min(entry, latest close)) ──
    let opened = 0;
    for (const o of plan.orders) {
      let fill = o.entryPrice;
      try {
        const bars = await marketDataService.getDailyBars(o.ticker, "3mo");
        const last = bars.length ? (bars[bars.length - 1].adjustedClose ?? bars[bars.length - 1].close) : o.entryPrice;
        fill = Math.min(o.entryPrice, last); // a buy-limit fills at the better of limit / market
      } catch {
        /* keep intended */
      }
      const value = o.qty * fill;
      if (value > cash) continue; // affordability guard after fill price
      await posRepo
        .createQueryBuilder()
        .insert()
        .values({
          accountId: acct.id,
          ticker: o.ticker,
          sector: o.sector,
          status: "OPEN",
          qty: o.qty,
          intendedEntry: String(round2(o.entryPrice)),
          entryPrice: String(round2(fill)),
          entryDate: today,
          slippageBps: fillSlippageBps(o.entryPrice, fill),
          stop: String(round2(o.stop)),
          target: String(round2(o.target)),
          riskInr: String(round2(o.riskInr)),
          convictionScore: String(o.convictionScore),
          sizing: { basis: o.sizingBasis, riskPct: o.riskPct, reasons: o.reasons },
        } as never)
        .orIgnore()
        .execute();
      cash -= value;
      opened++;
    }

    // ── 5. Mark to market + snapshot equity ────────────────────────────────
    const finalOpen = await posRepo.find({ where: { accountId: acct.id, status: "OPEN" } });
    const prices = new Map<string, number>();
    for (const p of finalOpen) {
      try {
        const bars = await marketDataService.getDailyBars(p.ticker, "3mo");
        prices.set(p.ticker, bars.length ? (bars[bars.length - 1].adjustedClose ?? bars[bars.length - 1].close) : Number(p.entryPrice));
      } catch {
        prices.set(p.ticker, Number(p.entryPrice));
      }
    }
    const eq = markToMarket(finalOpen.map((p) => ({ ticker: p.ticker, sector: p.sector ?? null, qty: p.qty, entryPrice: Number(p.entryPrice), valueInr: p.qty * Number(p.entryPrice), returns: [] })), prices, cash);

    acct.cashInr = String(round2(cash));
    acct.lastCycleDate = today;
    await AppDataSource.getRepository(PaperPilotAccount).save(acct);
    await AppDataSource.getRepository(PaperPilotEquity)
      .createQueryBuilder()
      .insert()
      .values({ accountId: acct.id, asOfDate: today, equityInr: String(eq.equityInr), cashInr: String(eq.cashInr), deployedInr: String(eq.deployedInr), openPositions: eq.openPositions, unrealizedPnlInr: String(eq.unrealizedPnlInr) } as never)
      .orUpdate(["equity_inr", "cash_inr", "deployed_inr", "open_positions", "unrealized_pnl_inr"], ["account_id", "as_of_date"])
      .execute();

    return {
      date: today,
      resolved,
      opened,
      rejected: plan.rejected.length,
      breakerBlocked: plan.breakerBlocked,
      regime: plan.regime,
      equityInr: eq.equityInr,
      cashInr: eq.cashInr,
      note: plan.notes.join(" "),
    };
  }

  /** The account view: equity curve, open positions, recent closed trades, stats. */
  async account(): Promise<Record<string, unknown>> {
    const acct = await this.ensureAccount();
    const posRepo = AppDataSource.getRepository(PaperPilotPosition);
    const open = await posRepo.find({ where: { accountId: acct.id, status: "OPEN" }, order: { createdAt: "DESC" } });
    const closed = await posRepo.find({ where: { accountId: acct.id, status: "CLOSED" }, order: { exitDate: "DESC" }, take: 50 });
    const equity = await AppDataSource.getRepository(PaperPilotEquity).find({ where: { accountId: acct.id }, order: { asOfDate: "ASC" } });

    const closedPnls = closed.map((p) => Number(p.realizedPnlInr ?? 0));
    const wins = closedPnls.filter((x) => x > 0).length;
    const rs = closed.map((p) => (p.realizedR != null ? Number(p.realizedR) : null)).filter((x): x is number => x != null);
    const slips = [...open, ...closed].map((p) => p.slippageBps);
    const latestEquity = equity.length ? Number(equity[equity.length - 1].equityInr) : STARTING_CAPITAL;
    const peak = equity.reduce((m, e) => Math.max(m, Number(e.equityInr)), STARTING_CAPITAL);

    return {
      version: "paper-pilot-v1",
      account: { name: acct.name, startingCapitalInr: Number(acct.startingCapitalInr), cashInr: Number(acct.cashInr), lastCycleDate: acct.lastCycleDate },
      equityInr: latestEquity,
      totalReturnPct: round2(((latestEquity - STARTING_CAPITAL) / STARTING_CAPITAL) * 100),
      drawdownFromPeakPct: round2(((latestEquity - peak) / peak) * 100),
      openPositions: open.map((p) => ({ ticker: p.ticker, sector: p.sector, qty: p.qty, entry: Number(p.entryPrice), stop: Number(p.stop), target: Number(p.target), slippageBps: p.slippageBps, conviction: p.convictionScore != null ? Number(p.convictionScore) : null, entryDate: p.entryDate })),
      closedTrades: closed.map((p) => ({ ticker: p.ticker, entry: Number(p.entryPrice), exit: p.exitPrice != null ? Number(p.exitPrice) : null, exitReason: p.exitReason, pnlInr: p.realizedPnlInr != null ? Number(p.realizedPnlInr) : null, realizedR: p.realizedR != null ? Number(p.realizedR) : null, entryDate: p.entryDate, exitDate: p.exitDate })),
      stats: {
        closed: closed.length,
        winRatePct: closed.length ? round2((wins / closed.length) * 100) : null,
        expectancyR: rs.length ? round4(rs.reduce((a, b) => a + b, 0) / rs.length) : null,
        realizedPnlInr: round2(closedPnls.reduce((a, b) => a + b, 0)),
        meanSlippageBps: slips.length ? Math.round(slips.reduce((a, b) => a + b, 0) / slips.length) : null,
      },
      equityCurve: equity.map((e) => ({ date: e.asOfDate, equityInr: Number(e.equityInr) })),
      caveat: "Paper pilot on fake money (₹1,00,000 start). These are LEARNING trades that run the full decision flow to build a prospective track record — not advice and not real fills.",
    };
  }
}

/** First exit (stop / target / time) for a filled position, scanning bars from
 *  the session AFTER entry up to maxHold or the current date. PURE-ish helper. */
function resolveExit(bars: Bar[], entryDate: string, stop: number, target: number, maxHold: number, today: string): { price: number; date: string; reason: string } | null {
  const startIdx = bars.findIndex((b) => b.date > entryDate);
  if (startIdx < 0) return null;
  const end = Math.min(startIdx + maxHold - 1, bars.length - 1);
  for (let i = startIdx; i <= end; i++) {
    const b = bars[i];
    if (b.date > today) break;
    if (b.low <= stop) return { price: stop, date: b.date, reason: "STOP" };
    if (b.high >= target) return { price: target, date: b.date, reason: "TARGET" };
  }
  // Time exit only once the hold window has fully elapsed in the past.
  if (end < bars.length - 1 || (bars[end] && bars[end].date <= today && end - startIdx + 1 >= maxHold)) {
    const b = bars[end];
    if (b && b.date <= today && end - startIdx + 1 >= maxHold) return { price: b.close, date: b.date, reason: "TIME" };
  }
  return null;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;
const round4 = (x: number): number => Math.round(x * 10000) / 10000;

export const paperTradingService = new PaperTradingService();
