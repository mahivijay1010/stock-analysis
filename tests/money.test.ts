/**
 * Spec §4 acceptance fixtures at the money-math level (binding, exact):
 *   10 sh @ ₹100 + ₹10 charges → basis 1,010.00
 *   @ ₹110 → unrealized marked P&L +90.00
 *   forecast ₹120 → projected marked P&L +190.00 (projected, NOT realized)
 *   sell 4 @ ₹120 with ₹6 charges → realized +70.00; 6 sh remain on 606.00 basis
 *   2-for-1 split → qty ×2, per-share basis ÷2, zero P&L
 * Plus: largest-remainder reconciliation property test and a
 * no-double-fee-subtraction decomposition test.
 */
import {
  allocateByWeights,
  applySplit,
  forecastChangeFromToday,
  markedValue,
  money,
  mul,
  perShareBasis,
  projectedMarkedPnl,
  purchaseLot,
  sellFifo,
  sub,
  sum,
  toDisplayString,
  totalBasis,
  unrealizedMarkedPnl,
  toDbString,
  Lot,
} from "../src/services/money";

describe("spec §4 money fixtures (exact, deterministic)", () => {
  const lot = purchaseLot(10, 100, 10);

  test("10 sh @100 + ₹10 charges → cost basis 1010.00", () => {
    expect(toDisplayString(lot.costBasis)).toBe("1010.00");
    expect(toDbString(lot.costBasis)).toBe("1010.0000");
  });

  test("at ₹110 the marked unrealized P&L is +90.00", () => {
    expect(toDisplayString(markedValue(lot.qty, 110))).toBe("1100.00");
    expect(toDisplayString(unrealizedMarkedPnl(lot.qty, 110, lot.costBasis))).toBe("90.00");
  });

  test("forecast ₹120 → projected marked P&L +190.00 — projected, NOT realized", () => {
    expect(toDisplayString(projectedMarkedPnl(lot.qty, 120, lot.costBasis))).toBe("190.00");
    // Nothing was sold: realized P&L does not exist yet. A forecast never
    // creates realized profit — only a sale (sellFifo) produces realizedPnl.
    expect(toDisplayString(forecastChangeFromToday(lot.qty, 120, 110))).toBe("100.00");
  });

  test("sell 4 @120 with ₹6 charges → realized +70.00, remaining 6 sh with basis 606.00", () => {
    const sale = sellFifo([lot], 4, 120, 6);
    expect(toDisplayString(sale.grossProceeds)).toBe("480.00");
    expect(toDisplayString(sale.netProceeds)).toBe("474.00");
    expect(toDisplayString(sale.allocatedCostBasis)).toBe("404.00");
    expect(toDisplayString(sale.realizedPnl)).toBe("70.00");
    expect(sale.remainingLots).toHaveLength(1);
    expect(sale.remainingLots[0].qty).toBe(6);
    expect(toDisplayString(sale.remainingLots[0].costBasis)).toBe("606.00");
  });

  test("2-for-1 split doubles qty, halves per-share basis, creates zero P&L", () => {
    const post = applySplit(lot, 2, 1);
    expect(post.qty).toBe(20);
    expect(toDisplayString(perShareBasis(lot))).toBe("101.00");
    expect(toDisplayString(perShareBasis(post))).toBe("50.50");
    // Total basis unchanged — the split itself creates no profit:
    expect(toDbString(post.costBasis)).toBe(toDbString(lot.costBasis));
    // At the ex-adjusted price (110/2) the marked P&L is identical pre/post:
    expect(toDbString(unrealizedMarkedPnl(post.qty, 55, post.costBasis))).toBe(
      toDbString(unrealizedMarkedPnl(lot.qty, 110, lot.costBasis))
    );
  });
});

describe("no double fee subtraction", () => {
  test("realized = gross − saleCharges − soldBasis(incl. buy-charge share), each charge exactly once", () => {
    const lot = purchaseLot(10, 100, 10); // ₹10 buy charges inside basis
    const sale = sellFifo([lot], 4, 120, 6); // ₹6 sale charges inside netProceeds

    // Decomposition: 4×(120−100) share P&L = 80; minus 4/10 of ₹10 buy
    // charges = 4; minus ₹6 sale charges → 70.
    const shareGain = mul(4, sub(120, 100));
    expect(toDisplayString(shareGain)).toBe("80.00");
    expect(toDisplayString(sale.realizedPnl)).toBe("70.00");
    expect(toDbString(sale.realizedPnl)).toBe(toDbString(sub(sub(shareGain, 4), 6)));

    // realized is derived from netProceeds (already net of sale charges) —
    // subtracting charges again would double-count:
    expect(toDbString(sale.realizedPnl)).toBe(toDbString(sub(sale.netProceeds, sale.allocatedCostBasis)));

    // Buy charges live only in basis: sold share (404) + kept share (606)
    // reconstruct 1010 exactly — the ₹10 was allocated once, not twice.
    expect(toDbString(sum([sale.allocatedCostBasis, sale.remainingLots[0].costBasis]))).toBe("1010.0000");
  });
});

describe("largest-remainder allocation always reconciles", () => {
  test("known awkward split: ₹10 across 3 equal lots", () => {
    const parts = allocateByWeights(10, [1, 1, 1]);
    expect(parts.map((p) => toDbString(p))).toEqual(["3.3334", "3.3333", "3.3333"]);
    expect(toDbString(sum(parts))).toBe("10.0000");
  });

  test("property: Σ allocations ≡ total for pseudo-random totals/weights (fixed seed)", () => {
    // Deterministic 32-bit PRNG (mulberry32) — fixed seed, reproducible runs.
    let s = 0xC0FFEE;
    const rand = () => {
      s |= 0; s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    for (let caseIdx = 0; caseIdx < 500; caseIdx++) {
      // totals up to ₹1 crore with paise+sub-paise precision; 1–12 lots
      const totalUnits = Math.floor(rand() * 1e11) + 1; // in 10^-4 ₹ units
      const sign = rand() < 0.2 ? -1 : 1;
      const total = money(`${sign * totalUnits}e-4`);
      const n = 1 + Math.floor(rand() * 12);
      const weights = Array.from({ length: n }, () => Math.floor(rand() * 1000));
      if (weights.every((w) => w === 0)) weights[0] = 1;

      const parts = allocateByWeights(total, weights);
      expect(parts).toHaveLength(n);
      // exact reconciliation — the property under test
      expect(toDbString(sum(parts))).toBe(toDbString(total));
      // zero-weight lots receive nothing when others carry weight
      parts.forEach((p, i) => {
        if (weights[i] === 0) expect(p.isZero()).toBe(true);
      });
    }
  });

  test("rejects empty, negative, and all-zero weights", () => {
    expect(() => allocateByWeights(10, [])).toThrow();
    expect(() => allocateByWeights(10, [1, -1])).toThrow();
    expect(() => allocateByWeights(10, [0, 0])).toThrow();
  });
});

describe("FIFO ordering, oversell, and multi-lot reconciliation", () => {
  const lots: Lot[] = [purchaseLot(5, 90, 5), purchaseLot(10, 100, 10)];

  test("FIFO consumes the oldest lot first and splits the second exactly", () => {
    const sale = sellFifo(lots, 8, 120, 6);
    expect(sale.allocations).toEqual([
      expect.objectContaining({ lotIndex: 0, qtySold: 5 }),
      expect.objectContaining({ lotIndex: 1, qtySold: 3 }),
    ]);
    // lot0 basis 455 whole + 3/10 of lot1 basis 1010 = 303 → 758
    expect(toDisplayString(sale.allocatedCostBasis)).toBe("758.00");
    // remaining: 7 sh of lot1 with 707 basis; totals reconcile exactly
    expect(sale.remainingLots).toEqual([expect.objectContaining({ qty: 7 })]);
    expect(toDbString(totalBasis(sale.remainingLots))).toBe("707.0000");
    expect(toDbString(sum([sale.allocatedCostBasis, totalBasis(sale.remainingLots)]))).toBe(
      toDbString(totalBasis(lots))
    );
  });

  test("oversell is rejected", () => {
    expect(() => sellFifo(lots, 16, 120, 0)).toThrow(/oversell/);
  });

  test("fractional split entitlements are rejected, not rounded", () => {
    expect(() => applySplit({ qty: 3, costBasis: money(300) }, 1, 2)).toThrow(/fractional/);
  });
});
