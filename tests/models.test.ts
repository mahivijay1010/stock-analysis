/**
 * V7 Module A1/A2 — model pool tests.
 * All fixtures deterministic (no randomness). Covers: registry shape,
 * determinism, [0.05, 0.95] clamps, uptrend fixture behavior, selector
 * weighting, and the walk-forward pool evaluation.
 */

import { Bar, Horizon, ModelHorizonStat } from "../src/services/quant/types";
import {
  ALL_MODELS,
  MODEL_NAMES,
  MODEL_REGISTRY,
  predictAll,
} from "../src/services/quant/models";
import { ModelInput } from "../src/services/quant/models/types";
import {
  blendProb,
  equalWeights,
  inverseBrierWeights,
  selectEnsemble,
} from "../src/services/quant/models/selector";
import { evaluateModelPool } from "../src/services/quant/models/evaluate";

const HORIZONS: Horizon[] = [1, 3, 7, 15, 30];

// ---------- deterministic fixtures (mirrors quant.test.ts) ----------

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

/** Flat tape, then a violent single-day spike ABOVE the 20-day mean. */
const spikeAfterFlat = (i: number) => (i < 299 ? 100 : 115);

const upBars = mkBars(300, uptrend);
const downBars = mkBars(300, downtrend);
const spikeBars = mkBars(300, spikeAfterFlat);

function baseInput(bars: Bar[]): ModelInput {
  return { bars, niftyBars: null, newsSentimentScore: null, regimeScore: null };
}

// ---------- registry ----------

describe("model registry", () => {
  test("exactly the 6 spec models, names matching", () => {
    expect(MODEL_NAMES).toEqual([
      "momentum",
      "meanReversion",
      "trend",
      "volAdjusted",
      "sentiment",
      "macro",
    ]);
    expect(ALL_MODELS).toHaveLength(6);
    for (const name of MODEL_NAMES) {
      expect(MODEL_REGISTRY[name].name).toBe(name);
    }
  });
});

// ---------- determinism ----------

describe("determinism", () => {
  test("same input twice → bit-identical probabilities for every model", () => {
    const a = predictAll(baseInput(upBars));
    const b = predictAll(baseInput(upBars));
    expect(b).toEqual(a);
  });

  test("independently constructed equal inputs → identical output", () => {
    const a = predictAll({
      bars: mkBars(300, uptrend),
      niftyBars: mkBars(300, sineDrift),
      newsSentimentScore: 42,
      regimeScore: 63,
    });
    const b = predictAll({
      bars: mkBars(300, uptrend),
      niftyBars: mkBars(300, sineDrift),
      newsSentimentScore: 42,
      regimeScore: 63,
    });
    expect(b).toEqual(a);
  });
});

// ---------- clamps ----------

describe("clamps [0.05, 0.95]", () => {
  const extremeUp = mkBars(300, (i) => 100 * Math.pow(1.05, i)); // +5%/day forever
  const extremeDown = mkBars(300, (i) => 100 * Math.pow(0.95, i));
  const fixtures: Array<[string, ModelInput]> = [
    ["extreme uptrend", baseInput(extremeUp)],
    ["extreme downtrend", baseInput(extremeDown)],
    [
      "max positive context",
      {
        bars: extremeUp,
        niftyBars: extremeUp,
        newsSentimentScore: 100,
        regimeScore: 100,
      },
    ],
    [
      "max negative context",
      {
        bars: extremeDown,
        niftyBars: extremeDown,
        newsSentimentScore: -100,
        regimeScore: 0,
      },
    ],
    ["tiny input (10 bars)", baseInput(mkBars(10, uptrend))],
  ];

  test.each(fixtures)("%s: every prob in [0.05, 0.95] and finite", (_label, input) => {
    const all = predictAll(input);
    for (const name of MODEL_NAMES) {
      for (const h of HORIZONS) {
        const p = all[name][h];
        expect(Number.isFinite(p)).toBe(true);
        expect(p).toBeGreaterThanOrEqual(0.05);
        expect(p).toBeLessThanOrEqual(0.95);
      }
    }
  });
});

// ---------- fixture behavior ----------

describe("uptrend fixture behavior", () => {
  test("momentum and trend read the uptrend as > 0.5 at every horizon", () => {
    const mom = MODEL_REGISTRY.momentum.predict(baseInput(upBars));
    const tr = MODEL_REGISTRY.trend.predict(baseInput(upBars));
    for (const h of HORIZONS) {
      expect(mom[h]).toBeGreaterThan(0.5);
      expect(tr[h]).toBeGreaterThan(0.5);
    }
  });

  test("momentum and trend read the downtrend as < 0.5", () => {
    const mom = MODEL_REGISTRY.momentum.predict(baseInput(downBars));
    const tr = MODEL_REGISTRY.trend.predict(baseInput(downBars));
    for (const h of HORIZONS) {
      expect(mom[h]).toBeLessThan(0.5);
      expect(tr[h]).toBeLessThan(0.5);
    }
  });

  test("meanReversion < 0.5 after a spike above the 20-day mean", () => {
    const mr = MODEL_REGISTRY.meanReversion.predict(baseInput(spikeBars));
    for (const h of HORIZONS) {
      expect(mr[h]).toBeLessThan(0.5);
    }
  });

  test("volAdjusted leans with risk-adjusted momentum", () => {
    const up = MODEL_REGISTRY.volAdjusted.predict(baseInput(upBars));
    const down = MODEL_REGISTRY.volAdjusted.predict(baseInput(downBars));
    expect(up[7]).toBeGreaterThan(0.5);
    expect(down[7]).toBeLessThan(0.5);
  });

  test("sentiment: null score + flat tape → exactly neutral 0.5", () => {
    const flat = mkBars(300, () => 100);
    const s = MODEL_REGISTRY.sentiment.predict(baseInput(flat));
    for (const h of HORIZONS) expect(s[h]).toBe(0.5);
  });

  test("sentiment: strong positive news lifts every horizon above 0.5", () => {
    const flat = mkBars(300, () => 100);
    const s = MODEL_REGISTRY.sentiment.predict({
      bars: flat,
      niftyBars: null,
      newsSentimentScore: 80,
      regimeScore: null,
    });
    for (const h of HORIZONS) expect(s[h]).toBeGreaterThan(0.5);
  });

  test("macro: all context null → exactly neutral 0.5", () => {
    const m = MODEL_REGISTRY.macro.predict(baseInput(upBars));
    for (const h of HORIZONS) expect(m[h]).toBe(0.5);
  });

  test("macro: risk-on regime + rising index → above 0.5", () => {
    const m = MODEL_REGISTRY.macro.predict({
      bars: upBars,
      niftyBars: mkBars(300, uptrend),
      newsSentimentScore: null,
      regimeScore: 80,
    });
    for (const h of HORIZONS) expect(m[h]).toBeGreaterThan(0.5);
  });
});

// ---------- selector ----------

describe("EnsembleSelector", () => {
  test("inverse-Brier weights: sum 1, lower brier → strictly higher weight", () => {
    const w = inverseBrierWeights({
      momentum: 0.2,
      meanReversion: 0.24,
      trend: 0.18,
      volAdjusted: 0.25,
      sentiment: 0.26, // worse than coin flip → floor
      macro: 0.23,
    });
    const sum = MODEL_NAMES.reduce((s, n) => s + w[n], 0);
    expect(sum).toBeCloseTo(1, 4); // weights rounded to 6dp → sum within ±5e-5
    expect(w.trend).toBeGreaterThan(w.momentum);
    expect(w.momentum).toBeGreaterThan(w.meanReversion);
    // Worse-than-coin-flip model floors at the 0.001 edge, never 0 or negative.
    expect(w.sentiment).toBeGreaterThan(0);
    expect(w.sentiment).toBeLessThan(w.volAdjusted + 1e-9);
  });

  test("no stats at all → equal weights, bestModel null, source 'equal'", () => {
    const sel = selectEnsemble({ backtestStats: null, backtestRanAt: null, liveWeights: null });
    expect(sel.source).toBe("equal");
    expect(sel.bestModel).toBeNull();
    for (const n of MODEL_NAMES) expect(sel.weights[n]).toBeCloseTo(1 / 6, 9);
  });

  test("backtest stats → inverse-brier weights and correct bestModel", () => {
    const stat = (brier: number, samples = 40): ModelHorizonStat => ({
      brier,
      hitRatePct: 50,
      samples,
    });
    const sel = selectEnsemble({
      backtestStats: {
        momentum: stat(0.22),
        meanReversion: stat(0.25),
        trend: stat(0.19),
        volAdjusted: stat(0.24),
        sentiment: stat(0.26),
        macro: stat(0.23),
      },
      backtestRanAt: "2026-08-30T00:00:00Z",
    });
    expect(sel.source).toBe("backtest");
    expect(sel.bestModel).toEqual({ name: "trend", brier: 0.19, samples: 40 });
    const sum = MODEL_NAMES.reduce((s, n) => s + sel.weights[n], 0);
    expect(sum).toBeCloseTo(1, 6);
    expect(sel.weights.trend).toBeGreaterThan(sel.weights.momentum);
  });

  test("live weights preferred only when fresher than the backtest", () => {
    const stats = {
      momentum: { brier: 0.2, hitRatePct: 55, samples: 40 },
    };
    const live = {
      weights: { momentum: 0.7, meanReversion: 0.06, trend: 0.06, volAdjusted: 0.06, sentiment: 0.06, macro: 0.06 },
      updatedAt: "2026-09-01T00:00:00Z",
    };
    const fresher = selectEnsemble({
      backtestStats: stats,
      backtestRanAt: "2026-08-25T00:00:00Z",
      liveWeights: live,
    });
    expect(fresher.source).toBe("live");
    expect(fresher.weights.momentum).toBeCloseTo(0.7, 4);

    const staler = selectEnsemble({
      backtestStats: stats,
      backtestRanAt: "2026-09-02T00:00:00Z",
      liveWeights: live,
    });
    expect(staler.source).toBe("backtest");
  });

  test("blendProb: weighted mean of the model probabilities", () => {
    const w = equalWeights();
    const p = blendProb(w, {
      momentum: 0.6,
      meanReversion: 0.4,
      trend: 0.6,
      volAdjusted: 0.4,
      sentiment: 0.5,
      macro: 0.5,
    });
    expect(p).toBeCloseTo(0.5, 9);
  });
});

// ---------- walk-forward pool evaluation ----------

describe("evaluateModelPool", () => {
  const bars = mkBars(250, sineDrift);

  test("every model + blended has stats with sane bounds; deterministic", () => {
    const a = evaluateModelPool(bars, { testDays: 60 });
    const b = evaluateModelPool(bars, { testDays: 60 });
    expect(b).toEqual(a); // deterministic
    expect(a.horizons).toHaveLength(5);
    for (const h of a.horizons) {
      for (const name of MODEL_NAMES) {
        const s = h.models[name];
        expect(s.samples).toBeGreaterThan(0);
        expect(s.samples).toBeLessThanOrEqual(60);
        expect(s.brier).toBeGreaterThanOrEqual(0);
        expect(s.brier).toBeLessThanOrEqual(1);
        expect(s.hitRatePct).toBeGreaterThanOrEqual(0);
        expect(s.hitRatePct).toBeLessThanOrEqual(100);
      }
      expect(h.ensemble.samples).toBe(h.models.momentum.samples);
      expect(h.ensemble.brier).toBeGreaterThanOrEqual(0);
      expect(h.ensemble.brier).toBeLessThanOrEqual(1);
    }
  });

  test("longer horizons have fewer matured samples (no lookahead padding)", () => {
    const r = evaluateModelPool(bars, { testDays: 60 });
    const s1 = r.horizons.find((h) => h.horizonDays === 1)!.models.momentum.samples;
    const s30 = r.horizons.find((h) => h.horizonDays === 30)!.models.momentum.samples;
    expect(s30).toBeLessThan(s1);
  });

  test("too little history → zero samples, never fabricated stats", () => {
    const short = mkBars(100, sineDrift); // < MIN_LOOKBACK + horizon
    const r = evaluateModelPool(short, { testDays: 60 });
    for (const h of r.horizons) {
      const total = MODEL_NAMES.reduce((s, n) => s + h.models[n].samples, 0);
      // With 100 bars, startT = max(120, 40) = 120 > n-2 → no samples at all.
      expect(total).toBe(0);
    }
  });
});
