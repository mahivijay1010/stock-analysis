/**
 * Stock-selection study, pinned: a planted effect must be found, noise must
 * not pass, and the market's direction must never leak into the score.
 */
import { Panel, SIGNALS, buildContext, reactionSession, scoreDate, spearman } from "../src/services/research/selectionSignals";
import { evaluatePanel, judge } from "../src/services/research/selectionStudy";

/** Deterministic PRNG so tests never flake. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

function tradingDates(from: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(from + "T00:00:00Z");
  while (out.length < n) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/**
 * 60 stocks in 6 sectors. Daily return = market + noise + reversalK × (−previous 5-day idiosyncratic move / 5).
 * reversalK = 0 → pure noise; > 0 → a genuine short-term reversal.
 */
function panel(reversalK: number, seed: number, market = 0.0005): Panel {
  const r = rng(seed);
  const dates = tradingDates("2021-10-01", 1300);
  const n = 60;
  const close = dates.map(() => new Array<number>(n).fill(NaN));
  const idio: number[][] = dates.map(() => new Array<number>(n).fill(0));
  const px = new Array<number>(n).fill(100);
  for (let t = 0; t < dates.length; t++) {
    const m = market + 0.01 * gauss(r);
    for (let i = 0; i < n; i++) {
      let past = 0;
      for (let k = 1; k <= 5 && t - k >= 0; k++) past += idio[t - k][i];
      const e = 0.015 * gauss(r) - (reversalK * past) / 5;
      idio[t][i] = e;
      px[i] *= 1 + m + e;
      close[t][i] = px[i];
    }
  }
  return {
    dates,
    tickers: Array.from({ length: n }, (_, i) => `S${i}.NS`),
    sectors: Array.from({ length: n }, (_, i) => `sec${i % 6}`),
    close,
    events: Array.from({ length: n }, () => []),
  };
}

describe("selection signals", () => {
  it("spearman is 1 for a monotone map and -1 for its reverse", () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1);
  });

  it("a broadcast before 15:30 IST is priced that session; after it, the next", () => {
    const dates = ["2026-07-16", "2026-07-17", "2026-07-20"];
    expect(reactionSession(dates, Date.parse("2026-07-17T14:00:00+05:30"))).toBe(1);
    expect(reactionSession(dates, Date.parse("2026-07-17T19:50:03+05:30"))).toBe(2);
    expect(reactionSession(dates, Date.parse("2026-07-18T10:00:00+05:30"))).toBe(2); // Saturday → Monday
  });

  it("a market-wide move cannot raise the cross-sectional score", () => {
    const up = panel(0, 7, 0.01); // the tape rises 1%/day
    const ctx = buildContext(up);
    const spec = SIGNALS.find((s) => s.key === "sector-reversal")!;
    let calls = 0;
    let hits = 0;
    for (let t = 300; t < 1200; t += 5) {
      const d = scoreDate(up, spec, t, ctx)!;
      calls += d.tiers.all.calls;
      hits += d.tiers.all.hits;
    }
    expect(hits / calls).toBeGreaterThan(0.45);
    expect(hits / calls).toBeLessThan(0.55);
  });

  it("finds a planted short-term reversal and passes it", () => {
    const res = evaluatePanel(panel(0.6, 11)).find((r) => r.key === "sector-reversal")!;
    expect(res.sealed.meanIc!).toBeGreaterThan(0);
    expect(res.pass).toBe(true);
    expect(res.sealed.crossSectionalHitPct!).toBeGreaterThan(52);
  });

  it("does not pass noise", () => {
    const res = evaluatePanel(panel(0, 23));
    for (const r of res) expect(r.pass).toBe(false);
  });

  it("judge requires the development sign to agree", () => {
    const sealed = { dates: 200, nonOverlappingDates: 40, meanIc: 0.08, icT: 3.1, crossSectionalHitPct: 55, meanSpreadPct: 1, tiers: [] };
    expect(judge({ ...sealed, meanIc: -0.01 }, sealed).pass).toBe(false);
    expect(judge({ ...sealed }, sealed).pass).toBe(true);
  });
});
