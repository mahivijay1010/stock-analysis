/**
 * V10 B1 — intelligenceQualityScore + rank pillar swap + rotation picker
 * (SPEC_V10 gate: "quality-score renormalization + <2-inputs null").
 */

import {
  intelligenceQualityScore,
  QUALITY_MIN_INPUTS,
} from "../src/services/quant/intelligenceQuality";
import { rankUniverse, RankInputRow } from "../src/services/quant/rank";
import {
  pickRotationCandidates,
  ROTATION_BATCH_SIZE,
  ROTATION_MIN_AGE_MS,
} from "../src/services/intelligenceRotation";

const NONE = {
  roic: null,
  fcf: null,
  revenue: null,
  currentRatio: null,
  peg: null,
};

describe("intelligenceQualityScore — <2 inputs → null (never fabricated)", () => {
  it("no inputs → null", () => {
    expect(intelligenceQualityScore({ ...NONE })).toBeNull();
  });

  it("exactly one signal (roic only) → null", () => {
    expect(intelligenceQualityScore({ ...NONE, roic: 25 })).toBeNull();
  });

  it("fcf WITHOUT revenue is a single signal → null", () => {
    expect(intelligenceQualityScore({ ...NONE, fcf: 1_000 })).toBeNull();
  });

  it("fcf WITH revenue yields two signals (fcf + fcf-margin) → scored", () => {
    const s = intelligenceQualityScore({ ...NONE, fcf: 10, revenue: 100 });
    expect(s).not.toBeNull();
    expect(s!.coverage).toEqual(["fcf", "fcf-margin"]);
    // fcf>0 → 1; margin 10% of the 20% full-score level → 0.5 ⇒ (1+0.5)/2 = 75
    expect(s!.score).toBe(75);
    expect(QUALITY_MIN_INPUTS).toBe(2);
  });
});

describe("intelligenceQualityScore — renormalization over available inputs", () => {
  it("two passing signals → 100 (weights renormalize, missing ones don't drag)", () => {
    const s = intelligenceQualityScore({ ...NONE, roic: 20, peg: 0.9 })!;
    expect(s.score).toBe(100);
    expect(s.coverage).toEqual(["roic", "peg"]);
  });

  it("two failing signals → 0", () => {
    const s = intelligenceQualityScore({ ...NONE, roic: 10, peg: 2.4 })!;
    expect(s.score).toBe(0);
  });

  it("mixed: roic pass, fcf fail, cr pass, peg fail → 50 over 4 signals", () => {
    const s = intelligenceQualityScore({
      roic: 20,
      fcf: -5,
      revenue: null, // negative-FCF margin signal needs revenue; omit it
      currentRatio: 1.5,
      peg: 2,
    })!;
    expect(s.coverage).toEqual(["roic", "fcf", "current-ratio", "peg"]);
    expect(s.score).toBe(50);
  });

  it("FCF-margin is graded and capped at the 20% level", () => {
    const half = intelligenceQualityScore({ ...NONE, fcf: 10, revenue: 100 })!; // 10% margin
    const full = intelligenceQualityScore({ ...NONE, fcf: 30, revenue: 100 })!; // 30% margin
    const zero = intelligenceQualityScore({ ...NONE, fcf: -10, revenue: 100 })!; // negative
    expect(half.score).toBe(75); // (1 + 0.5)/2
    expect(full.score).toBe(100); // (1 + 1)/2 — capped, not >100
    expect(zero.score).toBe(0); // (0 + 0)/2
  });

  it("PEG must be strictly between 0 and 1.5 to pass", () => {
    expect(intelligenceQualityScore({ ...NONE, roic: 20, peg: 1.49 })!.score).toBe(100);
    expect(intelligenceQualityScore({ ...NONE, roic: 20, peg: 1.5 })!.score).toBe(50);
    expect(intelligenceQualityScore({ ...NONE, roic: 20, peg: -0.5 })!.score).toBe(50);
  });
});

describe("intelligenceQualityScore — bank awareness (CR excluded, not missing)", () => {
  it("bank current ratio is EXCLUDED: identical to not having it", () => {
    const bank = intelligenceQualityScore({
      ...NONE,
      roic: 20,
      peg: 0.9,
      currentRatio: 0.4, // would FAIL if counted
      currentRatioNotMeaningful: true,
    })!;
    expect(bank.coverage).toEqual(["roic", "peg"]); // CR not in coverage
    expect(bank.score).toBe(100); // the failing-but-meaningless CR never dragged it
  });

  it("non-bank current ratio IS counted", () => {
    const s = intelligenceQualityScore({ ...NONE, roic: 20, currentRatio: 0.4 })!;
    expect(s.coverage).toEqual(["roic", "current-ratio"]);
    expect(s.score).toBe(50);
  });

  it("a bank with ONLY fcf+margin still scores (HDFCBANK shape)", () => {
    const s = intelligenceQualityScore({
      roic: null, // bank — not stored
      fcf: 50,
      revenue: 1000, // 5% margin → 0.25
      currentRatio: null,
      currentRatioNotMeaningful: true,
      peg: null,
    })!;
    expect(s.coverage).toEqual(["fcf", "fcf-margin"]);
    expect(s.score).toBe(Math.round(((1 + 0.25) / 2) * 100)); // 63
  });
});

describe("rank quality pillar swap (V10 B1)", () => {
  const rows: RankInputRow[] = [
    {
      ticker: "INTEL",
      momentum60d: 0.1,
      quality: 12, // fallback exists but must be IGNORED
      qualitySource: "roe",
      intelligenceQuality: { score: 80, coverage: ["roic", "fcf", "peg"] },
      sentimentDecay: null,
    },
    {
      ticker: "FALLBACK",
      momentum60d: 0.05,
      quality: 15,
      qualitySource: "operating-margin",
      intelligenceQuality: null,
      sentimentDecay: null,
    },
    {
      ticker: "NODATA",
      momentum60d: -0.02,
      quality: null,
      qualitySource: null,
      sentimentDecay: null,
    },
  ];
  const ranked = rankUniverse(rows);
  const by = (t: string) => ranked.find((r) => r.ticker === t)!;

  it("componentStatus.quality states the source per row", () => {
    expect(by("INTEL").componentStatus.quality).toBe("intelligence (3 inputs)");
    expect(by("FALLBACK").componentStatus.quality).toBe("quoteSummary fallback");
    expect(by("NODATA").componentStatus.quality).toBe("no-data");
  });

  it("qualitySource flips to 'intelligence' when the score is used", () => {
    expect(by("INTEL").qualitySource).toBe("intelligence");
    expect(by("FALLBACK").qualitySource).toBe("operating-margin");
    expect(by("NODATA").qualitySource).toBeNull();
  });

  it("the intelligence SCORE feeds the quality z (not the ignored fallback)", () => {
    // Cross-section values are [80, 15, null] → mean 47.5, σ 32.5:
    // z(INTEL) = +1, z(FALLBACK) = −1, z(NODATA) = 0.
    expect(by("INTEL").components.quality).toBeCloseTo(1, 3);
    expect(by("FALLBACK").components.quality).toBeCloseTo(-1, 3);
    expect(by("NODATA").components.quality).toBe(0);
  });
});

describe("pickRotationCandidates — the nightly 10-stalest rotation", () => {
  const now = new Date("2026-09-01T03:15:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000);

  it("never-stored tickers go first, then oldest; limit respected", () => {
    const rows = [
      { ticker: "A", lastStoredAt: hoursAgo(30) },
      { ticker: "B", lastStoredAt: null },
      { ticker: "C", lastStoredAt: hoursAgo(100) },
      { ticker: "D", lastStoredAt: null },
      { ticker: "E", lastStoredAt: hoursAgo(50) },
    ];
    expect(pickRotationCandidates(rows, now, 3)).toEqual(["B", "D", "C"]);
  });

  it("candidates refreshed <24h ago are skipped (not replaced)", () => {
    const rows = [
      { ticker: "FRESH", lastStoredAt: hoursAgo(2) },
      { ticker: "STALE", lastStoredAt: hoursAgo(25) },
    ];
    expect(pickRotationCandidates(rows, now, 2)).toEqual(["STALE"]);
    expect(ROTATION_MIN_AGE_MS).toBe(24 * 3600_000);
  });

  it("defaults to a 10-ticker batch and keeps universe order on ties", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      ticker: `T${i}`,
      lastStoredAt: null,
    }));
    const picks = pickRotationCandidates(rows, now);
    expect(picks).toHaveLength(ROTATION_BATCH_SIZE);
    expect(picks).toEqual(rows.slice(0, 10).map((r) => r.ticker));
  });
});
