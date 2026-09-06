/**
 * Money core — decimal.js-backed exact money arithmetic (spec §4, plan §2).
 *
 * Policy (Phase B1, binding for every authoritative money computation):
 *  - INTERNAL_SCALE 4: every stored/derived money amount is quantized to
 *    4 decimal places (matches the DB's numeric(14,4) trade columns).
 *  - DISPLAY_SCALE 2: rupee display rounds to paise, for display ONLY —
 *    never feed a display-rounded value back into arithmetic.
 *  - Rounding: ROUND_HALF_EVEN (banker's) internally; ROUND_HALF_UP at the
 *    display boundary (plan §2). Both deterministic.
 *  - Charge allocation across lots uses the largest-remainder method
 *    (allocateByWeights) so the allocations ALWAYS sum exactly to the total.
 *  - No IEEE-754 float ever carries an authoritative money value. Inputs from
 *    the DB (numeric → string) must be passed as strings, not parseFloat'd.
 *
 * This module is pure math: no TypeORM, no I/O. B2 builds the transaction
 * ledger on top of it.
 */
import Decimal from "decimal.js";

export const INTERNAL_SCALE = 4;
export const DISPLAY_SCALE = 2;

/**
 * Dedicated Decimal constructor so nothing else in the process (or a future
 * dependency) can reconfigure rounding out from under money math.
 */
export const MoneyDecimal = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_EVEN,
});

/** A money amount: a Decimal quantized to INTERNAL_SCALE. */
export type Money = Decimal;

export type MoneyInput = string | number | Decimal;

/** Quantize to the internal scale with banker's rounding. */
function q(value: Decimal): Money {
  return value.toDecimalPlaces(INTERNAL_SCALE, Decimal.ROUND_HALF_EVEN);
}

/**
 * Construct a money amount (₹, scale 4, HALF_EVEN).
 * Prefer string inputs for DB/user values; numbers are accepted for integral
 * quantities and test literals.
 */
export function money(value: MoneyInput): Money {
  return q(new MoneyDecimal(value as Decimal.Value));
}

export const ZERO: Money = money(0);

export function add(a: MoneyInput, b: MoneyInput): Money {
  return q(new MoneyDecimal(a as Decimal.Value).plus(b as Decimal.Value));
}

export function sub(a: MoneyInput, b: MoneyInput): Money {
  return q(new MoneyDecimal(a as Decimal.Value).minus(b as Decimal.Value));
}

export function mul(a: MoneyInput, b: MoneyInput): Money {
  return q(new MoneyDecimal(a as Decimal.Value).times(b as Decimal.Value));
}

export function div(a: MoneyInput, b: MoneyInput): Money {
  return q(new MoneyDecimal(a as Decimal.Value).dividedBy(b as Decimal.Value));
}

export function sum(values: readonly MoneyInput[]): Money {
  return q(
    values.reduce<Decimal>(
      (acc, v) => acc.plus(v as Decimal.Value),
      new MoneyDecimal(0)
    )
  );
}

/** Exact equality at the internal scale. */
export function eq(a: MoneyInput, b: MoneyInput): boolean {
  return money(a).equals(money(b));
}

/**
 * Display string at DISPLAY_SCALE (2 dp, paise), ROUND_HALF_UP per plan §2.
 * Display only — never round-trip this back into arithmetic.
 */
export function toDisplayString(value: MoneyInput): string {
  return new MoneyDecimal(value as Decimal.Value).toFixed(
    DISPLAY_SCALE,
    Decimal.ROUND_HALF_UP
  );
}

/** Serialize at full internal scale (e.g. for numeric(14,4) DB writes). */
export function toDbString(value: MoneyInput): string {
  return money(value).toFixed(INTERNAL_SCALE);
}

/**
 * Largest-remainder allocation: split `total` across `weights` so that the
 * parts are proportional to the weights AND always sum exactly to `total`.
 *
 * Used to allocate purchase/sale charges (and lot cost basis on partial
 * sells) so reconciliation is exact by construction — Σ parts ≡ total, no
 * lost or invented paise (spec §4: never subtract fees twice, totals must
 * reconcile).
 *
 * Method: work in integral internal-scale units (1 unit = 10^-4 ₹).
 * Give each part floor(total_units × w_i / Σw), then hand the remaining
 * units, one each, to the parts with the largest fractional remainders
 * (ties broken by lowest index, deterministically).
 *
 * Weights must be non-negative with a positive sum. `total` may be negative
 * (allocation runs on |total| and the sign is restored uniformly).
 */
export function allocateByWeights(
  total: MoneyInput,
  weights: readonly MoneyInput[]
): Money[] {
  if (weights.length === 0) {
    throw new Error("allocateByWeights: weights must be non-empty");
  }
  const weightDecs = weights.map((w) => new MoneyDecimal(w as Decimal.Value));
  if (weightDecs.some((w) => w.isNegative())) {
    throw new Error("allocateByWeights: weights must be non-negative");
  }
  const weightSum = weightDecs.reduce((acc, w) => acc.plus(w), new MoneyDecimal(0));
  if (weightSum.isZero()) {
    throw new Error("allocateByWeights: weight sum must be positive");
  }

  const totalMoney = money(total);
  const negative = totalMoney.isNegative();
  const scaleFactor = new MoneyDecimal(10).pow(INTERNAL_SCALE);
  // Integral by construction: totalMoney is quantized to INTERNAL_SCALE.
  const totalUnits = totalMoney.abs().times(scaleFactor);

  const rawShares = weightDecs.map((w) =>
    totalUnits.times(w).dividedBy(weightSum)
  );
  const floors = rawShares.map((s) => s.floor());
  const allocatedUnits = floors.reduce((acc, f) => acc.plus(f), new MoneyDecimal(0));
  let remainderUnits = totalUnits.minus(allocatedUnits).toNumber(); // small integer

  // Rank by largest fractional remainder; deterministic tie-break on index.
  const order = rawShares
    .map((s, i) => ({ i, frac: s.minus(floors[i]) }))
    .sort((a, b) => {
      const cmp = b.frac.comparedTo(a.frac);
      return cmp !== 0 ? cmp : a.i - b.i;
    });

  const parts = floors.slice();
  for (let k = 0; remainderUnits > 0; k = (k + 1) % order.length) {
    parts[order[k].i] = parts[order[k].i].plus(1);
    remainderUnits -= 1;
  }

  return parts.map((p) => {
    const value = q(p.dividedBy(scaleFactor));
    return negative ? q(value.negated()) : value;
  });
}
