/**
 * Web knowledge, pinned: the LLM cannot cite a URL it was not given, enums are
 * enforced, impossible dates are dropped, and the news study cannot pass
 * before its pre-registered sample threshold.
 */
import { netSentiment, validateFacts } from "../src/services/knowledge/newsFacts";
import { NEWS_RULE, newsStats } from "../src/services/research/newsSignalStudy";

const allowed = new Set(["https://a.example/1", "https://b.example/2"]);
const good = { kind: "RESULTS", fact: "Q2 FY27 net profit rose 23% YoY to ₹1,633 crore on 15% loan growth.", sentiment: "POSITIVE", materiality: "HIGH", eventDate: "2026-10-05", sourceUrl: "https://a.example/1" };

describe("validateFacts", () => {
  it("keeps a fact that cites a searched URL", () => {
    const r = validateFacts({ facts: [good] }, allowed, "2026-10-06", "2026-09-22");
    expect(r.kept).toHaveLength(1);
    expect(r.rejected).toBe(0);
  });

  it("rejects an invented source URL, bad enums, and too-short text", () => {
    const r = validateFacts(
      { facts: [{ ...good, sourceUrl: "https://made-up.example" }, { ...good, kind: "RUMOUR" }, { ...good, sentiment: "BULLISH" }, { ...good, fact: "Up." }] },
      allowed, "2026-10-06", "2026-09-22"
    );
    expect(r.kept).toHaveLength(0);
    expect(r.rejected).toBe(4);
  });

  it("drops future or out-of-window event dates to null instead of trusting them", () => {
    const r = validateFacts({ facts: [{ ...good, eventDate: "2026-12-01" }, { ...good, fact: good.fact + " Also deposits grew.", eventDate: "2025-01-01" }] }, allowed, "2026-10-06", "2026-09-22");
    expect(r.kept.map((f) => f.eventDate)).toEqual([null, null]);
  });

  it("refuses a non-array payload outright", () => {
    expect(() => validateFacts({ facts: "none" }, allowed, "2026-10-06", "2026-09-22")).toThrow(/schema violation/);
  });
});

describe("news signal", () => {
  it("weights sentiment by materiality", () => {
    expect(netSentiment([{ sentiment: "POSITIVE", materiality: "HIGH" }, { sentiment: "NEGATIVE", materiality: "LOW" }])).toBeCloseTo(0.5);
    expect(netSentiment([{ sentiment: "NEUTRAL", materiality: "LOW" }])).toBe(0);
  });

  it("does not judge before the pre-registered sample threshold, however good it looks", () => {
    const calls = Array.from({ length: 40 }, (_, i) => ({ symbol: `S${i}`, observedAt: `2026-10-${String((i % 5) + 1).padStart(2, "0")}`, score: i % 2 ? 1 : -1, relReturn: i % 2 ? 0.05 : -0.05 }));
    const s = newsStats(calls);
    expect(s.hitPct).toBe(100);
    expect(s.thresholdReached).toBe(false);
    expect(s.pass).toBeNull();
  });

  it("passes a genuine effect and fails noise once the threshold is met", () => {
    const mk = (effect: number) =>
      Array.from({ length: 200 }, (_, i) => {
        const score = i % 2 ? 1 : -1;
        const noise = Math.sin(i * 12.9898) * 0.03;
        return { symbol: `S${i}`, observedAt: `D${i % 25}`, score, relReturn: score * effect + noise };
      });
    expect(newsStats(mk(0.02)).pass).toBe(true);
    expect(newsStats(mk(0)).pass).toBe(false);
    expect(NEWS_RULE.minCalls).toBe(150);
  });
});
