import {
  aggregateHeadlineSentiment,
  headlineImpactWeight,
  lexiconSentiment,
} from "../src/services/market/NewsService";
import type { NewsItem } from "../src/types";
import { computeEntryTiming } from "../src/services/framework/entryTiming";

describe("finance headline sentiment", () => {
  test.each([
    "Radhika Jeweltech shares surge 18% after results",
    "Radhika Jeweltech Q1 profit up 74%",
    "Net profit rises to ₹7,479.01 lakh",
  ])("recognizes positive financial context: %s", (headline) => {
    expect(lexiconSentiment(headline)).toBeGreaterThanOrEqual(0.75);
  });

  test("does not treat the word profit as positive when profit falls", () => {
    expect(lexiconSentiment("Quarterly profit falls 42% as margins weaken")).toBeLessThan(0);
  });

  test("weights material earnings headlines above routine mentions", () => {
    expect(headlineImpactWeight("Q1 profit up 74% as revenue rises 20%")).toBeGreaterThan(
      headlineImpactWeight("Company shares in focus today")
    );
  });

  test("neutral boilerplate does not erase a positive Radhika research tape", () => {
    const makeItem = (title: string, ageHours: number): NewsItem => ({
      title,
      source: "test",
      publishedAt: new Date(0).toISOString(),
      url: "",
      sentiment: lexiconSentiment(title),
      ageHours,
      decayWeight: Math.pow(0.5, ageHours / (14 * 24)),
    });
    const items = [
      makeItem("Radhika Jeweltech Surges 18%", 720),
      makeItem("Q1 Profit Up 74%", 760),
      makeItem("Net Profit Rises to ₹7,479.01 Lakh", 800),
      makeItem("Radhika Jeweltech files annual report", 12),
      makeItem("Radhika Jeweltech share price today", 18),
    ];
    const aggregate = aggregateHeadlineSentiment(items);

    expect(aggregate.sentimentScore).toBe(60);
    expect(aggregate.hypeTemperature).toBe(16);
  });

  test("old positive context does not create a fresh-entry timing boost", () => {
    const result = computeEntryTiming({
      quantScore: 50,
      recommendation: "HOLD",
      rsi14: null,
      bollingerPercentB: null,
      regime: null,
      pop7d: null,
      expected1dPct: null,
      news: { sentimentScore: 80, hypeTemperature: 20, fresh24hCount: 0 },
    });

    expect(result.score).toBe(50);
    expect(result.reasons.join(" ")).not.toContain("Quietly positive news");
  });
});
