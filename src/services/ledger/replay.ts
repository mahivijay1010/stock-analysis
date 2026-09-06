/**
 * Ledger replay (Phase B2) — PURE functions that derive position state from
 * the immutable transaction ledger. No TypeORM, no I/O.
 *
 * Core invariants (spec §3/§4, plan §2):
 *  - Positions are DERIVED by replaying transactions; there is no editable
 *    aggregate.
 *  - Stored lot_allocations are the authoritative record of what each SELL
 *    consumed. Replay CONSUMES those stored rows — it never re-runs FIFO for
 *    historical sells, so a backdated purchase can never rewrite an already
 *    recorded sale's cost allocation.
 *  - A transaction that has been corrected (a reversal row exists with
 *    corrects_id = its id) is void: replay skips both the original and the
 *    reversal. Originals are never edited or deleted.
 *  - All money flows through the decimal.js money module. NUMERIC columns
 *    arrive as strings and stay exact.
 *
 * Replay order: trade_date ASC, then created_at ASC, then id — deterministic,
 * and economically meaningful for corporate actions (a backdated BUY dated
 * before a split is split-adjusted by replay, matching real entitlements).
 */
import { Money, ZERO, add, sub, money, toDbString } from "../money";
import { LedgerTransactionType } from "../../entities/LedgerTransaction";

/** Minimal transaction shape replay needs (entity rows satisfy this). */
export interface ReplayTxn {
  id: string;
  instrumentId: string;
  type: LedgerTransactionType;
  tradeDate: string;
  qty?: string | null;
  price?: string | null;
  grossAmount?: string | null;
  charges: string;
  correctsId?: string | null;
  createdAt: Date | string;
}

/** Minimal stored-allocation shape replay needs. */
export interface ReplayAllocation {
  sellTxnId: string;
  buyTxnId: string;
  qty: string;
  allocatedCost: string;
  realizedPnl: string;
}

export interface OpenLot {
  buyTxnId: string;
  buyTradeDate: string;
  /** Split/bonus-adjusted remaining share count (integral by policy). */
  qty: number;
  /** Remaining cost basis incl. allocated purchase charges. */
  costBasis: Money;
}

export interface InstrumentState {
  instrumentId: string;
  /** Open lots in FIFO (replay) order. */
  lots: OpenLot[];
  /** Σ stored realized_pnl over effective (non-voided) sells. */
  realizedPnl: Money;
  /** Σ (gross − charges) over effective DIVIDEND rows — kept OUT of basis. */
  dividendsNet: Money;
  /** Σ signed CHARGE_ADJUST amounts — tracked separately, never in basis. */
  chargeAdjustments: Money;
  /** Count of effective (non-voided) transactions replayed. */
  effectiveTxnCount: number;
}

export class LedgerIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerIntegrityError";
  }
}

function num(value: string | number | null | undefined, what: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new LedgerIntegrityError(`${what} is not a finite number: ${value}`);
  return n;
}

function intOrThrow(n: number, what: string): number {
  if (!Number.isInteger(n)) throw new LedgerIntegrityError(`${what} must be integral, got ${n}`);
  return n;
}

/** Chronological, deterministic replay order. */
export function sortForReplay<T extends ReplayTxn>(txns: readonly T[]): T[] {
  return [...txns].sort((a, b) => {
    if (a.tradeDate !== b.tradeDate) return a.tradeDate < b.tradeDate ? -1 : 1;
    const ca = new Date(a.createdAt).getTime();
    const cb = new Date(b.createdAt).getTime();
    if (ca !== cb) return ca - cb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Ids of transactions voided by a reversal row. */
export function correctedIds(txns: readonly ReplayTxn[]): Set<string> {
  const out = new Set<string>();
  for (const t of txns) if (t.correctsId) out.add(t.correctsId);
  return out;
}

/** Effective = not a reversal row and not voided by one. */
export function effectiveTxns<T extends ReplayTxn>(txns: readonly T[]): T[] {
  const voided = correctedIds(txns);
  return sortForReplay(txns.filter((t) => !t.correctsId && !voided.has(t.id)));
}

/** Apply a split/bonus ratio to open lots; total basis unchanged, zero P&L. */
function applyRatio(lots: OpenLot[], numerator: number, denominator: number, kind: "SPLIT" | "BONUS"): void {
  for (const lot of lots) {
    // SPLIT num:den → qty × num/den. BONUS num per den held → qty × (num+den)/den.
    const effNum = kind === "SPLIT" ? numerator : numerator + denominator;
    const scaled = (lot.qty * effNum) / denominator;
    lot.qty = intOrThrow(scaled, `${kind} ${numerator}:${denominator} on lot ${lot.buyTxnId} (qty ${lot.qty})`);
  }
}

/**
 * Replay one instrument's effective transactions into a position state.
 * `allocationsBySell` must contain the stored rows for every SELL present.
 */
export function replayInstrument(
  instrumentId: string,
  txnsChronological: readonly ReplayTxn[],
  allocationsBySell: ReadonlyMap<string, readonly ReplayAllocation[]>
): InstrumentState {
  const state: InstrumentState = {
    instrumentId,
    lots: [],
    realizedPnl: ZERO,
    dividendsNet: ZERO,
    chargeAdjustments: ZERO,
    effectiveTxnCount: 0,
  };

  for (const t of txnsChronological) {
    state.effectiveTxnCount += 1;
    switch (t.type) {
      case "BUY": {
        const qty = intOrThrow(num(t.qty, "BUY qty"), "BUY qty");
        // Basis = gross + charges, from stored authoritative columns.
        const basis = add(money(t.grossAmount ?? "0"), money(t.charges));
        state.lots.push({ buyTxnId: t.id, buyTradeDate: t.tradeDate, qty, costBasis: basis });
        break;
      }
      case "SELL": {
        const allocs = allocationsBySell.get(t.id) ?? [];
        if (allocs.length === 0) {
          throw new LedgerIntegrityError(`SELL ${t.id} has no stored lot allocations`);
        }
        for (const a of allocs) {
          const lot = state.lots.find((l) => l.buyTxnId === a.buyTxnId);
          if (!lot) {
            throw new LedgerIntegrityError(
              `SELL ${t.id} allocation references lot ${a.buyTxnId} which is not open at that point`
            );
          }
          const q = num(a.qty, "allocation qty");
          if (q > lot.qty) {
            throw new LedgerIntegrityError(
              `SELL ${t.id} allocation consumes ${q} from lot ${a.buyTxnId} holding only ${lot.qty}`
            );
          }
          lot.qty -= q;
          lot.costBasis = sub(lot.costBasis, money(a.allocatedCost));
          if (lot.qty === 0) {
            if (!lot.costBasis.isZero()) {
              throw new LedgerIntegrityError(
                `lot ${a.buyTxnId} emptied with residual basis ${toDbString(lot.costBasis)}`
              );
            }
            state.lots = state.lots.filter((l) => l !== lot);
          }
          state.realizedPnl = add(state.realizedPnl, money(a.realizedPnl));
        }
        break;
      }
      case "DIVIDEND": {
        state.dividendsNet = add(state.dividendsNet, sub(money(t.grossAmount ?? "0"), money(t.charges)));
        break;
      }
      case "SPLIT":
      case "BONUS": {
        const numerator = intOrThrow(num(t.qty, `${t.type} ratio numerator`), `${t.type} ratio numerator`);
        const denominator = intOrThrow(num(t.price, `${t.type} ratio denominator`), `${t.type} ratio denominator`);
        if (numerator <= 0 || denominator <= 0) {
          throw new LedgerIntegrityError(`${t.type} ratio must be positive, got ${numerator}:${denominator}`);
        }
        applyRatio(state.lots, numerator, denominator, t.type);
        break;
      }
      case "CHARGE_ADJUST": {
        state.chargeAdjustments = add(state.chargeAdjustments, money(t.grossAmount ?? "0"));
        break;
      }
      default:
        throw new LedgerIntegrityError(`unknown transaction type ${(t as ReplayTxn).type}`);
    }
  }
  return state;
}

/**
 * Replay a whole account ledger → per-instrument states.
 * Throws LedgerIntegrityError if the stored ledger is not self-consistent —
 * writers MUST validate with this before committing (the ledger is always
 * replayable by construction).
 */
export function replayLedger(
  txns: readonly ReplayTxn[],
  allocations: readonly ReplayAllocation[]
): Map<string, InstrumentState> {
  const effective = effectiveTxns(txns);
  const bySell = new Map<string, ReplayAllocation[]>();
  for (const a of allocations) {
    const list = bySell.get(a.sellTxnId);
    if (list) list.push(a);
    else bySell.set(a.sellTxnId, [a]);
  }
  const byInstrument = new Map<string, ReplayTxn[]>();
  for (const t of effective) {
    const list = byInstrument.get(t.instrumentId);
    if (list) list.push(t);
    else byInstrument.set(t.instrumentId, [t]);
  }
  const out = new Map<string, InstrumentState>();
  for (const [instrumentId, list] of byInstrument) {
    out.set(instrumentId, replayInstrument(instrumentId, list, bySell));
  }
  return out;
}
