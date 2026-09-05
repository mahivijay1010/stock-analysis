/**
 * Module 2 — quant engine tests.
 * All fixtures are deterministic (no randomness). Indicator expectations are
 * hand-computed from small series.
 */

import {
  atr,
  bollinger,
  dailyReturns,
  ema,
  macd,
  maxDrawdown,
  rsi,
  sma,
  smaSeries,
  stdDev,
} from '../src/services/quant/indicators';
import {
  analyzeBars,
  buildProjections,
  DEFAULT_PROJECTION_AMOUNTS,
  HORIZONS,
  normalCdf,
  TRADING_DAY_OFFSETS,
} from '../src/services/quant/engine';
import {
  backtestBars,
  computeCalibration,
  isDirectionHit,
  PROB_BUCKET_EDGES,
} from '../src/services/quant/backtest';
import { Bar, HorizonPrediction } from '../src/services/quant/types';

// ---------- deterministic fixtures ----------

function mkBars(
  n: number,
  closeFn: (i: number) => number,
  volumeFn: (i: number) => number = () => 1_000_000
): Bar[] {
  const bars: Bar[] = [];
  const start = Date.UTC(2024, 0, 1);
  for (let i = 0; i < n; i++) {
    const close = closeFn(i);
    const prev = i > 0 ? closeFn(i - 1) : close;
    bars.push({
      date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
      open: prev,
      high: Math.max(prev, close) * 1.005,
      low: Math.min(prev, close) * 0.995,
      close,
      volume: volumeFn(i),
    });
  }
  return bars;
}

const uptrend = (i: number) => 100 * Math.pow(1.004, i) * (1 + 0.004 * Math.sin(i / 7));
const downtrend = (i: number) => 100 * Math.pow(0.996, i) * (1 + 0.004 * Math.sin(i / 7));
const sineDrift = (i: number) => 100 + 0.1 * i + 5 * Math.sin(i / 5);

function assertNoNaN(obj: unknown, path = 'root'): void {
  if (typeof obj === 'number') {
    if (!Number.isFinite(obj)) throw new Error(`non-finite number at ${path}: ${obj}`);
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => assertNoNaN(v, `${path}[${i}]`));
  } else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) assertNoNaN(v, `${path}.${k}`);
  }
}

// ---------- (a) indicator correctness on hand-computed fixtures ----------

describe('indicators', () => {
  test('sma: window math and short-array null', () => {
    expect(sma([1, 2, 3, 4, 5], 5)).toBe(3);
    expect(sma([1, 2, 3, 4, 5], 3)).toBe(4); // mean of last 3 = (3+4+5)/3
    expect(sma([1, 2], 3)).toBeNull();
    expect(sma([], 1)).toBeNull();
  });

  test('smaSeries: nulls until window fills', () => {
    expect(smaSeries([1, 2, 3, 4], 2)).toEqual([null, 1.5, 2.5, 3.5]);
    expect(smaSeries([1, 2], 5)).toEqual([null, null]);
  });

  test('ema: seeded with SMA then smoothed (period 3 on 1..5 -> 4)', () => {
    // seed = sma(1,2,3) = 2; k = 0.5; then 4 -> 3; then 5 -> 4
    expect(ema([1, 2, 3, 4, 5], 3)).toBeCloseTo(4, 10);
    expect(ema([1, 2], 3)).toBeNull();
  });

  test('rsi: hand-computed 15-value series (Wilder seed) = 66.6667', () => {
    // 14 changes: alternating +1 / -0.5 -> avgGain 0.5, avgLoss 0.25, RS 2, RSI 66.67
    const closes = [10, 11, 10.5, 11.5, 11, 12, 11.5, 12.5, 12, 13, 12.5, 13.5, 13, 14, 13.5];
    expect(rsi(closes, 14)).toBeCloseTo(66.6667, 3);
  });

  test('rsi: Wilder smoothing on the 16th value = 69.7674', () => {
    const closes = [10, 11, 10.5, 11.5, 11, 12, 11.5, 12.5, 12, 13, 12.5, 13.5, 13, 14, 13.5, 14.5];
    // avgGain = (0.5*13 + 1)/14, avgLoss = (0.25*13 + 0)/14 -> RSI 69.7674
    expect(rsi(closes, 14)).toBeCloseTo(69.7674, 3);
  });

  test('rsi: extremes and degenerate cases, never NaN', () => {
    const up = Array.from({ length: 20 }, (_, i) => 100 + i);
    const down = Array.from({ length: 20 }, (_, i) => 100 - i);
    const flat = Array.from({ length: 20 }, () => 100);
    expect(rsi(up, 14)).toBe(100);
    expect(rsi(down, 14)).toBe(0);
    expect(rsi(flat, 14)).toBe(50); // no gains, no losses -> neutral, not NaN
    expect(rsi([1, 2, 3], 14)).toBeNull();
  });

  test('macd: null when short, zeroes on a flat series', () => {
    expect(macd(Array.from({ length: 33 }, () => 5))).toBeNull();
    const flat = macd(Array.from({ length: 40 }, () => 5));
    expect(flat).not.toBeNull();
    expect(flat!.line).toBeCloseTo(0, 10);
    expect(flat!.signal).toBeCloseTo(0, 10);
    expect(flat!.histogram).toBeCloseTo(0, 10);
  });

  test('bollinger: hand-computed on 1..20 (population std dev)', () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1);
    const b = bollinger(values, 20, 2)!;
    // mean 10.5, population variance (20^2-1)/12 = 33.25, sd = 5.766281
    expect(b.middle).toBeCloseTo(10.5, 10);
    expect(b.upper).toBeCloseTo(22.032562, 4);
    expect(b.lower).toBeCloseTo(-1.032562, 4);
    expect(b.percentB).toBeCloseTo(0.911879, 4);
    expect(bollinger([1, 2, 3], 20, 2)).toBeNull();
  });

  test('bollinger: flat window has percentB 0.5, never NaN', () => {
    const b = bollinger(Array.from({ length: 20 }, () => 10), 20, 2)!;
    expect(b.upper).toBe(10);
    expect(b.lower).toBe(10);
    expect(b.percentB).toBe(0.5);
  });

  test('atr: constant true range of 2 -> ATR 2', () => {
    const bars: Bar[] = Array.from({ length: 15 }, (_, i) => ({
      date: `2024-01-${String(i + 1).padStart(2, '0')}`,
      open: 11,
      high: 12,
      low: 10,
      close: 11,
      volume: 1000,
    }));
    expect(atr(bars, 14)).toBeCloseTo(2, 10);
    expect(atr(bars.slice(0, 14), 14)).toBeNull();
  });

  test('stdDev: sample std dev of known series', () => {
    // mean 5, sum sq dev 32, sample variance 32/7 -> 2.13809
    expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.13809, 4);
    expect(stdDev([5])).toBeNull();
    expect(stdDev([])).toBeNull();
  });

  test('dailyReturns: simple returns, empty for short input', () => {
    const r = dailyReturns([100, 110, 99]);
    expect(r).toHaveLength(2);
    expect(r[0]).toBeCloseTo(0.1, 10);
    expect(r[1]).toBeCloseTo(-0.1, 10);
    expect(dailyReturns([100])).toEqual([]);
  });

  test('maxDrawdown: peak 120 to trough 80 -> -33.33%', () => {
    expect(maxDrawdown([100, 120, 90, 100, 80])).toBeCloseTo(-33.3333, 3);
    expect(maxDrawdown([100, 110, 120])).toBe(0); // monotonic up -> no drawdown
    expect(maxDrawdown([100])).toBeNull();
  });
});

// ---------- engine contract ----------

describe('engine.analyzeBars', () => {
  const upBars = mkBars(300, uptrend);
  const downBars = mkBars(300, downtrend);
  const upAnalysis = analyzeBars(upBars);
  const downAnalysis = analyzeBars(downBars);

  test('throws below 60 bars', () => {
    expect(() => analyzeBars(mkBars(59, uptrend))).toThrow(/60/);
    expect(() => analyzeBars([])).toThrow();
  });

  test('trading-day offsets match the spec mapping', () => {
    expect(TRADING_DAY_OFFSETS).toEqual({ 1: 1, 3: 2, 7: 5, 15: 10, 30: 21 });
  });

  test('normalCdf sanity', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.2816)).toBeCloseTo(0.9, 3);
    expect(normalCdf(-1.2816)).toBeCloseTo(0.1, 3);
  });

  test('signal weights sum to 1 and score is 0..100', () => {
    const totalWeight = upAnalysis.signals.reduce((s, x) => s + x.weight, 0);
    expect(totalWeight).toBeCloseTo(1, 9);
    for (const a of [upAnalysis, downAnalysis]) {
      expect(a.score).toBeGreaterThanOrEqual(0);
      expect(a.score).toBeLessThanOrEqual(100);
      expect(['BUY', 'HOLD', 'AVOID']).toContain(a.recommendation);
      expect(['LOW', 'MEDIUM', 'HIGH']).toContain(a.riskLevel);
    }
  });

  test('(b) strong uptrend: score > 55, positive 30d expected return, not AVOID', () => {
    expect(upAnalysis.score).toBeGreaterThan(55);
    const p30 = upAnalysis.predictions.find((p) => p.horizonDays === 30)!;
    expect(p30.expectedReturnPct).toBeGreaterThan(0);
    expect(p30.directionProb).toBeGreaterThan(0.5);
    expect(upAnalysis.recommendation).not.toBe('AVOID');
  });

  test('(b) strong downtrend: score < 45, negative 30d expected return, not BUY', () => {
    expect(downAnalysis.score).toBeLessThan(45);
    const p30 = downAnalysis.predictions.find((p) => p.horizonDays === 30)!;
    expect(p30.expectedReturnPct).toBeLessThan(0);
    expect(p30.directionProb).toBeLessThan(0.5);
    expect(downAnalysis.recommendation).not.toBe('BUY');
  });

  test('exactly the 5 horizons, each with a consistent 80% band around the expectation', () => {
    for (const a of [upAnalysis, downAnalysis]) {
      expect(a.predictions.map((p) => p.horizonDays)).toEqual([1, 3, 7, 15, 30]);
      for (const p of a.predictions) {
        expect(p.low80Pct).toBeLessThanOrEqual(p.expectedReturnPct);
        expect(p.high80Pct).toBeGreaterThanOrEqual(p.expectedReturnPct);
        expect(p.lowPrice).toBeLessThanOrEqual(p.expectedPrice);
        expect(p.highPrice).toBeGreaterThanOrEqual(p.expectedPrice);
        expect(p.directionProb).toBeGreaterThanOrEqual(0.05);
        expect(p.directionProb).toBeLessThanOrEqual(0.95);
      }
    }
  });

  test('(c) 80% bands widen strictly with horizon', () => {
    for (const a of [upAnalysis, downAnalysis]) {
      const widths = a.predictions.map((p) => p.high80Pct - p.low80Pct);
      for (let i = 1; i < widths.length; i++) {
        expect(widths[i]).toBeGreaterThan(widths[i - 1]);
      }
    }
  });

  test('reasons quote real numbers', () => {
    const all = [
      ...upAnalysis.reasons.positive,
      ...upAnalysis.reasons.negative,
      ...downAnalysis.reasons.positive,
      ...downAnalysis.reasons.negative,
    ];
    expect(all.length).toBeGreaterThan(0);
    for (const r of all) expect(r).toMatch(/\d/); // every reason mentions an actual number
    expect(upAnalysis.reasons.positive.length).toBeGreaterThan(0);
    expect(downAnalysis.reasons.negative.length).toBeGreaterThan(0);
  });

  test('no NaN anywhere, even on a perfectly flat series', () => {
    const flat = analyzeBars(
      mkBars(60, () => 100).map((b) => ({ ...b, high: 100, low: 100, open: 100 }))
    );
    assertNoNaN(flat);
    assertNoNaN(upAnalysis);
    assertNoNaN(downAnalysis);
    expect(flat.technicals.rsi14).toBe(50);
  });

  test('relative strength vs NIFTY moves the score', () => {
    // Stock flat-ish, NIFTY strongly up -> stock underperforms -> lower score than without NIFTY
    const stock = mkBars(300, (i) => 100 + 0.001 * i);
    const nifty = mkBars(300, uptrend);
    const withNifty = analyzeBars(stock, { niftyBars: nifty });
    const withoutNifty = analyzeBars(stock);
    expect(withNifty.score).toBeLessThan(withoutNifty.score);
    const rel = withNifty.signals.find((s) => s.name.includes('NIFTY'))!;
    expect(rel.direction).toBe('bearish');
  });
});

// ---------- (e) projections ----------

describe('engine.buildProjections', () => {
  const preds: HorizonPrediction[] = HORIZONS.map((h, idx) => ({
    horizonDays: h,
    expectedReturnPct: 2 * (idx + 1) * 0.5, // 1, 2, 3, 4, 5 %
    low80Pct: -1,
    high80Pct: 5,
    expectedPrice: 0,
    lowPrice: 0,
    highPrice: 0,
    directionProb: 0.6,
  }));

  test('default amounts are 1000/10000/100000/1000000', () => {
    const rows = buildProjections(100, preds);
    expect(rows.map((r) => r.amount)).toEqual([1000, 10000, 100000, 1000000]);
    expect(DEFAULT_PROJECTION_AMOUNTS).toEqual([1000, 10000, 100000, 1000000]);
    for (const row of rows) expect(row.byHorizon.map((b) => b.horizonDays)).toEqual([1, 3, 7, 15, 30]);
  });

  test('₹10,000 projection math: value = amount*(1+pct/100), profit = expected - amount', () => {
    const single: HorizonPrediction[] = [
      {
        horizonDays: 7,
        expectedReturnPct: 2,
        low80Pct: -1,
        high80Pct: 5,
        expectedPrice: 102,
        lowPrice: 99,
        highPrice: 105,
        directionProb: 0.7,
      },
    ];
    const rows = buildProjections(100, single);
    const tenK = rows.find((r) => r.amount === 10000)!.byHorizon[0];
    expect(tenK.expectedValue).toBe(10200);
    expect(tenK.lowValue).toBe(9900);
    expect(tenK.highValue).toBe(10500);
    expect(tenK.expectedProfit).toBe(200);
  });

  test('rounds to 2 decimals and honors custom amounts', () => {
    const single: HorizonPrediction[] = [
      {
        horizonDays: 1,
        expectedReturnPct: 1.2345,
        low80Pct: -2.3456,
        high80Pct: 4.5678,
        expectedPrice: 0,
        lowPrice: 0,
        highPrice: 0,
        directionProb: 0.55,
      },
    ];
    const rows = buildProjections(100, single, [777]);
    expect(rows).toHaveLength(1);
    const cell = rows[0].byHorizon[0];
    expect(cell.expectedValue).toBe(786.59); // 777 * 1.012345 = 786.592...
    expect(cell.lowValue).toBe(758.77); // 777 * 0.976544 = 758.774...
    expect(cell.highValue).toBe(812.49); // 777 * 1.045678 = 812.491...
    expect(cell.expectedProfit).toBeCloseTo(9.59, 10);
  });
});

// ---------- (d) backtest ----------

describe('backtest.backtestBars', () => {
  const bars = mkBars(300, sineDrift);

  test('direction-hit rule matches the spec (near-zero handling)', () => {
    expect(isDirectionHit(1.2, 0.8)).toBe(true); // both up
    expect(isDirectionHit(-0.5, -2)).toBe(true); // both down
    expect(isDirectionHit(1.2, -0.8)).toBe(false); // opposite signs
    expect(isDirectionHit(0.1, 0.01)).toBe(true); // near-zero actual, near-zero prediction
    expect(isDirectionHit(0.5, 0.01)).toBe(false); // near-zero actual, confident prediction
    expect(isDirectionHit(-0.2, -0.01)).toBe(true);
  });

  test('sane stats on a deterministic sine + drift series', () => {
    const result = backtestBars('TEST.NS', bars, { testDays: 60 });
    expect(result.ticker).toBe('TEST.NS');
    expect(result.testDays).toBe(60);
    expect(new Date(result.ranAt).toString()).not.toBe('Invalid Date');
    expect(result.horizons.map((h) => h.horizonDays)).toEqual([1, 3, 7, 15, 30]);

    for (const h of result.horizons) {
      expect(h.samples).toBeGreaterThan(0);
      expect(h.directionHitRatePct).toBeGreaterThanOrEqual(0);
      expect(h.directionHitRatePct).toBeLessThanOrEqual(100);
      expect(h.withinBandPct).toBeGreaterThanOrEqual(0);
      expect(h.withinBandPct).toBeLessThanOrEqual(100);
      expect(h.avgAbsErrorPct).toBeGreaterThanOrEqual(0);
    }
    // expected sample counts for n=300, testDays=60: T in [240, 298]
    const byH = Object.fromEntries(result.horizons.map((h) => [h.horizonDays, h.samples]));
    expect(byH[1]).toBe(59); // T up to 298
    expect(byH[3]).toBe(58); // offset 2 -> T up to 297
    expect(byH[7]).toBe(55); // offset 5
    expect(byH[15]).toBe(50); // offset 10
    expect(byH[30]).toBe(39); // offset 21 -> T up to 278

    expect(result.samples.length).toBeLessThanOrEqual(50);
    for (const s of result.samples) {
      expect([1, 3, 7, 15, 30]).toContain(s.horizonDays);
      expect(typeof s.date).toBe('string');
      expect(Number.isFinite(s.predictedPct)).toBe(true);
      expect(Number.isFinite(s.actualPct)).toBe(true);
      expect(typeof s.correct).toBe('boolean');
    }
    assertNoNaN(result.horizons);
  });

  test('actualPct uses the exact trading-day offset close', () => {
    // small window so every sample is retained (22 < 50)
    const prefix = bars.slice(0, 272);
    const result = backtestBars('TEST.NS', prefix, { testDays: 10 });
    const T = 265;
    const s1 = result.samples.find((s) => s.date === prefix[T].date && s.horizonDays === 1)!;
    expect(s1).toBeDefined();
    const expected = (prefix[T + 1].close / prefix[T].close - 1) * 100;
    expect(s1.actualPct).toBeCloseTo(expected, 4);
  });

  test('ZERO LOOKAHEAD: backtest prediction at T equals analyzeBars on the truncated prefix', () => {
    const prefix = bars.slice(0, 272);
    const result = backtestBars('TEST.NS', prefix, { testDays: 10 });
    expect(result.samples.length).toBeGreaterThan(0);
    expect(result.samples.length).toBeLessThanOrEqual(50);

    for (const s of result.samples) {
      const T = prefix.findIndex((b) => b.date === s.date);
      expect(T).toBeGreaterThanOrEqual(120);
      const truncated = analyzeBars(prefix.slice(0, T + 1)); // future bars removed entirely
      const pred = truncated.predictions.find((p) => p.horizonDays === s.horizonDays)!;
      expect(s.predictedPct).toBe(pred.expectedReturnPct); // exact equality — no future influence
    }
  });

  test('ZERO LOOKAHEAD: predictions for the same date are identical whether or not future bars exist', () => {
    // Run A sees data only up to index 271; run B additionally sees indices 272..276.
    const btA = backtestBars('TEST.NS', bars.slice(0, 272), { testDays: 10 }); // T in [262, 271]
    const btB = backtestBars('TEST.NS', bars.slice(0, 277), { testDays: 15 }); // T in [262, 276]

    const key = (s: { date: string; horizonDays: number }) => `${s.date}|${s.horizonDays}`;
    const mapB = new Map(btB.samples.map((s) => [key(s), s]));
    let compared = 0;
    for (const sA of btA.samples) {
      const sB = mapB.get(key(sA));
      if (!sB) continue;
      compared++;
      expect(sB.predictedPct).toBe(sA.predictedPct); // identical despite extra future data
      expect(sB.actualPct).toBe(sA.actualPct);
      expect(sB.correct).toBe(sA.correct);
    }
    expect(compared).toBeGreaterThanOrEqual(10);
  });

  test('returns empty stats (not a crash) when history is too short', () => {
    const short = backtestBars('SHORT.NS', mkBars(100, sineDrift), { testDays: 60 });
    expect(short.samples).toEqual([]);
    for (const h of short.horizons) expect(h.samples).toBe(0);
    assertNoNaN(short);
  });

  // ---------- V6 calibration (SPEC_CALIBRATION Module C1) ----------

  test('calibration: deterministic series → brier in [0,1], buckets sum to samples', () => {
    const result = backtestBars('TEST.NS', bars, { testDays: 60 });
    for (const h of result.horizons) {
      expect(h.samples).toBeGreaterThan(0);
      expect(h.brierScore).toBeDefined();
      expect(h.brierScore!).toBeGreaterThanOrEqual(0);
      expect(h.brierScore!).toBeLessThanOrEqual(1);
      expect(h.probBuckets).toBeDefined();
      expect(h.probBuckets!.map((b) => [b.pLow, b.pHigh])).toEqual(
        PROB_BUCKET_EDGES.map((e) => [e[0], e[1]])
      );
      const totalN = h.probBuckets!.reduce((s, b) => s + b.n, 0);
      expect(totalN).toBe(h.samples); // Σ bucket n == samples
      for (const b of h.probBuckets!) {
        expect(b.observedUpFreq).toBeGreaterThanOrEqual(0);
        expect(b.observedUpFreq).toBeLessThanOrEqual(1);
        if (b.n > 0) {
          expect(b.meanPredicted).toBeGreaterThanOrEqual(b.pLow);
          expect(b.meanPredicted).toBeLessThanOrEqual(b.pHigh);
        } else {
          expect(b.meanPredicted).toBe(0);
          expect(b.observedUpFreq).toBe(0);
        }
      }
    }
    assertNoNaN(result.horizons);
  });

  test('calibration: perfect-foresight synthetic (prob 0.95 when up) → brier < 0.05', () => {
    // Deterministic synthetic outcomes: prob 0.95 whenever the move is up,
    // 0.05 whenever it is down — a nearly perfect forecaster.
    const rows = Array.from({ length: 200 }, (_, i) => {
      const up = Math.sin(i / 3) >= 0; // deterministic mixed up/down pattern
      return { directionProb: up ? 0.95 : 0.05, actualPct: up ? 1.5 : -1.5 };
    });
    const cal = computeCalibration(rows)!;
    expect(cal.brierScore).toBeLessThan(0.05); // (0.05)² = 0.0025 exactly
    expect(cal.brierScore).toBeCloseTo(0.0025, 4);
    // Extreme-probability buckets are perfectly calibrated too.
    const lowB = cal.probBuckets[0];
    const highB = cal.probBuckets[cal.probBuckets.length - 1];
    expect(lowB.n + highB.n).toBe(200);
    expect(highB.observedUpFreq).toBe(1);
    expect(lowB.observedUpFreq).toBe(0);
  });

  test('calibration: constant p=0.5 → brier exactly 0.25 (coin-flip reference)', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      directionProb: 0.5,
      actualPct: i % 2 === 0 ? 0.8 : -0.8, // outcomes irrelevant at p=0.5
    }));
    const cal = computeCalibration(rows)!;
    expect(cal.brierScore).toBe(0.25);
    // All samples fall in the middle bucket [0.475, 0.525).
    const mid = cal.probBuckets.find((b) => b.pLow === 0.475)!;
    expect(mid.n).toBe(100);
    expect(mid.meanPredicted).toBe(0.5);
    expect(mid.observedUpFreq).toBe(0.5);
    // Empty input has no honest calibration to report.
    expect(computeCalibration([])).toBeNull();
  });

  test('withinBandPct is consistent with the recorded bands', () => {
    const result = backtestBars('TEST.NS', bars, { testDays: 40 });
    // recompute one horizon's withinBandPct independently
    const h = 1 as const;
    const n = bars.length;
    const startT = Math.max(120, n - 40);
    let within = 0;
    let total = 0;
    for (let T = startT; T <= n - 2; T++) {
      if (T + 1 >= n) continue;
      const a = analyzeBars(bars.slice(0, T + 1));
      const p = a.predictions.find((x) => x.horizonDays === h)!;
      const actual = Math.round((bars[T + 1].close / bars[T].close - 1) * 100 * 1e4) / 1e4;
      total++;
      if (actual >= p.low80Pct && actual <= p.high80Pct) within++;
    }
    const stats = result.horizons.find((x) => x.horizonDays === h)!;
    expect(stats.samples).toBe(total);
    expect(stats.withinBandPct).toBeCloseTo((within / total) * 100, 2);
  });
});
