/**
 * Lot accounting math (spec §4) — pure functions over Money.
 *
 * Definitions (spec §4, verbatim semantics):
 *  For remaining quantity q and remaining cost basis B (B includes allocated
 *  purchase charges):
 *   - current marked value            = q × current observed price
 *   - unrealized marked P&L           = marked value − B
 *   - projected marked P&L at date d  = q × forecast price(d) − B   (NOT realized)
 *   - forecast change from today      = q × (forecast price(d) − current price)
 *   - realized P&L                    = actual net sale proceeds − allocated
 *                                       cost basis of the sold lots
 *
 * Fees are subtracted exactly once: purchase charges live inside the lot's
 * cost basis; sale charges are subtracted inside net proceeds. Realized P&L
 * = netProceeds − allocatedBasis therefore counts each charge once.
 *
 * FIFO with exact reconciliation: partial-lot basis allocation uses the
 * largest-remainder split, so (basis sold) + (basis remaining) ≡ original
 * lot basis, and Σ remaining basis after a sale ≡ B_before − allocatedBasis.
 *
 * Quantities are integral share counts (instrument-specific quantity policies
 * such as corporate-action entitlements arrive with the B2+ ledger).
 */
import { Money, MoneyInput, ZERO, add, allocateByWeights, div, money, mul, sub, sum } from "./money";

export interface Lot {
  /** Remaining share quantity in this lot (positive integer). */
  qty: number;
  /** Remaining total cost basis of the lot, INCLUDING allocated purchase charges. */
  costBasis: Money;
}

function assertPositiveInt(n: number, what: string): void {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${what} must be a positive integer, got ${n}`);
  }
}

/** Open a lot: basis = qty × price + purchase charges (charges counted here, once). */
export function purchaseLot(qty: number, price: MoneyInput, charges: MoneyInput): Lot {
  assertPositiveInt(qty, "purchase qty");
  return { qty, costBasis: add(mul(qty, price), charges) };
}

/** q × current observed price. */
export function markedValue(qty: number, price: MoneyInput): Money {
  return mul(qty, price);
}

/** marked value − remaining basis. Unrealized: no sale has occurred. */
export function unrealizedMarkedPnl(qty: number, price: MoneyInput, costBasis: MoneyInput): Money {
  return sub(markedValue(qty, price), costBasis);
}

/**
 * q × forecast price − B. A projection under "holdings unchanged" — it is
 * NEVER realized profit and must be labeled as projected (spec §4).
 */
export function projectedMarkedPnl(qty: number, forecastPrice: MoneyInput, costBasis: MoneyInput): Money {
  return sub(mul(qty, forecastPrice), costBasis);
}

/** q × (forecast price − current observed price). */
export function forecastChangeFromToday(qty: number, forecastPrice: MoneyInput, currentPrice: MoneyInput): Money {
  return mul(qty, sub(forecastPrice, currentPrice));
}

export interface LotAllocation {
  /** Index of the source lot in the input array. */
  lotIndex: number;
  qtySold: number;
  /** Cost basis (incl. its purchase-charge share) allocated to this sale. */
  costBasisAllocated: Money;
}

export interface SellFifoResult {
  /** qty × price before sale charges. */
  grossProceeds: Money;
  /** grossProceeds − saleCharges (charges subtracted here, once). */
  netProceeds: Money;
  /** Total cost basis of the sold shares (purchase charges included, once). */
  allocatedCostBasis: Money;
  /** netProceeds − allocatedCostBasis. */
  realizedPnl: Money;
  /** Surviving lots in FIFO order, bases reduced by exactly the allocated amounts. */
  remainingLots: Lot[];
  /** Per-lot audit trail of the sale (stored, never recomputed, in the future ledger). */
  allocations: LotAllocation[];
}

/**
 * FIFO sale across lots. Rejects overselling. Partial-lot basis split uses
 * the largest-remainder method so sold + remaining ≡ the lot's basis exactly.
 */
export function sellFifo(
  lots: readonly Lot[],
  sellQty: number,
  price: MoneyInput,
  saleCharges: MoneyInput
): SellFifoResult {
  assertPositiveInt(sellQty, "sell qty");
  const available = lots.reduce((n, lot) => n + lot.qty, 0);
  if (sellQty > available) {
    throw new Error(`oversell rejected: selling ${sellQty} with only ${available} held`);
  }

  let toSell = sellQty;
  const remainingLots: Lot[] = [];
  const allocations: LotAllocation[] = [];
  const allocatedParts: Money[] = [];

  lots.forEach((lot, lotIndex) => {
    if (toSell === 0) {
      remainingLots.push({ qty: lot.qty, costBasis: lot.costBasis });
      return;
    }
    const qtySold = Math.min(lot.qty, toSell);
    toSell -= qtySold;

    if (qtySold === lot.qty) {
      // Whole lot consumed — its entire basis moves to the sale. Exact.
      allocations.push({ lotIndex, qtySold, costBasisAllocated: lot.costBasis });
      allocatedParts.push(lot.costBasis);
    } else {
      // Partial: split basis by shares sold vs kept; largest-remainder makes
      // the two parts sum exactly to the lot's basis.
      const [soldPart, keptPart] = allocateByWeights(lot.costBasis, [qtySold, lot.qty - qtySold]);
      allocations.push({ lotIndex, qtySold, costBasisAllocated: soldPart });
      allocatedParts.push(soldPart);
      remainingLots.push({ qty: lot.qty - qtySold, costBasis: keptPart });
    }
  });

  const grossProceeds = mul(sellQty, price);
  const netProceeds = sub(grossProceeds, saleCharges);
  const allocatedCostBasis = allocatedParts.length > 0 ? sum(allocatedParts) : ZERO;

  return {
    grossProceeds,
    netProceeds,
    allocatedCostBasis,
    realizedPnl: sub(netProceeds, allocatedCostBasis),
    remainingLots,
    allocations,
  };
}

/**
 * Ordinary split/bonus on a lot: qty × (num/den); TOTAL cost basis unchanged,
 * so per-share basis scales by den/num and the event creates zero P&L by
 * itself. The resulting quantity must be a whole number of shares —
 * fractional entitlements need the corporate-action handling of later phases
 * and are rejected rather than silently rounded (spec §3).
 */
export function applySplit(lot: Lot, ratioNumerator: number, ratioDenominator: number): Lot {
  assertPositiveInt(ratioNumerator, "split ratio numerator");
  assertPositiveInt(ratioDenominator, "split ratio denominator");
  const newQtyTimesDen = lot.qty * ratioNumerator;
  if (newQtyTimesDen % ratioDenominator !== 0) {
    throw new Error(
      `split ${ratioNumerator}:${ratioDenominator} of ${lot.qty} shares yields a fractional quantity — entitlement handling required`
    );
  }
  return { qty: newQtyTimesDen / ratioDenominator, costBasis: lot.costBasis };
}

/** Remaining per-share basis at internal scale (diagnostic/display input). */
export function perShareBasis(lot: Lot): Money {
  return div(lot.costBasis, lot.qty);
}

/** Total basis across lots. */
export function totalBasis(lots: readonly Lot[]): Money {
  return lots.length > 0 ? sum(lots.map((l) => l.costBasis)) : money(0);
}
