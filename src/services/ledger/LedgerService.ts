/**
 * LedgerService (Phase B2) — the product transaction ledger (spec §3/§4/§11).
 *
 * Rules enforced here:
 *  - Transactions are immutable: no update/delete paths exist. Corrections are
 *    reversal rows (corrects_id), originals untouched.
 *  - All money math goes through src/services/money (decimal.js). NUMERIC
 *    columns are read as strings; nothing is parseFloat'd for arithmetic.
 *  - SELLs run transactional FIFO with row locks: concurrent sells serialize
 *    on the instrument's BUY rows; an oversell rolls back atomically (nothing
 *    persisted). Allocations are stored, never recomputed (plan §2).
 *  - Contradictory qty/price/gross combinations are rejected (spec §3).
 *  - The day's closing price is substituted for an unknown execution price
 *    ONLY on explicit confirmation (useClosingPriceEstimate) and the row is
 *    labeled is_estimated_price (spec §3).
 *  - Backdating is allowed (trade_date ≤ today IST) and NEVER creates
 *    forecast rows — nothing in this service touches prediction/forecast
 *    tables (spec §13.5).
 *  - Fees are never double-subtracted: purchase charges live in lot basis,
 *    sale charges inside net proceeds; liquidation charges are ESTIMATES
 *    computed only in the liquidation scenario field (spec §4).
 *
 * Not a tax filing engine: FIFO cost allocation for product P&L only.
 */
import { DataSource, In, QueryRunner, Repository } from "typeorm";
import { AppDataSource } from "../../config/database";
import { Instrument } from "../../entities/Instrument";
import { InstrumentAlias } from "../../entities/InstrumentAlias";
import { LedgerTransaction, LedgerTransactionType } from "../../entities/LedgerTransaction";
import { LedgerLotAllocation } from "../../entities/LedgerLotAllocation";
import { HttpError } from "../../types";
import {
  add,
  allocateByWeights,
  div,
  eq,
  money,
  Money,
  mul,
  sub,
  toDbString,
  toDisplayString,
  ZERO,
} from "../money";
import { sellFifo } from "../money";
import {
  effectiveTxns,
  correctedIds,
  LedgerIntegrityError,
  replayLedger,
  ReplayAllocation,
  ReplayTxn,
  InstrumentState,
} from "./replay";
import { estimateSellFees } from "../framework/fees";

// ── Input / output contracts ────────────────────────────────────────────────

export interface RecordTransactionInput {
  type: LedgerTransactionType;
  /** One of ticker (yahoo symbol or known alias) or instrumentId. */
  ticker?: string;
  instrumentId?: string;
  /** Executed date YYYY-MM-DD (IST product date); ≤ today; backdating allowed. */
  tradeDate: string;
  qty?: number | string;
  price?: number | string;
  grossAmount?: number | string;
  charges?: number | string;
  /**
   * Explicit user confirmation to substitute the trade_date's closing price
   * for an unknown execution price. The row is stored is_estimated_price.
   */
  useClosingPriceEstimate?: boolean;
  /** SPLIT/BONUS ratio, e.g. 2-for-1 split → numerator 2, denominator 1. */
  ratioNumerator?: number;
  ratioDenominator?: number;
  note?: string;
  idempotencyKey?: string;
}

export interface TxnView {
  id: string;
  instrumentId: string;
  ticker: string | null;
  type: LedgerTransactionType;
  tradeDate: string;
  qty: string | null;
  price: string | null;
  grossAmount: string | null;
  charges: string;
  isEstimatedPrice: boolean;
  note: string | null;
  correctsId: string | null;
  correctedBy: string | null;
  idempotencyKey: string | null;
  createdAt: string;
}

export interface RecordResult {
  transaction: TxnView;
  /** True when the idempotency key matched an existing row — nothing written. */
  duplicate: boolean;
  /** SELL only: the stored FIFO allocation audit trail. */
  allocations?: Array<{
    buyTxnId: string;
    qty: string;
    allocatedCost: string;
    realizedPnl: string;
  }>;
  /** SELL only: exact totals for this sale. */
  sale?: {
    grossProceeds: string;
    charges: string;
    netProceeds: string;
    allocatedCostBasis: string;
    realizedPnl: string;
  };
}

export interface PriceObservation {
  current: number;
  asOf: string;
  marketState: string | null;
  source: string;
}

export type PriceLookup = (yahooTicker: string) => Promise<PriceObservation | null>;

export interface PositionView {
  instrumentId: string;
  ticker: string;
  name: string;
  status: "OPEN" | "CLOSED";
  qty: number;
  /** Remaining cost basis B incl. allocated purchase charges (display / exact). */
  costBasis: string;
  costBasisExact: string;
  avgCostPerShare: string | null;
  /** Observed price with explicit freshness; null when provider unavailable. */
  price: {
    status: "AVAILABLE" | "UNAVAILABLE";
    current: number | null;
    asOf: string | null;
    marketState: string | null;
    source: string | null;
  };
  /** q × current observed price (gross marked value); null without a price. */
  markedValue: string | null;
  /** marked value − B. Gross: no sale charges subtracted here. */
  unrealizedGrossPnl: string | null;
  /** ESTIMATED liquidation-scenario sale charges (fee model, estimate only). */
  estimatedSellCharges: string | null;
  /** marked value − estimated sale charges − B. Estimate, NOT realized. */
  estimatedNetLiquidationPnl: string | null;
  /** Σ stored realized_pnl from lot_allocations of effective sells. Actual. */
  realizedPnl: string;
  /** Σ dividend cash net of dividend charges — separate from cost basis. */
  dividendsNet: string;
  /** Σ signed CHARGE_ADJUST rows — separate, never inside lot basis. */
  chargeAdjustments: string;
  openLots: Array<{
    buyTxnId: string;
    tradeDate: string;
    qty: number;
    costBasis: string;
    perShareBasis: string;
  }>;
}

export interface HoldingsResponse {
  asOf: string;
  positions: PositionView[];
  totals: {
    /** Σ remaining cost basis over open positions. */
    costBasis: string;
    /** Σ marked value over positions with an available price. */
    markedValue: string;
    /** Marked totals cover only priced positions; count of unpriced ones. */
    unpricedPositions: number;
    unrealizedGrossPnl: string;
    realizedPnl: string;
    dividendsNet: string;
    chargeAdjustments: string;
  };
  notes: string[];
}

export interface ImportRowResult {
  row: number;
  idempotencyKey: string | null;
  status: "valid" | "imported" | "skipped-duplicate" | "invalid" | "failed";
  error?: string;
}

export interface ImportReport {
  dryRun: boolean;
  totalRows: number;
  results: ImportRowResult[];
  summary: { valid?: number; imported?: number; skippedDuplicate: number; failed: number };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD today in Asia/Kolkata (product dates are IST, spec §5). */
export function istTodayString(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function asMoneyOrNull(v: number | string | undefined | null): Money | null {
  if (v === undefined || v === null || v === "") return null;
  const s = typeof v === "number" ? String(v) : v.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new HttpError(400, `"${v}" is not a valid decimal amount.`);
  return money(s);
}

function positiveIntOrThrow(v: number | string | undefined, what: string): number {
  const n = typeof v === "string" ? Number(v) : v;
  if (n === undefined || !Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new HttpError(400, `"${what}" must be a positive whole number of shares (got ${v}). Fractional entitlements need explicit corporate-action handling.`);
  }
  return n;
}

interface NormalizedTxn {
  type: LedgerTransactionType;
  tradeDate: string;
  qty: string | null;
  price: string | null;
  grossAmount: string | null;
  charges: string;
  isEstimatedPrice: boolean;
  note: string | null;
  idempotencyKey: string | null;
  /** For SELL FIFO: integral share count. */
  qtyInt?: number;
  grossMoney?: Money;
  chargesMoney?: Money;
}

// ── Service ─────────────────────────────────────────────────────────────────

export class LedgerService {
  constructor(
    private readonly ds: DataSource = AppDataSource,
    private readonly closeLookup?: (ticker: string, onOrBefore: string) => Promise<{ close: number; date: string } | null>
  ) {}

  private get txnRepo(): Repository<LedgerTransaction> {
    return this.ds.getRepository(LedgerTransaction);
  }

  // ── Instrument identity ──────────────────────────────────────────────────

  /**
   * Resolve a canonical instrument by id, yahoo ticker or effective-dated
   * alias. Unknown symbols 404 honestly (supported universe = the seeded
   * instruments table, not "all NSE"). Never auto-creates identity rows.
   */
  async resolveInstrument(ref: { instrumentId?: string; ticker?: string }): Promise<Instrument> {
    const repo = this.ds.getRepository(Instrument);
    if (ref.instrumentId) {
      const byId = await repo.findOne({ where: { id: ref.instrumentId } });
      if (byId) return byId;
      throw new HttpError(404, `No instrument with id ${ref.instrumentId}.`);
    }
    const raw = (ref.ticker ?? "").trim().toUpperCase();
    if (!raw) throw new HttpError(400, 'Provide "ticker" (e.g. "RELIANCE.NS") or "instrumentId".');
    const candidates = raw.includes(".") ? [raw] : [raw, `${raw}.NS`];
    const direct = await repo.findOne({ where: { yahooTicker: In(candidates) } });
    if (direct) return direct;
    const alias = await this.ds
      .getRepository(InstrumentAlias)
      .findOne({ where: { alias: In(candidates) } });
    if (alias) {
      const inst = await repo.findOne({ where: { id: alias.instrumentId } });
      if (inst) return inst;
    }
    throw new HttpError(
      404,
      `"${raw}" is not in the supported instrument universe (${await repo.count()} NSE instruments seeded). ` +
        `Unrelated instruments are never merged; renames resolve via recorded aliases only.`
    );
  }

  // ── Validation / normalization (pure per-row checks) ────────────────────

  private async normalize(input: RecordTransactionInput, instrument: Instrument): Promise<NormalizedTxn> {
    const type = input.type;
    const allowed: LedgerTransactionType[] = ["BUY", "SELL", "DIVIDEND", "SPLIT", "BONUS", "CHARGE_ADJUST"];
    if (!allowed.includes(type)) {
      throw new HttpError(400, `"type" must be one of ${allowed.join(", ")}.`);
    }
    const tradeDate = (input.tradeDate ?? "").trim();
    if (!DATE_RE.test(tradeDate) || Number.isNaN(new Date(`${tradeDate}T00:00:00Z`).getTime())) {
      throw new HttpError(400, '"tradeDate" must be YYYY-MM-DD.');
    }
    const today = istTodayString();
    if (tradeDate > today) {
      throw new HttpError(400, `"tradeDate" ${tradeDate} is in the future (today IST: ${today}). Forecast-dated transactions are not allowed.`);
    }
    const chargesMoney = asMoneyOrNull(input.charges) ?? ZERO;
    if (chargesMoney.isNegative()) throw new HttpError(400, '"charges" must be ≥ 0 (use CHARGE_ADJUST for signed adjustments).');
    const note = input.note ? String(input.note).slice(0, 2000) : null;
    const idempotencyKey = input.idempotencyKey ? String(input.idempotencyKey).slice(0, 120) : null;

    const base: NormalizedTxn = {
      type,
      tradeDate,
      qty: null,
      price: null,
      grossAmount: null,
      charges: toDbString(chargesMoney),
      isEstimatedPrice: false,
      note,
      idempotencyKey,
      chargesMoney,
    };

    if (type === "BUY" || type === "SELL") {
      const qtyInt = positiveIntOrThrow(input.qty, "qty");
      let price = asMoneyOrNull(input.price);
      let gross = asMoneyOrNull(input.grossAmount);
      let isEstimated = false;

      if (price && (price.isNegative() || price.isZero())) throw new HttpError(400, '"price" must be > 0.');
      if (gross && (gross.isNegative() || gross.isZero())) throw new HttpError(400, '"grossAmount" must be > 0.');

      if (price && gross) {
        // Reject contradictions — derived values must agree exactly (spec §3).
        if (!eq(mul(qtyInt, price), gross)) {
          throw new HttpError(
            400,
            `Contradictory inputs: qty ${qtyInt} × price ${toDbString(price)} = ${toDbString(mul(qtyInt, price))}, ` +
              `but grossAmount ${toDbString(gross)} was given. Fix one of them.`
          );
        }
      } else if (price && !gross) {
        gross = mul(qtyInt, price);
      } else if (!price && gross) {
        price = div(gross, qtyInt); // derived for display; gross stays authoritative
      } else {
        if (!input.useClosingPriceEstimate) {
          throw new HttpError(
            400,
            'Provide "price" or "grossAmount". If the execution price is unknown you may explicitly set ' +
              '"useClosingPriceEstimate": true to use the trade date\'s closing price — the transaction will be labeled an estimated input.'
          );
        }
        if (!this.closeLookup) {
          throw new HttpError(503, "Closing-price lookup is not available in this context.");
        }
        const bar = await this.closeLookup(instrument.yahooTicker, tradeDate);
        if (!bar) {
          throw new HttpError(
            422,
            `No closing price available for ${instrument.yahooTicker} on or before ${tradeDate} — cannot estimate. Enter the price manually.`
          );
        }
        price = money(String(bar.close));
        gross = mul(qtyInt, price);
        isEstimated = true;
        base.note = note ? `${note} [estimated price: ${bar.date} close]` : `Estimated price: ${bar.date} close used on explicit confirmation.`;
      }

      base.qty = toDbString(money(qtyInt));
      base.price = toDbString(price!);
      base.grossAmount = toDbString(gross!);
      base.isEstimatedPrice = isEstimated || input.useClosingPriceEstimate === true;
      base.qtyInt = qtyInt;
      base.grossMoney = gross!;
      return base;
    }

    if (type === "DIVIDEND") {
      let gross = asMoneyOrNull(input.grossAmount);
      const qty = input.qty !== undefined ? positiveIntOrThrow(input.qty, "qty") : null;
      const perShare = asMoneyOrNull(input.price);
      if (!gross && qty && perShare) gross = mul(qty, perShare);
      if (!gross || gross.isNegative() || gross.isZero()) {
        throw new HttpError(400, 'DIVIDEND needs "grossAmount" (total cash received) or qty × price (per-share amount), > 0.');
      }
      if (qty && perShare && input.grossAmount !== undefined && !eq(mul(qty, perShare), gross)) {
        throw new HttpError(400, "Contradictory dividend inputs: qty × price ≠ grossAmount.");
      }
      base.qty = qty !== null ? toDbString(money(qty)) : null;
      base.price = perShare ? toDbString(perShare) : null;
      base.grossAmount = toDbString(gross);
      base.grossMoney = gross;
      return base;
    }

    if (type === "SPLIT" || type === "BONUS") {
      const numerator = positiveIntOrThrow(input.ratioNumerator, "ratioNumerator");
      const denominator = positiveIntOrThrow(input.ratioDenominator, "ratioDenominator");
      // Stored convention (documented on the entity): qty = numerator, price = denominator.
      base.qty = toDbString(money(numerator));
      base.price = toDbString(money(denominator));
      return base;
    }

    // CHARGE_ADJUST
    const amount = asMoneyOrNull(input.grossAmount);
    if (!amount || amount.isZero()) {
      throw new HttpError(400, 'CHARGE_ADJUST needs a non-zero signed "grossAmount" (₹; positive = extra cost, negative = refund).');
    }
    base.grossAmount = toDbString(amount);
    return base;
  }

  // ── Core write path ──────────────────────────────────────────────────────

  async recordTransaction(accountId: string, input: RecordTransactionInput): Promise<RecordResult> {
    const instrument = await this.resolveInstrument(input);
    const normalized = await this.normalize(input, instrument);

    const runner = this.ds.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const result = await this.recordWithRunner(runner, accountId, instrument, normalized);
      await runner.commitTransaction();
      return result;
    } catch (err) {
      await runner.rollbackTransaction(); // oversell / contradiction → atomic: nothing persisted
      throw err;
    } finally {
      await runner.release();
    }
  }

  private async recordWithRunner(
    runner: QueryRunner,
    accountId: string,
    instrument: Instrument,
    n: NormalizedTxn
  ): Promise<RecordResult> {
    const repo = runner.manager.getRepository(LedgerTransaction);
    const allocRepo = runner.manager.getRepository(LedgerLotAllocation);

    // Idempotency: replaying the same key returns the original row, writes nothing.
    if (n.idempotencyKey) {
      const existing = await repo.findOne({ where: { idempotencyKey: n.idempotencyKey } });
      if (existing) {
        if (existing.accountId !== accountId) {
          throw new HttpError(409, "Idempotency key already used by a different account.");
        }
        return { transaction: await this.toView(existing, instrument.yahooTicker, null), duplicate: true };
      }
    }

    // Serialize concurrent writers per (account, instrument): every mutating
    // path locks the instrument's existing ledger rows FOR UPDATE first, so
    // two concurrent sells cannot both read the same open lots.
    await runner.query(
      `SELECT id FROM ledger_transactions WHERE account_id = $1 AND instrument_id = $2 FOR UPDATE`,
      [accountId, instrument.id]
    );

    const txns = await repo.find({ where: { accountId, instrumentId: instrument.id } });
    const sellIds = txns.filter((t) => t.type === "SELL").map((t) => t.id);
    const allocations = sellIds.length > 0 ? await allocRepo.find({ where: { sellTxnId: In(sellIds) } }) : [];
    const effective = effectiveTxns(txns as ReplayTxn[]);

    // Cross-ordering guards: retroactive interleaving of sells and corporate
    // actions would silently rewrite stored FIFO math — reject honestly.
    if (n.type === "SELL") {
      const laterCa = effective.find((t) => (t.type === "SPLIT" || t.type === "BONUS") && t.tradeDate > n.tradeDate);
      if (laterCa) {
        throw new HttpError(
          400,
          `A ${laterCa.type} dated ${laterCa.tradeDate} exists after ${n.tradeDate}. Backdating a sell across a corporate action would corrupt stored lot math — correct the corporate action first or use its post-action date.`
        );
      }
    }
    if (n.type === "SPLIT" || n.type === "BONUS") {
      const laterSell = effective.find((t) => t.type === "SELL" && t.tradeDate >= n.tradeDate);
      if (laterSell) {
        throw new HttpError(
          400,
          `A SELL dated ${laterSell.tradeDate} exists on/after ${n.tradeDate}. Recording a corporate action behind it would retroactively change its stored FIFO allocations — correct the sell first.`
        );
      }
    }

    const bySell = new Map<string, ReplayAllocation[]>();
    for (const a of allocations) {
      const list = bySell.get(a.sellTxnId) ?? [];
      list.push(a);
      bySell.set(a.sellTxnId, list);
    }
    const state = replayLedgerSafe(effective, allocations);

    let saved: LedgerTransaction;
    let allocationViews: RecordResult["allocations"];
    let saleTotals: RecordResult["sale"];

    if (n.type === "SELL") {
      const st = state.get(instrument.id);
      const lots = (st?.lots ?? []).filter((l) => l.buyTradeDate <= n.tradeDate);
      const available = lots.reduce((s, l) => s + l.qty, 0);
      const wanted = n.qtyInt!;
      if (wanted > available) {
        throw new HttpError(
          400,
          `Oversell rejected: selling ${wanted} but only ${available} share(s) held on ${n.tradeDate} (FIFO over recorded purchases). Nothing was recorded.`
        );
      }
      // FIFO basis allocation with exact largest-remainder reconciliation.
      const fifo = sellFifo(
        lots.map((l) => ({ qty: l.qty, costBasis: l.costBasis })),
        wanted,
        n.price!, // display price; authoritative gross below
        n.chargesMoney!
      );
      const gross = n.grossMoney!; // authoritative (validated consistent with qty×price)
      const weights = fifo.allocations.map((a) => a.qtySold);
      const grossShares = allocateByWeights(gross, weights);
      const chargeShares = allocateByWeights(n.chargesMoney!, weights);

      saved = await repo.save(this.buildRow(accountId, instrument.id, n));
      const allocRows: LedgerLotAllocation[] = fifo.allocations.map((a, i) => {
        const row = new LedgerLotAllocation();
        row.sellTxnId = saved.id;
        row.buyTxnId = lots[a.lotIndex].buyTxnId;
        row.qty = toDbString(money(a.qtySold));
        row.allocatedCost = toDbString(a.costBasisAllocated);
        row.realizedPnl = toDbString(sub(sub(grossShares[i], chargeShares[i]), a.costBasisAllocated));
        return row;
      });
      await allocRepo.save(allocRows);

      allocationViews = allocRows.map((r) => ({
        buyTxnId: r.buyTxnId,
        qty: r.qty,
        allocatedCost: r.allocatedCost,
        realizedPnl: r.realizedPnl,
      }));
      const realizedTotal = allocRows.reduce((s, r) => add(s, money(r.realizedPnl)), ZERO);
      saleTotals = {
        grossProceeds: toDbString(gross),
        charges: toDbString(n.chargesMoney!),
        netProceeds: toDbString(sub(gross, n.chargesMoney!)),
        allocatedCostBasis: toDbString(fifo.allocatedCostBasis),
        realizedPnl: toDbString(realizedTotal),
      };
      // Defense in depth: the whole instrument ledger must replay cleanly.
      this.validateReplay([...txns, saved], [...allocations, ...allocRows]);
    } else {
      if ((n.type === "SPLIT" || n.type === "BONUS") && (state.get(instrument.id)?.lots.length ?? 0) === 0) {
        throw new HttpError(400, `No open lots to apply the ${n.type} to — record the purchases first.`);
      }
      saved = await repo.save(this.buildRow(accountId, instrument.id, n));
      // Replay-validate (catches e.g. fractional split entitlements, or a
      // backdated BUY that a later split would make fractional).
      this.validateReplay([...txns, saved], allocations);
    }

    return {
      transaction: await this.toView(saved, instrument.yahooTicker, null),
      duplicate: false,
      ...(allocationViews ? { allocations: allocationViews, sale: saleTotals } : {}),
    };
  }

  private buildRow(accountId: string, instrumentId: string, n: NormalizedTxn): LedgerTransaction {
    const row = new LedgerTransaction();
    row.accountId = accountId;
    row.instrumentId = instrumentId;
    row.type = n.type;
    row.tradeDate = n.tradeDate;
    row.qty = n.qty;
    row.price = n.price;
    row.grossAmount = n.grossAmount;
    row.charges = n.charges;
    row.isEstimatedPrice = n.isEstimatedPrice;
    row.note = n.note;
    row.correctsId = null;
    row.idempotencyKey = n.idempotencyKey;
    return row;
  }

  private validateReplay(txns: LedgerTransaction[], allocations: LedgerLotAllocation[]): void {
    try {
      replayLedger(txns as ReplayTxn[], allocations as ReplayAllocation[]);
    } catch (err) {
      if (err instanceof LedgerIntegrityError) {
        throw new HttpError(400, `Rejected — the ledger would become inconsistent: ${err.message}`);
      }
      throw err;
    }
  }

  // ── Corrections (reversal rows; originals immutable) ────────────────────

  async correctTransaction(accountId: string, txnId: string, note?: string): Promise<{ original: TxnView; reversal: TxnView }> {
    const runner = this.ds.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const repo = runner.manager.getRepository(LedgerTransaction);
      const allocRepo = runner.manager.getRepository(LedgerLotAllocation);

      const rows: Array<Record<string, unknown>> = await runner.query(
        `SELECT id FROM ledger_transactions WHERE id = $1 AND account_id = $2 FOR UPDATE`,
        [txnId, accountId]
      );
      if (rows.length === 0) throw new HttpError(404, "Transaction not found."); // includes other accounts' ids — no existence leak
      const original = (await repo.findOne({ where: { id: txnId, accountId } }))!;

      if (original.correctsId) throw new HttpError(400, "Reversal rows cannot themselves be corrected.");
      const already = await repo.findOne({ where: { correctsId: original.id } });
      if (already) throw new HttpError(400, `Transaction was already corrected by ${already.id}.`);

      // Serialize with sells/CAs on the same instrument.
      await runner.query(
        `SELECT id FROM ledger_transactions WHERE account_id = $1 AND instrument_id = $2 FOR UPDATE`,
        [accountId, original.instrumentId]
      );

      const txns = await repo.find({ where: { accountId, instrumentId: original.instrumentId } });
      const sellIds = txns.filter((t) => t.type === "SELL").map((t) => t.id);
      const allocations = sellIds.length > 0 ? await allocRepo.find({ where: { sellTxnId: In(sellIds) } }) : [];

      if (original.type === "BUY") {
        const voided = correctedIds(txns as ReplayTxn[]);
        const consuming = allocations.filter((a) => a.buyTxnId === original.id && !voided.has(a.sellTxnId));
        if (consuming.length > 0) {
          throw new HttpError(
            400,
            `This purchase has been (partially) consumed by ${consuming.length} sale allocation(s). Correct the dependent sell(s) first — stored allocations are never rewritten.`
          );
        }
      }

      const reversal = new LedgerTransaction();
      reversal.accountId = accountId;
      reversal.instrumentId = original.instrumentId;
      reversal.type = original.type;
      reversal.tradeDate = original.tradeDate;
      reversal.qty = original.qty;
      reversal.price = original.price;
      reversal.grossAmount = original.grossAmount;
      reversal.charges = original.charges;
      reversal.isEstimatedPrice = original.isEstimatedPrice;
      reversal.note = note ? String(note).slice(0, 2000) : `Reversal of ${original.id}`;
      reversal.correctsId = original.id;
      reversal.idempotencyKey = null;
      const savedReversal = await runner.manager.getRepository(LedgerTransaction).save(reversal);

      // Voiding must leave a consistent ledger (e.g. voiding a SELL is fine —
      // replay skips it; voiding a SPLIT under later activity is caught here).
      this.validateReplay([...txns, savedReversal], allocations);

      await runner.commitTransaction();
      const inst = await this.ds.getRepository(Instrument).findOne({ where: { id: original.instrumentId } });
      return {
        original: await this.toView(original, inst?.yahooTicker ?? null, savedReversal.id),
        reversal: await this.toView(savedReversal, inst?.yahooTicker ?? null, null),
      };
    } catch (err) {
      await runner.rollbackTransaction();
      throw err;
    } finally {
      await runner.release();
    }
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  async listTransactions(
    accountId: string,
    opts: { ticker?: string; limit?: number; offset?: number } = {}
  ): Promise<{ transactions: TxnView[]; total: number }> {
    const where: Record<string, unknown> = { accountId };
    if (opts.ticker) {
      const inst = await this.resolveInstrument({ ticker: opts.ticker });
      where.instrumentId = inst.id;
    }
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const offset = Math.max(opts.offset ?? 0, 0);
    const [rows, total] = await this.txnRepo.findAndCount({
      where,
      order: { tradeDate: "DESC", createdAt: "DESC" },
      take: limit,
      skip: offset,
    });
    const all = await this.txnRepo.find({ where: { accountId }, select: ["id", "correctsId"] });
    const reversalByOriginal = new Map<string, string>();
    for (const t of all) if (t.correctsId) reversalByOriginal.set(t.correctsId, t.id);
    const instruments = await this.ds.getRepository(Instrument).find({
      where: { id: In([...new Set(rows.map((r) => r.instrumentId))]) },
    });
    const tickerById = new Map(instruments.map((i) => [i.id, i.yahooTicker]));
    return {
      transactions: await Promise.all(
        rows.map((r) => this.toView(r, tickerById.get(r.instrumentId) ?? null, reversalByOriginal.get(r.id) ?? null))
      ),
      total,
    };
  }

  /** Derived positions per spec §4 — replay, then mark with observed prices. */
  async getPositions(accountId: string, priceLookup?: PriceLookup): Promise<HoldingsResponse> {
    const txns = await this.txnRepo.find({ where: { accountId } });
    const sellIds = txns.filter((t) => t.type === "SELL").map((t) => t.id);
    const allocations =
      sellIds.length > 0
        ? await this.ds.getRepository(LedgerLotAllocation).find({ where: { sellTxnId: In(sellIds) } })
        : [];
    const states = replayLedger(txns as ReplayTxn[], allocations as ReplayAllocation[]);

    const instruments = await this.ds.getRepository(Instrument).find({
      where: { id: In([...states.keys()].length > 0 ? [...states.keys()] : ["00000000-0000-0000-0000-000000000000"]) },
    });
    const instById = new Map(instruments.map((i) => [i.id, i]));

    const positions: PositionView[] = [];
    let totBasis = ZERO;
    let totMarked = ZERO;
    let totUnrealized = ZERO;
    let totRealized = ZERO;
    let totDividends = ZERO;
    let totAdjust = ZERO;
    let unpriced = 0;

    for (const [instrumentId, st] of states) {
      const inst = instById.get(instrumentId);
      const qty = st.lots.reduce((s, l) => s + l.qty, 0);
      const basis = st.lots.reduce((s, l) => add(s, l.costBasis), ZERO);

      let price: PositionView["price"] = { status: "UNAVAILABLE", current: null, asOf: null, marketState: null, source: null };
      if (qty > 0 && priceLookup && inst) {
        try {
          const obs = await priceLookup(inst.yahooTicker);
          if (obs) price = { status: "AVAILABLE", current: obs.current, asOf: obs.asOf, marketState: obs.marketState, source: obs.source };
        } catch {
          // honest degrade — no invented prices (spec §13.15)
        }
      }

      let marked: Money | null = null;
      let unrealized: Money | null = null;
      let estCharges: Money | null = null;
      let estNet: Money | null = null;
      if (qty > 0 && price.status === "AVAILABLE" && price.current !== null) {
        marked = mul(qty, money(String(price.current)));
        unrealized = sub(marked, basis);
        // Liquidation-scenario estimate ONLY (spec §4): fee model is an
        // effective-dated approximation, never mixed into gross P&L.
        estCharges = money(String(estimateSellFees(Number(toDbString(marked)))));
        estNet = sub(sub(marked, estCharges), basis);
        totMarked = add(totMarked, marked);
        totUnrealized = add(totUnrealized, unrealized);
      } else if (qty > 0) {
        unpriced += 1;
      }
      totBasis = add(totBasis, basis);
      totRealized = add(totRealized, st.realizedPnl);
      totDividends = add(totDividends, st.dividendsNet);
      totAdjust = add(totAdjust, st.chargeAdjustments);

      positions.push({
        instrumentId,
        ticker: inst?.yahooTicker ?? "(unknown)",
        name: inst?.name ?? "(unknown)",
        status: qty > 0 ? "OPEN" : "CLOSED",
        qty,
        costBasis: toDisplayString(basis),
        costBasisExact: toDbString(basis),
        avgCostPerShare: qty > 0 ? toDisplayString(div(basis, qty)) : null,
        price,
        markedValue: marked ? toDisplayString(marked) : null,
        unrealizedGrossPnl: unrealized ? toDisplayString(unrealized) : null,
        estimatedSellCharges: estCharges ? toDisplayString(estCharges) : null,
        estimatedNetLiquidationPnl: estNet ? toDisplayString(estNet) : null,
        realizedPnl: toDisplayString(st.realizedPnl),
        dividendsNet: toDisplayString(st.dividendsNet),
        chargeAdjustments: toDisplayString(st.chargeAdjustments),
        openLots: st.lots.map((l) => ({
          buyTxnId: l.buyTxnId,
          tradeDate: l.buyTradeDate,
          qty: l.qty,
          costBasis: toDisplayString(l.costBasis),
          perShareBasis: toDisplayString(div(l.costBasis, l.qty)),
        })),
      });
    }

    positions.sort((a, b) => (a.status === b.status ? a.ticker.localeCompare(b.ticker) : a.status === "OPEN" ? -1 : 1));

    return {
      asOf: new Date().toISOString(),
      positions,
      totals: {
        costBasis: toDisplayString(totBasis),
        markedValue: toDisplayString(totMarked),
        unpricedPositions: unpriced,
        unrealizedGrossPnl: toDisplayString(totUnrealized),
        realizedPnl: toDisplayString(totRealized),
        dividendsNet: toDisplayString(totDividends),
        chargeAdjustments: toDisplayString(totAdjust),
      },
      notes: [
        "Positions are derived by replaying the immutable transaction ledger (FIFO, stored allocations).",
        "unrealizedGrossPnl = qty × observed price − cost basis (basis includes purchase charges; no sale charges subtracted).",
        "estimatedNetLiquidationPnl subtracts ESTIMATED sale charges (delivery fee model) once — an estimate, not realized profit.",
        "realizedPnl counts only executed sells (net proceeds − allocated cost basis). Dividends are reported separately and are not in cost basis.",
        "Marked totals cover only positions with an available observed price.",
      ],
    };
  }

  // ── CSV export / import ──────────────────────────────────────────────────

  /** CSV export — text cells are guarded against spreadsheet formula injection. */
  async exportCsv(accountId: string): Promise<string> {
    const txns = await this.txnRepo.find({ where: { accountId }, order: { tradeDate: "ASC", createdAt: "ASC" } });
    const instruments = await this.ds.getRepository(Instrument).find({
      where: { id: In([...new Set(txns.map((t) => t.instrumentId))].length > 0 ? [...new Set(txns.map((t) => t.instrumentId))] : ["00000000-0000-0000-0000-000000000000"]) },
    });
    const tickerById = new Map(instruments.map((i) => [i.id, i.yahooTicker]));
    const header = [
      "id", "ticker", "type", "trade_date", "qty", "price", "gross_amount", "charges",
      "is_estimated_price", "note", "corrects_id", "idempotency_key", "created_at",
    ];
    const lines = [header.join(",")];
    for (const t of txns) {
      lines.push(
        [
          csvCell(t.id),
          csvCell(tickerById.get(t.instrumentId) ?? "", true),
          csvCell(t.type, true),
          csvCell(t.tradeDate),
          csvCell(t.qty ?? ""),
          csvCell(t.price ?? ""),
          csvCell(t.grossAmount ?? ""),
          csvCell(t.charges),
          csvCell(String(t.isEstimatedPrice)),
          csvCell(t.note ?? "", true),
          csvCell(t.correctsId ?? ""),
          csvCell(t.idempotencyKey ?? "", true),
          csvCell(new Date(t.createdAt).toISOString()),
        ].join(",")
      );
    }
    return lines.join("\r\n") + "\r\n";
  }

  /**
   * Import rows. dryRun validates everything (shape, instrument resolution,
   * duplicate keys, FIFO availability via simulation) WITHOUT writing.
   * A real run applies rows sequentially, each in its own transaction; every
   * row REQUIRES an idempotency key so a partial import can be replayed
   * safely (already-imported rows are skipped, not duplicated).
   */
  async importRows(accountId: string, rows: RecordTransactionInput[], dryRun: boolean): Promise<ImportReport> {
    if (!Array.isArray(rows) || rows.length === 0) throw new HttpError(400, '"rows" must be a non-empty array.');
    if (rows.length > 1000) throw new HttpError(400, "At most 1000 rows per import.");

    const results: ImportRowResult[] = [];
    const seenKeys = new Set<string>();

    if (!dryRun) {
      for (let i = 0; i < rows.length; i++) {
        const key = rows[i]?.idempotencyKey ? String(rows[i].idempotencyKey) : null;
        try {
          if (!key) throw new HttpError(400, "Every import row needs an idempotencyKey.");
          if (seenKeys.has(key)) throw new HttpError(400, `Duplicate idempotencyKey "${key}" inside this batch.`);
          seenKeys.add(key);
          const r = await this.recordTransaction(accountId, rows[i]);
          results.push({ row: i, idempotencyKey: key, status: r.duplicate ? "skipped-duplicate" : "imported" });
        } catch (err) {
          results.push({ row: i, idempotencyKey: key, status: "failed", error: err instanceof Error ? err.message : String(err) });
        }
      }
      return {
        dryRun: false,
        totalRows: rows.length,
        results,
        summary: {
          imported: results.filter((r) => r.status === "imported").length,
          skippedDuplicate: results.filter((r) => r.status === "skipped-duplicate").length,
          failed: results.filter((r) => r.status === "failed").length,
        },
      };
    }

    // Dry run: sequential simulation against the current replayed state.
    const txns = await this.txnRepo.find({ where: { accountId } });
    const sellIds = txns.filter((t) => t.type === "SELL").map((t) => t.id);
    const allocations =
      sellIds.length > 0
        ? await this.ds.getRepository(LedgerLotAllocation).find({ where: { sellTxnId: In(sellIds) } })
        : [];
    const states = replayLedger(txns as ReplayTxn[], allocations as ReplayAllocation[]);
    const simTxns = new Map<string, LedgerTransaction[]>(); // effective, for ordering guards
    const effective = effectiveTxns(txns as ReplayTxn[]);
    for (const t of effective) {
      const list = simTxns.get(t.instrumentId) ?? [];
      list.push(t as LedgerTransaction);
      simTxns.set(t.instrumentId, list);
    }

    for (let i = 0; i < rows.length; i++) {
      const key = rows[i]?.idempotencyKey ? String(rows[i].idempotencyKey) : null;
      try {
        if (!key) throw new HttpError(400, "Every import row needs an idempotencyKey.");
        if (seenKeys.has(key)) throw new HttpError(400, `Duplicate idempotencyKey "${key}" inside this batch.`);
        seenKeys.add(key);
        const existing = await this.txnRepo.findOne({ where: { idempotencyKey: key } });
        if (existing) {
          results.push({ row: i, idempotencyKey: key, status: "skipped-duplicate" });
          continue;
        }
        const instrument = await this.resolveInstrument(rows[i]);
        const n = await this.normalize(rows[i], instrument);
        this.simulateApply(states, simTxns, instrument.id, n);
        results.push({ row: i, idempotencyKey: key, status: "valid" });
      } catch (err) {
        results.push({ row: i, idempotencyKey: key, status: "invalid", error: err instanceof Error ? err.message : String(err) });
      }
    }
    return {
      dryRun: true,
      totalRows: rows.length,
      results,
      summary: {
        valid: results.filter((r) => r.status === "valid").length,
        skippedDuplicate: results.filter((r) => r.status === "skipped-duplicate").length,
        failed: results.filter((r) => r.status === "invalid").length,
      },
    };
  }

  /** Pure in-memory application of a normalized row for dry-run validation. */
  private simulateApply(
    states: Map<string, InstrumentState>,
    simTxns: Map<string, LedgerTransaction[]>,
    instrumentId: string,
    n: NormalizedTxn
  ): void {
    let st = states.get(instrumentId);
    if (!st) {
      st = { instrumentId, lots: [], realizedPnl: ZERO, dividendsNet: ZERO, chargeAdjustments: ZERO, effectiveTxnCount: 0 };
      states.set(instrumentId, st);
    }
    const hist = simTxns.get(instrumentId) ?? [];

    if (n.type === "SELL") {
      const laterCa = hist.find((t) => (t.type === "SPLIT" || t.type === "BONUS") && t.tradeDate > n.tradeDate);
      if (laterCa) throw new HttpError(400, `A ${laterCa.type} dated ${laterCa.tradeDate} exists after ${n.tradeDate}.`);
      const candidates = st.lots.filter((l) => l.buyTradeDate <= n.tradeDate);
      const available = candidates.reduce((s, l) => s + l.qty, 0);
      if (n.qtyInt! > available) {
        throw new HttpError(400, `Oversell: selling ${n.qtyInt} but only ${available} held on ${n.tradeDate}.`);
      }
      const fifo = sellFifo(candidates.map((l) => ({ qty: l.qty, costBasis: l.costBasis })), n.qtyInt!, n.price!, n.chargesMoney!);
      // apply consumption to the sim state
      for (const a of fifo.allocations) {
        const lot = candidates[a.lotIndex];
        lot.qty -= a.qtySold;
        lot.costBasis = sub(lot.costBasis, a.costBasisAllocated);
      }
      st.lots = st.lots.filter((l) => l.qty > 0);
    } else if (n.type === "BUY") {
      st.lots.push({
        buyTxnId: `pending-row`,
        buyTradeDate: n.tradeDate,
        qty: n.qtyInt!,
        costBasis: add(n.grossMoney!, n.chargesMoney!),
      });
      st.lots.sort((a, b) => (a.buyTradeDate < b.buyTradeDate ? -1 : a.buyTradeDate > b.buyTradeDate ? 1 : 0));
    } else if (n.type === "SPLIT" || n.type === "BONUS") {
      const laterSell = hist.find((t) => t.type === "SELL" && t.tradeDate >= n.tradeDate);
      if (laterSell) throw new HttpError(400, `A SELL dated ${laterSell.tradeDate} exists on/after ${n.tradeDate}.`);
      if (st.lots.length === 0) throw new HttpError(400, `No open lots to apply the ${n.type} to.`);
      const numerator = Number(n.qty);
      const denominator = Number(n.price);
      for (const lot of st.lots) {
        const effNum = n.type === "SPLIT" ? numerator : numerator + denominator;
        const scaled = (lot.qty * effNum) / denominator;
        if (!Number.isInteger(scaled)) {
          throw new HttpError(400, `${n.type} ${numerator}:${denominator} yields a fractional quantity on a ${lot.qty}-share lot.`);
        }
        lot.qty = scaled;
      }
    }
    // DIVIDEND / CHARGE_ADJUST: no lot-state impact.
    const pseudo = new LedgerTransaction();
    pseudo.type = n.type;
    pseudo.tradeDate = n.tradeDate;
    hist.push(pseudo);
    simTxns.set(instrumentId, hist);
  }

  // ── Views ────────────────────────────────────────────────────────────────

  private async toView(t: LedgerTransaction, ticker: string | null, correctedByHint: string | null): Promise<TxnView> {
    let correctedBy = correctedByHint;
    if (correctedBy === null) {
      const rev = await this.txnRepo.findOne({ where: { correctsId: t.id }, select: ["id"] });
      correctedBy = rev?.id ?? null;
    }
    return {
      id: t.id,
      instrumentId: t.instrumentId,
      ticker,
      type: t.type,
      tradeDate: t.tradeDate,
      qty: t.qty ?? null,
      price: t.price ?? null,
      grossAmount: t.grossAmount ?? null,
      charges: t.charges,
      isEstimatedPrice: t.isEstimatedPrice,
      note: t.note ?? null,
      correctsId: t.correctsId ?? null,
      correctedBy,
      idempotencyKey: t.idempotencyKey ?? null,
      createdAt: new Date(t.createdAt).toISOString(),
    };
  }
}

/** replayLedger wrapping integrity errors into 500s with context (stored state). */
function replayLedgerSafe(txns: ReplayTxn[], allocations: ReplayAllocation[]): Map<string, InstrumentState> {
  try {
    return replayLedger(txns, allocations);
  } catch (err) {
    if (err instanceof LedgerIntegrityError) {
      throw new HttpError(500, `Stored ledger failed integrity replay: ${err.message}`);
    }
    throw err;
  }
}

/**
 * CSV cell serializer. For free-text cells, values starting with = + - @ TAB
 * or CR are prefixed with a single quote so spreadsheet apps treat them as
 * text, never as formulas (CSV formula-injection defense, spec §12). Numeric
 * cells come from validated decimals and are emitted as-is.
 */
export function csvCell(value: string, guardFormula = false): string {
  let v = value;
  if (guardFormula && /^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  if (/[",\r\n]/.test(v)) v = `"${v.replace(/"/g, '""')}"`;
  return v;
}
