/**
 * Entry-quality v2 tests (risk-spec Rule 7, 16) — extension and valuation
 * penalties that generalize the BHEL failure shape. No action vocabulary.
 */

import { assessEntryQuality, EntryQualityInputs } from "../src/services/framework/entryQuality";
import { QuantAnalysis } from "../src/services/quant/types";
import { Fundamentals } from "../src/services/market/types";

const calmTechnicals = (over?: Partial<QuantAnalysis["technicals"]>): QuantAnalysis["technicals"] => ({
  rsi14: 55,
  macd: null,
  sma20: 100,
  sma50: 98,
  sma200: 92,
  bollinger: null,
  atr14: 2,
  annualVolatilityPct: 22,
  week52: { high: 110, low: 80, positionPct: 65 },
  volumeRatio20d: 1.0,
  returns: { r5dPct: 1, r20dPct: 3, r60dPct: 8 },
  ...over,
});

const richNoGrowth: Partial<Fundamentals> = {
  trailingPE: 52,
  pegRatio: 3.1,
  earningsGrowthPct: null,
};

const inputs = (over?: Partial<EntryQualityInputs>): EntryQualityInputs => ({
  baseTimingScore: 60,
  price: 101,
  technicals: calmTechnicals(),
  fundamentals: null,
  intervalWidthPct30: 12,
  rewardRiskRatio: 1.2,
  ...over,
});

describe("assessEntryQuality v2", () => {
  test("calm, un-extended setup keeps its base score (minus the no-fundamentals note)", () => {
    const q = assessEntryQuality(inputs());
    expect(q.score).toBe(56); // 60 − 4 (no fundamentals)
    expect(q.label).toBe("neutral");
  });

  test("owns no action vocabulary — labels only", () => {
    const q = assessEntryQuality(inputs());
    expect(["attractive", "neutral", "unattractive", "unknown"]).toContain(q.label);
    expect(JSON.stringify(q)).not.toMatch(/BUY|SELL|TODAY/);
  });

  test("THE GENERALIZED BHEL SHAPE: extended near 52w-high after a rally, high vol, expensive without growth → unattractive", () => {
    // price 431: 61 above SMA50 (370) with ATR 12 ⇒ 5.1 ATRs (−10); 25%+ above
    // SMA200 (330) (−6); 95th pct of 52w range after +25% in 60d (−12); vol 36
    // (not >45, no vol-spike penalty); expensive PE with NO growth data (−10);
    // wide interval 20% (−6); reward/risk 0.9 (−10).
    const q = assessEntryQuality(
      inputs({
        baseTimingScore: 62, // v1 said "TIMING_OK" at exactly this score
        price: 431,
        technicals: calmTechnicals({
          sma50: 370,
          sma200: 330,
          atr14: 12,
          annualVolatilityPct: 36,
          week52: { high: 440, low: 200, positionPct: 95 },
          returns: { r5dPct: 4, r20dPct: 12, r60dPct: 25 },
        }),
        fundamentals: richNoGrowth as Fundamentals,
        intervalWidthPct30: 20,
        rewardRiskRatio: 0.9,
      })
    );
    expect(q.score).toBeLessThan(40);
    expect(q.label).toBe("unattractive");
    const reasons = q.adjustments.map((a) => a.reason).join(" | ");
    expect(reasons).toMatch(/extended/);
    expect(reasons).toMatch(/52-week range .* chasing strength/);
    expect(reasons).toMatch(/NO earnings-growth evidence/);
    expect(reasons).toMatch(/reward\/risk 0\.90 < 1/);
  });

  test("severe extension penalized harder than mild", () => {
    const mild = assessEntryQuality(inputs({ price: 108, technicals: calmTechnicals({ sma50: 98, atr14: 2 }) })); // 5 ATRs
    const severe = assessEntryQuality(inputs({ price: 118, technicals: calmTechnicals({ sma50: 98, atr14: 2 }) })); // 10 ATRs
    expect(severe.score!).toBeLessThan(mild.score!);
  });

  test("missing growth data is NOT neutral: expensive + missing growth is penalized like expensive + weak growth", () => {
    const missing = assessEntryQuality(inputs({ fundamentals: { trailingPE: 52, earningsGrowthPct: null } as Fundamentals }));
    const weak = assessEntryQuality(inputs({ fundamentals: { trailingPE: 52, earningsGrowthPct: 4 } as Fundamentals }));
    expect(missing.score).toBe(weak.score);
    expect(missing.adjustments.map((a) => a.reason).join(" ")).toMatch(/missing data is not neutral/i);
  });

  test("good reward/risk earns a small credit; fading-volume rallies are flagged", () => {
    const goodRr = assessEntryQuality(inputs({ rewardRiskRatio: 1.8 }));
    expect(goodRr.adjustments.some((a) => a.delta === 5)).toBe(true);
    const fading = assessEntryQuality(
      inputs({ technicals: calmTechnicals({ volumeRatio20d: 0.5, returns: { r5dPct: 3, r20dPct: 10, r60dPct: 22 } }) })
    );
    expect(fading.adjustments.map((a) => a.reason).join(" ")).toMatch(/fading volume/);
  });

  test("no base score and no technicals → unknown, never a guess", () => {
    const q = assessEntryQuality(
      inputs({ baseTimingScore: null, technicals: calmTechnicals({ sma50: null, atr14: null }) })
    );
    expect(q.score).toBeNull();
    expect(q.label).toBe("unknown");
  });
});
