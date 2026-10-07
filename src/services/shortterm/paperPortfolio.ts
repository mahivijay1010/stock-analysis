/**
 * Paper portfolio decision engine (paper-portfolio-v1) — PURE.
 *
 * This is the integration that has never run: it composes the whole risk stack
 * — circuit breaker, regime gates, fractional Kelly sizing and portfolio limits
 * — into ACTUAL order decisions against a capital account, then into an equity
 * curve. It is the difference between "the system says" and "the system did".
 *
 * Honest framing it must carry: the live gate almost never produces a BUY-grade
 * pick (by design), so a pilot that waits for one waits forever and learns
 * nothing. The paper pilot therefore trades the BEST AVAILABLE picks — highest
 * conviction, valid geometry, every risk control applied — EXPLICITLY to
 * generate the prospective track record the safety layers are starving for.
 * These are learning trades on fake money, never a claim that the picks are good.
 */

import { regimeGateFor, setupAllowedInRegime } from "./regimeGates";
import { fractionalKellyRiskPct } from "./fractionalKelly";
import { canAddPosition, PortfolioPosition, RiskLimits, DEFAULT_RISK_LIMITS } from "./portfolioRisk";

export const PAPER_PORTFOLIO_VERSION = "paper-portfolio-v1";

export interface PaperCandidate {
  ticker: string;
  sector: string | null;
  setupType: string;
  entry: number; // intended entry (zone high / trigger)
  stop: number;
  target1: number;
  rewardToRisk: number;
  pWin: number | null; // calibrated win prob (null ⇒ fixed-risk sizing)
  convictionScore: number;
  tradeabilityBlocked: boolean;
  /** Daily returns for the portfolio correlation/limit checks. */
  returns: number[];
}

export interface OpenPosition {
  ticker: string;
  sector: string | null;
  qty: number;
  entryPrice: number;
  valueInr: number;
  returns: number[];
}

export interface PaperConfig {
  maxRiskPctPerTrade: number; // hard ceiling, e.g. 1
  fixedRiskPct: number; // used when pWin is null
  maxOpenPositions: number; // e.g. 8
  minConvictionToAct: number; // base bar before the regime bump
  limits: RiskLimits;
}

export const DEFAULT_PAPER_CONFIG: PaperConfig = {
  maxRiskPctPerTrade: 1,
  fixedRiskPct: 0.5,
  maxOpenPositions: 8,
  minConvictionToAct: 30,
  limits: DEFAULT_RISK_LIMITS,
};

export interface IntendedOrder {
  ticker: string;
  sector: string | null;
  qty: number;
  entryPrice: number;
  stop: number;
  target: number;
  riskInr: number;
  riskPct: number;
  capitalInr: number; // qty × entry
  sizingBasis: string;
  convictionScore: number;
  reasons: string[];
}

export interface RejectedCandidate {
  ticker: string;
  reasons: string[];
}

export interface OrderPlan {
  version: string;
  breakerBlocked: boolean;
  regime: string | null;
  regimeSizeMultiplier: number;
  orders: IntendedOrder[];
  rejected: RejectedCandidate[];
  notes: string[];
}

/**
 * Decide which paper orders to place. Applies, in order: circuit breaker →
 * regime (size + allowed setups, CRISIS = off) → per-candidate geometry /
 * tradeability / conviction → Kelly-or-fixed sizing × regime multiplier →
 * affordability → PORTFOLIO limits (single-stock / sector / CVaR / correlation).
 * PURE.
 */
export function decidePaperOrders(input: {
  cashInr: number;
  capitalInr: number;
  openPositions: OpenPosition[];
  candidates: PaperCandidate[];
  regime: string | null;
  breakerCanEnter: boolean;
  config?: Partial<PaperConfig>;
}): OrderPlan {
  const cfg: PaperConfig = { ...DEFAULT_PAPER_CONFIG, ...input.config, limits: { ...DEFAULT_RISK_LIMITS, ...(input.config?.limits ?? {}) } };
  const gate = regimeGateFor(input.regime);
  const notes: string[] = [];
  const orders: IntendedOrder[] = [];
  const rejected: RejectedCandidate[] = [];

  if (!input.breakerCanEnter) {
    return { version: PAPER_PORTFOLIO_VERSION, breakerBlocked: true, regime: input.regime ?? null, regimeSizeMultiplier: gate.sizeMultiplier, orders: [], rejected: input.candidates.map((c) => ({ ticker: c.ticker, reasons: ["circuit breaker: new entries paused"] })), notes: ["Circuit breaker is blocking all new entries."] };
  }
  if (gate.sizeMultiplier <= 0) {
    return { version: PAPER_PORTFOLIO_VERSION, breakerBlocked: false, regime: input.regime ?? null, regimeSizeMultiplier: 0, orders: [], rejected: input.candidates.map((c) => ({ ticker: c.ticker, reasons: [`regime ${input.regime}: new entries off (${gate.note})`] })), notes: [gate.note] };
  }

  // Running book the limit checks see as we add orders.
  const book: PortfolioPosition[] = input.openPositions.map((p) => ({ ticker: p.ticker, sector: p.sector, valueInr: p.valueInr, beta: null, returns: p.returns }));
  let cash = input.cashInr;
  let openCount = input.openPositions.length;
  const minConviction = cfg.minConvictionToAct + gate.convictionBump;

  for (const c of [...input.candidates].sort((a, b) => b.convictionScore - a.convictionScore)) {
    const why: string[] = [];
    if (c.tradeabilityBlocked) {
      rejected.push({ ticker: c.ticker, reasons: ["not tradeable (surveillance/illiquid/circuit)"] });
      continue;
    }
    if (!(c.stop < c.entry && c.target1 > c.entry)) {
      rejected.push({ ticker: c.ticker, reasons: ["invalid geometry (need stop < entry < target)"] });
      continue;
    }
    if (c.convictionScore < minConviction) {
      rejected.push({ ticker: c.ticker, reasons: [`conviction ${c.convictionScore} < ${minConviction} required in this regime`] });
      continue;
    }
    if (!setupAllowedInRegime(c.setupType, gate.allowedSetups)) {
      rejected.push({ ticker: c.ticker, reasons: [`setup ${c.setupType} not allowed in ${input.regime} (${gate.allowedSetups})`] });
      continue;
    }
    if (openCount >= cfg.maxOpenPositions) {
      rejected.push({ ticker: c.ticker, reasons: [`max open positions (${cfg.maxOpenPositions}) reached`] });
      continue;
    }

    // Size: fractional Kelly (falls back to fixed risk when pWin is null) × regime multiplier.
    const kelly = fractionalKellyRiskPct({ rewardToRisk: c.rewardToRisk, pWin: c.pWin, maxRiskPct: cfg.maxRiskPctPerTrade, fixedRiskPct: cfg.fixedRiskPct });
    const riskPct = Math.round(kelly.riskPct * gate.sizeMultiplier * 100) / 100;
    if (riskPct <= 0) {
      rejected.push({ ticker: c.ticker, reasons: [kelly.basis] });
      continue;
    }
    const riskInr = (input.capitalInr * riskPct) / 100;
    const perShareRisk = c.entry - c.stop;
    let qty = Math.floor(riskInr / perShareRisk);
    // Affordability against remaining cash.
    qty = Math.min(qty, Math.floor(cash / c.entry));
    if (qty <= 0) {
      rejected.push({ ticker: c.ticker, reasons: ["unaffordable at this risk/cash — cannot size one share"] });
      continue;
    }
    const valueInr = qty * c.entry;

    // Portfolio limits: would adding this breach single-stock/sector/CVaR/correlation?
    const add = canAddPosition({ current: book, candidate: { ticker: c.ticker, sector: c.sector, valueInr, beta: null, returns: c.returns }, capitalInr: input.capitalInr, limits: cfg.limits });
    if (!add.ok) {
      rejected.push({ ticker: c.ticker, reasons: add.reasons });
      continue;
    }

    why.push(`sized ${kelly.usedCalibratedP ? "by Kelly" : "at fixed risk"} ${riskPct}% × regime ${gate.sizeMultiplier}`);
    why.push(`conviction ${c.convictionScore}, reward:risk ${c.rewardToRisk.toFixed(2)}`);
    orders.push({
      ticker: c.ticker,
      sector: c.sector,
      qty,
      entryPrice: c.entry,
      stop: c.stop,
      target: c.target1,
      riskInr: Math.round(qty * perShareRisk),
      riskPct,
      capitalInr: Math.round(valueInr),
      sizingBasis: kelly.basis,
      convictionScore: c.convictionScore,
      reasons: why,
    });
    book.push({ ticker: c.ticker, sector: c.sector, valueInr, beta: null, returns: c.returns });
    cash -= valueInr;
    openCount++;
  }

  notes.push(`Paper pilot: ${orders.length} order(s) from ${input.candidates.length} candidate(s); regime ${input.regime} (size ×${gate.sizeMultiplier}).`);
  notes.push("These are LEARNING trades on fake money to build a prospective track record — not a claim the picks are good.");
  return { version: PAPER_PORTFOLIO_VERSION, breakerBlocked: false, regime: input.regime ?? null, regimeSizeMultiplier: gate.sizeMultiplier, orders, rejected, notes };
}

// ── Account accounting ───────────────────────────────────────────────────────

export interface EquityPoint {
  deployedInr: number;
  cashInr: number;
  equityInr: number;
  openPositions: number;
  unrealizedPnlInr: number;
}

/** Mark the book to market at the given prices. PURE. */
export function markToMarket(openPositions: OpenPosition[], prices: Map<string, number>, cashInr: number): EquityPoint {
  let deployed = 0;
  let unrealized = 0;
  for (const p of openPositions) {
    const px = prices.get(p.ticker) ?? p.entryPrice;
    const mv = p.qty * px;
    deployed += mv;
    unrealized += mv - p.qty * p.entryPrice;
  }
  return {
    deployedInr: Math.round(deployed),
    cashInr: Math.round(cashInr),
    equityInr: Math.round(cashInr + deployed),
    openPositions: openPositions.length,
    unrealizedPnlInr: Math.round(unrealized),
  };
}

/** Intended-vs-filled slippage on an entry, in basis points. PURE. */
export function fillSlippageBps(intendedPrice: number, filledPrice: number): number {
  if (!(intendedPrice > 0)) return 0;
  return Math.round(((filledPrice - intendedPrice) / intendedPrice) * 10000);
}
