/**
 * Batch-2 delivery signals, pinned: a planted delivery effect is found,
 * noise does not pass, and the windows never read past the formation date.
 */
import { Panel } from "../src/services/research/selectionSignals";
import { DeliveryPanel, deliverySignalAt } from "../src/services/research/deliverySignals";
import { evaluateDelivery, judgeDelivery } from "../src/services/research/deliveryStudy";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

function dates(n: number): string[] {
  const out: string[] = [];
  const d = new Date("2021-10-01T00:00:00Z");
  while (out.length < n) {
    if (d.getUTCDay() % 6 !== 0) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/**
 * 60 stocks. Each stock has a slowly-varying "informed" state; delivery % rises with it
 * and, if `k` > 0, the stock's next-21d drift does too. k = 0 → delivery carries no information.
 */
function world(k: number, seed: number): { p: Panel; d: DeliveryPanel } {
  const r = rng(seed);
  const T = 1300;
  const n = 60;
  const ds = dates(T);
  const close = ds.map(() => new Array<number>(n).fill(NaN));
  const delivPct = ds.map(() => new Array<number>(n).fill(NaN));
  const tradeValue = ds.map(() => new Array<number>(n).fill(NaN));
  const px = new Array<number>(n).fill(100);
  const state = new Array<number>(n).fill(0);
  for (let t = 0; t < T; t++) {
    const m = 0.01 * gauss(r);
    for (let i = 0; i < n; i++) {
      if (t % 21 === 0) state[i] = gauss(r); // new information arrives monthly
      delivPct[t][i] = 45 + 8 * state[i] + 4 * gauss(r);
      tradeValue[t][i] = Math.exp(0.5 + 0.1 * gauss(r));
      px[i] *= 1 + m + 0.015 * gauss(r) + (k * state[i]) / 1000;
      close[t][i] = px[i];
    }
  }
  return {
    p: { dates: ds, tickers: ds.slice(0, n).map((_, i) => `S${i}.NS`), sectors: new Array(n).fill("x"), close, events: Array.from({ length: n }, () => []) },
    d: { delivPct, tradeValue },
  };
}

describe("delivery signals", () => {
  it("never reads delivery after the formation date", () => {
    const { p, d } = world(0, 3);
    const t = 400;
    const before = deliverySignalAt(p, d, "delivery-surge", t);
    for (let s = t + 1; s < p.dates.length; s++) d.delivPct[s] = d.delivPct[s].map(() => 99);
    expect(deliverySignalAt(p, d, "delivery-surge", t)).toEqual(before);
  });

  it("finds a planted delivery-surge effect", () => {
    const { p, d } = world(1.5, 5);
    const r = evaluateDelivery(p, d).find((x) => x.key === "delivery-surge")!;
    expect(r.sealed.meanIc!).toBeGreaterThan(0);
    expect(r.pass).toBe(true);
  });

  it("does not pass noise", () => {
    const { p, d } = world(0, 9);
    for (const r of evaluateDelivery(p, d)) expect(r.pass).toBe(false);
  });

  it("uses the stricter Bonferroni bar (t ≥ 2.64)", () => {
    const sealed = { dates: 200, nonOverlappingDates: 12, meanIc: 0.05, icT: 2.5, crossSectionalHitPct: 54, meanSpreadPct: 1, tiers: [] };
    expect(judgeDelivery(sealed, sealed).pass).toBe(false);
    expect(judgeDelivery(sealed, { ...sealed, icT: 2.7 }).pass).toBe(true);
  });
});
