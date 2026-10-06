/**
 * Batch-2 stock-selection signals from NSE delivery / trade-size data — PURE.
 * Frozen by docs/delivery-signals-preregistration.md (2026-10-06). Scoring is
 * batch 1's, unchanged: the same cohort-median call, IC, tiers and spread.
 */
import { DateScore, Panel, SignalContext, TIERS, median, spearman } from "./selectionSignals";

export type DeliverySignalKey = "delivery-surge" | "delivery-confirmed-move" | "trade-size-shock";

export interface DeliverySpec {
  key: DeliverySignalKey;
  horizon: number;
  minCohort: number;
  describe: string;
}

export const DELIVERY_SIGNALS: DeliverySpec[] = [
  { key: "delivery-surge", horizon: 21, minCohort: 20, describe: "mean delivery % (t−4..t) minus mean (t−64..t−5)" },
  { key: "delivery-confirmed-move", horizon: 21, minCohort: 20, describe: "sign(5d return) × max(0, delivery-surge)" },
  { key: "trade-size-shock", horizon: 21, minCohort: 20, describe: "ln mean trade value (t−4..t) − ln mean (t−64..t−5)" },
];

export const RECENT = 5;
export const BASELINE_FROM = 64; // t−64 .. t−5
export const MIN_BASELINE_PRESENT = 50;

/** Delivery panel aligned to Panel.dates × Panel.tickers. NaN where absent. */
export interface DeliveryPanel {
  delivPct: number[][];
  /** turnover_lacs / no_of_trades */
  tradeValue: number[][];
}

function windowMean(grid: number[][], i: number, from: number, to: number, minPresent: number, positive = false): number | null {
  if (from < 0) return null;
  let s = 0;
  let n = 0;
  for (let t = from; t <= to; t++) {
    const v = grid[t][i];
    if (Number.isFinite(v) && (!positive || v > 0)) {
      s += v;
      n++;
    }
  }
  return n >= minPresent ? s / n : null;
}

/** Raw signal values at formation index t. PURE. */
export function deliverySignalAt(p: Panel, d: DeliveryPanel, key: DeliverySignalKey, t: number): Array<number | null> {
  const n = p.tickers.length;
  const out: Array<number | null> = new Array(n).fill(null);
  const baseMin = MIN_BASELINE_PRESENT;
  for (let i = 0; i < n; i++) {
    if (key === "trade-size-shock") {
      const rec = windowMean(d.tradeValue, i, t - RECENT + 1, t, RECENT, true);
      const base = windowMean(d.tradeValue, i, t - BASELINE_FROM, t - RECENT, baseMin, true);
      out[i] = rec != null && base != null ? Math.log(rec) - Math.log(base) : null;
      continue;
    }
    const rec = windowMean(d.delivPct, i, t - RECENT + 1, t, RECENT);
    const base = windowMean(d.delivPct, i, t - BASELINE_FROM, t - RECENT, baseMin);
    if (rec == null || base == null) continue;
    const surge = rec - base;
    if (key === "delivery-surge") {
      out[i] = surge;
    } else {
      const a = p.close[t - RECENT]?.[i];
      const b = p.close[t][i];
      if (!(Number.isFinite(a) && Number.isFinite(b) && a > 0)) continue;
      out[i] = Math.sign(b / a - 1) * Math.max(0, surge);
    }
  }
  return out;
}

/** Score one delivery signal at t with batch-1 scoring. Null if the cohort is too small. PURE. */
export function scoreDeliveryDate(p: Panel, d: DeliveryPanel, spec: DeliverySpec, t: number, ctx: SignalContext): DateScore | null {
  const h = spec.horizon;
  if (t + h >= p.dates.length) return null;
  const sig = deliverySignalAt(p, d, spec.key, t);
  const s: number[] = [];
  const f: number[] = [];
  for (let i = 0; i < p.tickers.length; i++) {
    const v = sig[i];
    if (v == null) continue;
    const a = p.close[t][i];
    const b = p.close[t + h][i];
    if (!(Number.isFinite(a) && Number.isFinite(b) && a > 0)) continue;
    const lo = Math.max(0, t - BASELINE_FROM);
    if (ctx.bad[i][t + h] - ctx.bad[i][lo] > 0) continue;
    s.push(v);
    f.push(b / a - 1);
  }
  if (s.length < spec.minCohort) return null;

  const mf = median(f);
  const order = s.map((_, k) => k).sort((a, b) => s[a] - s[b]);
  const tiers: DateScore["tiers"] = {};
  for (const tier of TIERS) {
    let calls = 0;
    let hits = 0;
    if (tier.q === 0.5) {
      const ms = median(s);
      for (let k = 0; k < s.length; k++) {
        const up = s[k] > ms;
        const rel = f[k] - mf;
        calls++;
        if ((up && rel > 0) || (!up && rel < 0)) hits++;
      }
    } else {
      const m = Math.max(1, Math.floor(s.length * tier.q));
      for (const k of order.slice(0, m)) {
        calls++;
        if (f[k] - mf < 0) hits++;
      }
      for (const k of order.slice(-m)) {
        calls++;
        if (f[k] - mf > 0) hits++;
      }
    }
    tiers[tier.key] = { calls, hits };
  }
  const m3 = Math.max(1, Math.floor(s.length / 3));
  const mean = (ks: number[]) => ks.reduce((acc, k) => acc + f[k], 0) / ks.length;
  return { t, date: p.dates[t], n: s.length, ic: spearman(s, f), tiers, spread: mean(order.slice(-m3)) - mean(order.slice(0, m3)) };
}
