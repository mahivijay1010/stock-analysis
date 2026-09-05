/**
 * V8 R2 — HAR-RV VolatilityForecaster tests (SPEC_V8 acceptance cases):
 *  - synthetic AR(1)-in-vol series → OLS recovers positive loading on the RV
 *    lags AND walk-forward out-of-sample R² > 0
 *  - flat series → graceful null / zero-variance guard (never NaN, never a
 *    fabricated forecast)
 *
 * V10 B2 — HAR-X (previous-day India VIX, z-scored over the fit window):
 *  - synthetic VOL-LINKED series (return vol driven by prev-day VIX) → the
 *    HAR-X fit recovers a POSITIVE VIX beta and wins out-of-sample
 *  - when the VIX adds nothing (constant/absent) → plain-HAR fallback, stated
 */

import {
  alignVixToRv,
  dailyRvSeries,
  fitHar,
  fitHarX,
  forecastVolatility,
  olsFit,
  VixPoint,
  walkForwardOosR2,
  walkForwardOosR2Pair,
} from "../src/services/quant/volforecast";
import { Bar } from "../src/services/quant/types";

// ── deterministic pseudo-randomness (mulberry32) ─────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic standard-normal via Box–Muller on seeded uniforms. */
function gaussians(seed: number, n: number): number[] {
  const rand = mulberry32(seed);
  const out: number[] = [];
  while (out.length < n) {
    const u1 = Math.max(rand(), 1e-12);
    const u2 = rand();
    const r = Math.sqrt(-2 * Math.log(u1));
    out.push(r * Math.cos(2 * Math.PI * u2));
    out.push(r * Math.sin(2 * Math.PI * u2));
  }
  return out.slice(0, n);
}

/**
 * AR(1)-in-vol synthetic closes: log σ_t mean-reverts with persistence 0.99
 * (large, slow vol cycles), r_t = σ_t · ε_t. Volatility is strongly
 * autocorrelated, so its lags carry real predictive signal — exactly what
 * HAR-RV should recover. The χ²(1) noise in RV_t = r_t² stays brutal, which
 * is the whole point of the daily-proxy caveat.
 */
function ar1VolCloses(n: number, seed = 42): number[] {
  const eps = gaussians(seed, n);
  const shocks = gaussians(seed + 1, n);
  const mu = Math.log(0.015);
  let logSigma = mu;
  const closes: number[] = [100];
  for (let i = 0; i < n; i++) {
    logSigma = mu + 0.99 * (logSigma - mu) + 0.15 * shocks[i];
    const sigma = Math.min(0.12, Math.max(0.002, Math.exp(logSigma)));
    closes.push(closes[closes.length - 1] * (1 + sigma * eps[i]));
  }
  return closes;
}

function barsFromCloses(closes: number[]): Bar[] {
  const start = Date.UTC(2020, 0, 1);
  return closes.map((c, i) => ({
    date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    open: c,
    high: c * 1.005,
    low: c * 0.995,
    close: c,
    volume: 1_000_000,
  }));
}

// ── OLS core ─────────────────────────────────────────────────────────────────

describe("olsFit", () => {
  it("recovers exact coefficients from a noiseless linear system", () => {
    // y = 2 + 3·x1 − 0.5·x2
    const X: number[][] = [];
    const y: number[] = [];
    const rand = mulberry32(7);
    for (let i = 0; i < 50; i++) {
      const x1 = rand() * 10;
      const x2 = rand() * 5;
      X.push([1, x1, x2]);
      y.push(2 + 3 * x1 - 0.5 * x2);
    }
    const beta = olsFit(X, y)!;
    expect(beta[0]).toBeCloseTo(2, 6);
    expect(beta[1]).toBeCloseTo(3, 6);
    expect(beta[2]).toBeCloseTo(-0.5, 6);
  });

  it("returns null on a singular design (duplicate columns)", () => {
    const X = [
      [1, 2, 2],
      [1, 3, 3],
      [1, 4, 4],
      [1, 5, 5],
    ];
    expect(olsFit(X, [1, 2, 3, 4])).toBeNull();
  });
});

// ── HAR-RV on synthetic AR(1)-in-vol data ────────────────────────────────────

describe("HAR-RV on an AR(1)-in-vol series", () => {
  // Deterministic (seeded) series — measured at build time: betaSum ≈ 0.618,
  // in-sample R² ≈ 0.165, walk-forward OOS R² ≈ 0.107 on 60 samples.
  const closes = ar1VolCloses(1200, 42);
  const rv = dailyRvSeries(closes);

  it("OLS recovers positive combined loading on the RV lags", () => {
    const fit = fitHar(rv);
    expect(fit).not.toBeNull();
    const [, b1, b2, b3] = fit!.beta;
    // Individual lag betas trade off against each other; persistence must
    // show up as a positive TOTAL loading, and the in-sample fit must be real.
    expect(b1 + b2 + b3).toBeGreaterThan(0.2);
    expect(fit!.r2InSample).toBeGreaterThan(0);
  });

  it("walk-forward out-of-sample R² > 0 (real predictability, no lookahead)", () => {
    const oos = walkForwardOosR2(rv);
    expect(oos.samples).toBeGreaterThanOrEqual(20);
    expect(oos.r2).not.toBeNull();
    expect(oos.r2!).toBeGreaterThan(0);
  });

  it("forecastVolatility produces finite, positive, sane annualized vols", () => {
    const f = forecastVolatility(barsFromCloses(closes));
    expect(f.forecast1dVolPct).not.toBeNull();
    expect(f.forecast5dVolPct).not.toBeNull();
    expect(f.historicalAvgVolPct).not.toBeNull();
    expect(f.forecast1dVolPct!).toBeGreaterThan(0);
    expect(f.forecast1dVolPct!).toBeLessThan(200);
    expect(f.forecast5dVolPct!).toBeGreaterThan(0);
    expect(["elevated", "normal", "calm"]).toContain(f.regime);
    expect(f.r2InSample).not.toBeNull();
    expect(f.note).toContain("daily");
  });
});

// ── Degenerate inputs ────────────────────────────────────────────────────────

describe("HAR-RV degenerate guards", () => {
  it("flat series → graceful nulls (zero-variance guard), never NaN", () => {
    const flat = barsFromCloses(new Array(400).fill(100));
    const f = forecastVolatility(flat);
    expect(f.forecast1dVolPct).toBeNull();
    expect(f.forecast5dVolPct).toBeNull();
    expect(f.r2InSample).toBeNull();
    expect(f.r2OutOfSample).toBeNull();
    expect(f.regime).toBeNull();
    expect(f.sizingHint).toBeNull();
    expect(f.note.length).toBeGreaterThan(0);
    // nothing NaN anywhere
    for (const v of [f.forecast1dVolPct, f.forecast5dVolPct, f.historicalAvgVolPct]) {
      expect(v === null || Number.isFinite(v)).toBe(true);
    }
  });

  it("too-short series → nulls with the reason in note", () => {
    const f = forecastVolatility(barsFromCloses(ar1VolCloses(50, 3)));
    expect(f.forecast1dVolPct).toBeNull();
    expect(f.note).toContain("Not enough");
  });
});

// ── V10 B2: HAR-X with a previous-day VIX regressor ─────────────────────────

/**
 * Synthetic VOL-LINKED world: true daily vol follows the V8 slow AR(1)
 * log-σ cycles, and the VIX-like index is FORWARD-LOOKING implied vol — bar
 * i's VIX anticipates the NEXT session's true σ (annualized %), which is
 * exactly what a real implied-vol index encodes. The previous-day VIX is
 * therefore a fresher, noiseless read of tomorrow's variance than the stale
 * χ²-noisy RV lags plain HAR sees — the structure HAR-X should recover with
 * a POSITIVE β on the z-scored VIX and a walk-forward OOS win.
 */
function vixLinkedWorld(
  n: number,
  seed = 7
): { closes: number[]; vixSeries: number[] } {
  const eps = gaussians(seed, n + 1);
  const shocks = gaussians(seed + 1, n + 2);
  const mu = Math.log(0.015);
  let logSigma = mu;
  const sigmas: number[] = [];
  for (let i = 0; i <= n + 1; i++) {
    logSigma = mu + 0.99 * (logSigma - mu) + 0.15 * shocks[i];
    sigmas.push(Math.min(0.12, Math.max(0.002, Math.exp(logSigma))));
  }
  const closes: number[] = [100];
  for (let i = 1; i <= n; i++) {
    closes.push(closes[closes.length - 1] * (1 + sigmas[i] * eps[i]));
  }
  const vixSeries = Array.from(
    { length: n + 1 },
    (_, i) => sigmas[i + 1] * Math.sqrt(252) * 100
  );
  return { closes, vixSeries };
}

function vixPointsFor(bars: Bar[], vixSeries: number[]): VixPoint[] {
  return bars.map((b, i) => ({ date: b.date, close: vixSeries[i] }));
}

describe("HAR-X on a synthetic VIX-linked vol series (V10 B2)", () => {
  const { closes, vixSeries } = vixLinkedWorld(900, 7);
  const bars = barsFromCloses(closes);
  const vix = vixPointsFor(bars, vixSeries);
  const rv = dailyRvSeries(closes);
  const exog = alignVixToRv(bars.map((b) => b.date), vix);

  it("alignVixToRv maps each bar to its on-or-before VIX close", () => {
    expect(exog).toHaveLength(bars.length);
    expect(exog[0]).toBe(vixSeries[0]);
    expect(exog[exog.length - 1]).toBe(vixSeries[vixSeries.length - 1]);
    expect(exog.every((v) => v !== null)).toBe(true);
  });

  it("fitHarX recovers a POSITIVE beta on the z-scored previous-day VIX", () => {
    const fit = fitHarX(rv, exog)!;
    expect(fit).not.toBeNull();
    expect(fit.beta[4]).toBeGreaterThan(0); // higher prev-day VIX ⇒ higher next RV
    expect(fit.exogSd).toBeGreaterThan(0);
    expect(fit.r2InSample).toBeGreaterThan(0);
  });

  it("HAR-X BEATS plain HAR out-of-sample on the same walk-forward days", () => {
    const pair = walkForwardOosR2Pair(rv, exog);
    expect(pair.samples).toBeGreaterThanOrEqual(20);
    expect(pair.har).not.toBeNull();
    expect(pair.harx).not.toBeNull();
    expect(pair.harx!).toBeGreaterThan(pair.har!);
  });

  it("forecastVolatility chooses HAR-X, reports BOTH R²s and the delta", () => {
    const f = forecastVolatility(bars, vix);
    expect(f.method).toBe("HAR-X");
    expect(f.r2OutOfSampleHar).not.toBeNull();
    expect(f.r2OutOfSampleHarX).not.toBeNull();
    expect(f.vixDeltaR2).not.toBeNull();
    expect(f.vixDeltaR2!).toBeCloseTo(f.r2OutOfSampleHarX! - f.r2OutOfSampleHar!, 3);
    expect(f.vixDeltaR2!).toBeGreaterThan(0);
    expect(f.r2OutOfSample).toBe(f.r2OutOfSampleHarX); // headline = chosen model
    expect(f.betas).toHaveLength(5);
    expect(f.forecast1dVolPct).not.toBeNull();
    expect(f.note).toContain("HAR-X WON out-of-sample");
  });
});

describe("HAR-X fallback when the VIX adds nothing (V10 B2)", () => {
  const closes = ar1VolCloses(900, 42); // vol NOT driven by any external index
  const bars = barsFromCloses(closes);

  it("no VIX series supplied → plain HAR, X fields honestly null", () => {
    const f = forecastVolatility(bars);
    expect(f.method).toBe("HAR");
    expect(f.r2OutOfSampleHarX).toBeNull();
    expect(f.vixDeltaR2).toBeNull();
    expect(f.betas).toHaveLength(4);
    expect(f.note).toContain("no India VIX series supplied");
  });

  it("constant VIX (zero variance) → HAR-X unfittable → plain HAR, stated", () => {
    const constantVix = bars.map((b) => ({ date: b.date, close: 15 }));
    const f = forecastVolatility(bars, constantVix);
    expect(f.method).toBe("HAR");
    expect(f.r2OutOfSampleHarX).toBeNull();
    expect(f.note).toContain("could not be fit");
  });

  it("a NOISE regressor never overrides the measured OOS winner rule", () => {
    // Deterministic noise VIX, unrelated to this series' vol: whichever model
    // wins out-of-sample MUST be the one the forecast uses.
    const rand = mulberry32(99);
    const noiseVix = bars.map((b) => ({ date: b.date, close: 12 + rand() * 10 }));
    const f = forecastVolatility(bars, noiseVix);
    expect(f.r2OutOfSampleHar).not.toBeNull();
    expect(f.r2OutOfSampleHarX).not.toBeNull();
    const expected = f.r2OutOfSampleHarX! > f.r2OutOfSampleHar! ? "HAR-X" : "HAR";
    expect(f.method).toBe(expected);
    expect(f.r2OutOfSample).toBe(
      expected === "HAR-X" ? f.r2OutOfSampleHarX : f.r2OutOfSampleHar
    );
  });
});
