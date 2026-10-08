/** Broad scanner stage-1 features, signals, leakage, research priority, AI grounding, and the no-bypass guarantee. */
import { computeStageOneFeatures, detectSignals, liquidityScore, riskScore, SeriesPoint, technicalScore } from "../src/services/universe/opportunityFeatures";
import { researchPriority } from "../src/services/universe/researchPriority";
import { validateStatements } from "../src/services/universe/AiResearchService";
import { buildCapitalPlan } from "../src/services/capital/capitalAllocation";
import { resolveRiskProfile } from "../src/services/capital/riskProfiles";
import { CapitalCandidateInput } from "../src/services/capital/types";

function series(n: number, start = 100, drift = 0.001, seed = 7): SeriesPoint[] {
  let x = seed, px = start;
  const out: SeriesPoint[] = [];
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const noise = (x / 2147483648 - 0.5) * 0.02;
    px = px * (1 + drift + noise);
    const d = new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    out.push({ date: d, close: Math.round(px * 100) / 100, volume: 100000 + (x % 50000), valueInr: px * 100000, delivPct: 40 + (x % 30) });
  }
  return out;
}

describe("stage-one features", () => {
  test("needs 60 sessions; computes trend, 52w position, volatility, close-only ATR proxy", () => {
    const s = series(260);
    expect(computeStageOneFeatures(s.slice(0, 40), s[39].date, null)).toBeNull();
    const f = computeStageOneFeatures(s, s[s.length - 1].date, null);
    expect(f).not.toBeNull();
    expect(f!.sessions).toBe(260);
    expect(["UP", "DOWN", "SIDEWAYS", "UNKNOWN"]).toContain(f!.trend);
    expect(f!.pos52wPct).toBeGreaterThanOrEqual(0);
    expect(f!.pos52wPct).toBeLessThanOrEqual(100);
    expect(f!.atrProxyPct).toBeGreaterThan(0);
    expect(f!.closeOnly).toBe(true);
    expect(f!.relNifty20Pct).toBeNull();
  });
  test("NO future leakage: a series with points after asOf is refused; points on/before asOf only", () => {
    const s = series(120);
    expect(() => computeStageOneFeatures(s, s[100].date, null)).toThrow(/leakage/);
    const f = computeStageOneFeatures(s.slice(0, 101), s[100].date, null);
    expect(f!.asOf).toBe(s[100].date);
    expect(f!.price).toBe(s[100].close);
  });
  test("stale series (last point before asOf) still computes but reports its real asOf", () => {
    const s = series(120);
    const f = computeStageOneFeatures(s, "2026-12-31", null);
    expect(f!.asOf).toBe(s[119].date);
  });
  test("relative strength uses NIFTY on the same dates", () => {
    const s = series(120, 100, 0.002);
    const nifty = new Map(s.map((p) => [p.date, 100]));
    const f = computeStageOneFeatures(s, s[119].date, nifty);
    expect(f!.relNifty20Pct).toBeCloseTo(f!.r20Pct, 1);
  });
  test("signals: breakout needs volume; pullback needs an uptrend; unusual volume at 2.5×", () => {
    const s = series(260, 100, 0.003);
    const f = computeStageOneFeatures(s, s[259].date, null)!;
    const sig = detectSignals({ ...f, breakout55: true, volumeRatio20: 1.5 });
    expect(sig).toContain("BREAKOUT");
    expect(detectSignals({ ...f, breakout55: true, volumeRatio20: 1.0 })).not.toContain("BREAKOUT");
    expect(detectSignals({ ...f, trend: "DOWN", pullbackFrom20dHighPct: -4, distSma20Pct: 1 })).not.toContain("PULLBACK");
    expect(detectSignals({ ...f, volumeRatio20: 3 })).toContain("UNUSUAL_VOLUME");
  });
  test("scores are bounded 0–100 and descriptive", () => {
    const f = computeStageOneFeatures(series(260), "2026-12-31", null)!;
    for (const v of [technicalScore(f), riskScore(f), liquidityScore(f.medianValue20Inr, f.delivPct20)]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
    expect(liquidityScore(1e9, 70)).toBe(100);
    expect(liquidityScore(1e6, null)).toBe(0);
  });
});

describe("research priority", () => {
  const base = { symbol: "X", signals: [] as string[], technicalScore: 50, liquidityTier: "B", stageReached: "TECHNICAL", newsFacts30d: 0, majorNews: false, resultsDue: false, corporateAction: false, onWatchlist: false, regime: "TREND_UP", setupType: null, setupHasEvidence: false, lastResearchedDaysAgo: null };
  test("watchlist, major news, unusual volume and passed gates raise priority; reasons are named", () => {
    const quiet = researchPriority(base).priority;
    const hot = researchPriority({ ...base, signals: ["UNUSUAL_VOLUME", "BREAKOUT"], majorNews: true, onWatchlist: true, stageReached: "RISK" });
    expect(hot.priority).toBeGreaterThan(quiet + 50);
    expect(hot.reasons).toEqual(expect.arrayContaining(["unusual volume", "major news", "on watchlist", "passed decision gates"]));
  });
  test("regime fit and stale research add; never-researched gets a small bonus", () => {
    const a = researchPriority({ ...base, setupType: "PULLBACK_IN_UPTREND" }).priority;
    const b = researchPriority({ ...base, setupType: "PULLBACK_IN_UPTREND", regime: "TREND_DOWN" }).priority;
    expect(a).toBeGreaterThan(b);
    expect(researchPriority({ ...base, lastResearchedDaysAgo: 28 }).priority).toBeGreaterThan(researchPriority({ ...base, lastResearchedDaysAgo: 1 }).priority);
  });
});

describe("AI research grounding", () => {
  const evidence = [
    { id: "E1", section: "fundamentals", statement: "ROE % 8.91", value: 8.91, source: "screener", sourceUrl: null, asOf: "2026-09-23", kind: "FACT" as const },
    { id: "E2", section: "market", statement: "Close 1207.7 on 2026-10-07; 20d -7.77%", value: 1207.7, source: "nse", sourceUrl: null, asOf: "2026-10-07", kind: "FACT" as const },
  ];
  test("keeps cited, number-consistent statements; drops uncited, unknown-id, invented-number, banned and non-conditional hypotheses", () => {
    const { kept, dropped } = validateStatements(
      [
        { kind: "FACT", text: "ROE is 8.91%.", cites: ["E1"] },
        { kind: "INFERENCE", text: "The 20-day decline of 7.77% with ROE 8.91 reads as weak.", cites: ["E1", "E2"] },
        { kind: "HYPOTHESIS", text: "The pullback may offer a setup if price holds above 1207.7.", cites: ["E2"] },
        { kind: "FACT", text: "Revenue grew 18%.", cites: ["E1"] },
        { kind: "INFERENCE", text: "Looks fine.", cites: [] },
        { kind: "FACT", text: "Something.", cites: ["E9"] },
        { kind: "HYPOTHESIS", text: "This will rise.", cites: ["E2"] },
        { kind: "HYPOTHESIS", text: "A rebound is coming.", cites: ["E2"] },
      ],
      evidence
    );
    expect(kept.map((k) => k.kind)).toEqual(["FACT", "INFERENCE", "HYPOTHESIS"]);
    expect(dropped).toHaveLength(5);
    expect(dropped.join(" ")).toMatch(/introduces numbers not in evidence \(18\)/);
    expect(dropped.join(" ")).toMatch(/banned wording/);
    expect(dropped.join(" ")).toMatch(/not phrased conditionally/);
  });
});

describe("expanding the universe does NOT bypass the gates", () => {
  const broad = (over: Partial<CapitalCandidateInput> = {}): CapitalCandidateInput => ({
    ticker: "GLAND.NS", name: "Gland", sector: "Pharma", currentPrice: 100, action: "SETUP_DETECTED", tier: "C", qualified: false, modelHealth: "SHADOW", freshnessV2: "EOD_FINAL",
    setupType: "BREAKOUT_CONFIRMATION", rank: null, rankingScore: 90, gateFailures: [{ gate: "expected value", current: "0.1%", required: "≥0.25%" }], ceilingReasons: ["model SHADOW"], whyNotEntry: ["EV lower bound ≤ 0"],
    plan: { entryType: "BREAKOUT_TRIGGER", entryZoneLow: null, entryZoneHigh: null, entryTriggerPrice: 101, initialStop: 95, target1: 112, target2: null, target3: null, rewardRiskToTarget1: 1.9, expectedHoldingDays: 7, invalidationPrice: 94, invalidationReason: null, atr14: 2, advInr: 5e9, transactionCostPct: 0.3, estimatedSlippagePct: 0.2 },
    ev: { ev80LowerPct: -0.1, meanEvAfterCostsPct: 0.5, expectedR: 0.2 }, setupEvidence: { evidenceStrength: "C", usableForEntry: false }, probability: { status: "UNCALIBRATED", targetBeforeStop: null }, relVolume: 3, tradeability: { tradeable: true, hardBlocks: [] }, aiCapAction: null, evidenceScore: 95, decisionSnapshotId: null,
    ...over,
  });
  const market = { regime: "TREND_UP", regimeReasons: [], breakerCanEnter: true, breakerReason: null, freshness: { quoteTimestamp: null, quoteType: "EOD_FINAL" as const, marketState: "CLOSED" as const, latestCompletedBarDate: "2026-10-07", providerDelay: "", featureCutoffAt: null } };
  test("a broad-scan candidate with strong signals but SHADOW health / tier C / negative EV80 is never allocated", () => {
    const r = buildCapitalPlan({ asOf: "2026-10-08T00:00:00Z", capitalAvailableInr: 100000, holdings: [], candidates: [broad()], market, profile: resolveRiskProfile("AGGRESSIVE"), horizon: "5-10d" });
    expect(r.allocations).toHaveLength(0);
    expect(r.rejected[0].reasonCodes).toEqual(expect.arrayContaining(["EVIDENCE_TIER_INSUFFICIENT", "EV_LOWER_BOUND_NEGATIVE", "ENTRY_NOT_CONFIRMED"]));
  });
  test("even a tier-A, HEALTHY, positive-EV broad candidate needs the engine's ENTRY_CONFIRMED + qualified flag", () => {
    const r = buildCapitalPlan({ asOf: "2026-10-08T00:00:00Z", capitalAvailableInr: 100000, holdings: [], candidates: [broad({ tier: "A", modelHealth: "HEALTHY", ev: { ev80LowerPct: 0.4, meanEvAfterCostsPct: 1, expectedR: 0.3 }, gateFailures: [], action: "ZONE_REACHED" })], market, profile: resolveRiskProfile("AGGRESSIVE"), horizon: "5-10d" });
    expect(r.allocations).toHaveLength(0);
    expect(r.conditional).toHaveLength(1);
  });
  test("only the engine's own qualified + ENTRY_CONFIRMED verdict allocates", () => {
    const r = buildCapitalPlan({ asOf: "2026-10-08T00:00:00Z", capitalAvailableInr: 100000, holdings: [], candidates: [broad({ tier: "A", modelHealth: "HEALTHY", qualified: true, action: "ENTRY_CONFIRMED", ev: { ev80LowerPct: 0.4, meanEvAfterCostsPct: 1, expectedR: 0.3 }, gateFailures: [] })], market, profile: resolveRiskProfile("AGGRESSIVE"), horizon: "5-10d" });
    expect(r.allocations).toHaveLength(1);
  });
});
