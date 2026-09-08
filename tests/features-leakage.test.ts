/**
 * Phase 3 tests (completion directive) — zero-lookahead feature engineering.
 * Includes the HARD leakage test: mutating bars AFTER the as-of index must
 * not change a single feature value, and every feature's availableAt must be
 * ≤ the prediction timestamp.
 */

import { assertNoLookahead, buildFeatures, FEATURE_VERSION, sessionCloseIso } from "../src/services/research/features";
import { Bar } from "../src/services/market/types";

function mkBars(n: number, start = 100): Bar[] {
  const bars: Bar[] = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    price *= 1 + 0.01 * Math.sin(i / 5) + (i % 7 === 0 ? -0.008 : 0.003);
    const d = new Date(Date.UTC(2024, 0, 1 + Math.floor(i * 1.4)));
    bars.push({
      date: d.toISOString().slice(0, 10),
      open: price * 0.995,
      high: price * 1.01,
      low: price * 0.99,
      close: price,
      volume: 1_000_000 + (i % 11) * 50_000,
      adjustedClose: price,
    });
  }
  return bars;
}

describe("buildFeatures — zero lookahead", () => {
  const bars = mkBars(300);
  const asOf = 250;

  test("HARD LEAKAGE TEST: features at index i are invariant to ANY future-bar mutation", () => {
    const before = buildFeatures("TEST.NS", bars, asOf);
    const mutated = bars.map((b, idx) =>
      idx > asOf ? { ...b, close: b.close * 5, open: 1, high: 9999, low: 0.01, volume: 0, adjustedClose: 0.5 } : b
    );
    const after = buildFeatures("TEST.NS", mutated, asOf);
    expect(after).toEqual(before);
  });

  test("every feature's availableAt ≤ predictionTimestamp (assertNoLookahead passes)", () => {
    const fv = buildFeatures("TEST.NS", bars, asOf, { nifty: mkBars(300, 20000), vix: mkBars(300, 14) });
    expect(() => assertNoLookahead(fv)).not.toThrow();
    expect(fv.predictionTimestamp).toBe(sessionCloseIso(bars[asOf].date));
    expect(fv.featureVersion).toBe(FEATURE_VERSION);
  });

  test("assertNoLookahead THROWS on a violated timestamp", () => {
    const fv = buildFeatures("TEST.NS", bars, asOf);
    fv.features["ret_1d"] = { value: 0.01, availableAt: "2099-01-01T00:00:00+05:30" };
    expect(() => assertNoLookahead(fv)).toThrow(/LOOKAHEAD LEAK/);
  });

  test("market features use only NIFTY/VIX sessions ≤ the as-of date, with their own availableAt", () => {
    // NIFTY series extends BEYOND the stock's as-of date — must be filtered out.
    const nifty = mkBars(300, 20000);
    const fv = buildFeatures("TEST.NS", bars, 100, { nifty });
    const used = fv.features["nifty_ret_20d"];
    expect(used.availableAt <= fv.predictionTimestamp).toBe(true);
  });

  test("missing context ⇒ null features, never fabricated", () => {
    const fv = buildFeatures("TEST.NS", bars, asOf);
    expect(fv.features["vix_level"].value).toBeNull();
    expect(fv.features["sector_ret_20d_pct"].value).toBeNull();
  });

  test("missing volume ⇒ null volume ratio (Phase 1 honesty carried through)", () => {
    const zeroVol = bars.map((b) => ({ ...b, volume: 0 }));
    const fv = buildFeatures("TEST.NS", zeroVol, asOf);
    expect(fv.features["volume_ratio_20d"].value).toBeNull();
  });

  test("out-of-range asOfIndex throws — never silently substitutes a day", () => {
    expect(() => buildFeatures("TEST.NS", bars, bars.length)).toThrow(/out of range/);
    expect(() => buildFeatures("TEST.NS", bars, -1)).toThrow(/out of range/);
  });

  test("features come from the ADJUSTED series (split does not fabricate a return feature)", () => {
    const split: Bar[] = mkBars(100).map((b, i) => ({
      ...b,
      close: i >= 50 ? b.close / 5 : b.close,
      adjustedClose: b.adjustedClose, // continuous
    }));
    const fv = buildFeatures("TEST.NS", split, 51);
    expect(Math.abs(fv.features["ret_1d"].value ?? 99)).toBeLessThan(0.05);
  });
});
