/**
 * Turning search results into knowledge-base facts — the validation half is
 * PURE and unit-tested, because this is where an LLM could otherwise smuggle
 * an invented fact into the record.
 *
 * Rules enforced in code (not just asked for in the prompt):
 *  - every fact must cite a sourceUrl that was IN the search results;
 *  - kind / sentiment / materiality must be from the fixed enums;
 *  - the fact text must be non-trivial and under a length cap;
 *  - an eventDate, if given, must be a real date no later than today and no
 *    earlier than the search window allows (else it is dropped to null);
 *  - at most MAX_FACTS per stock per run.
 * Anything failing is discarded, never "repaired".
 */
import { strictSchema } from "../reasoning/roles";

export const NEWS_FACT_VERSION = "news-facts-v1";
export const FACT_KINDS = ["RESULTS", "GUIDANCE", "ORDER_WIN", "CORPORATE_ACTION", "OWNERSHIP", "REGULATORY", "LEGAL", "MANAGEMENT", "RATING", "BUSINESS", "MACRO_SECTOR", "PRICE_CONTEXT", "OTHER"] as const;
export const SENTIMENTS = ["POSITIVE", "NEGATIVE", "NEUTRAL", "MIXED"] as const;
export const MATERIALITY = ["HIGH", "MEDIUM", "LOW"] as const;
export const MAX_FACTS = 5;

export type FactKind = (typeof FACT_KINDS)[number];
export type Sentiment = (typeof SENTIMENTS)[number];
export type Materiality = (typeof MATERIALITY)[number];

export interface StructuredFact {
  kind: FactKind;
  fact: string;
  sentiment: Sentiment;
  materiality: Materiality;
  eventDate: string | null;
  sourceUrl: string;
}

export const NEWS_FACT_SCHEMA = strictSchema("news_facts", {
  facts: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: [...FACT_KINDS] },
        fact: { type: "string" },
        sentiment: { type: "string", enum: [...SENTIMENTS] },
        materiality: { type: "string", enum: [...MATERIALITY] },
        eventDate: { type: ["string", "null"] },
        sourceUrl: { type: "string" },
      },
      required: ["kind", "fact", "sentiment", "materiality", "eventDate", "sourceUrl"],
    },
  },
});

export function factSystemPrompt(): string {
  return [
    "You extract dated, verifiable facts about ONE listed Indian company from web search results.",
    "Use ONLY the titles/descriptions given. Never add numbers, events or dates that are not in them.",
    "Each fact: one or two sentences, specific (numbers, dates, counterparties), about THIS company only.",
    "sourceUrl MUST be copied exactly from the result the fact came from.",
    "sentiment is for the company's shareholders: POSITIVE, NEGATIVE, NEUTRAL or MIXED. Price-move recaps with no cause are PRICE_CONTEXT/NEUTRAL.",
    "materiality: HIGH = could plausibly change earnings or ownership (results, large orders, regulatory action, stake sales); LOW = routine filings, trading-window notices, AGM notices.",
    "eventDate: YYYY-MM-DD if the text states when it happened, else null.",
    `Return at most ${MAX_FACTS} facts; return an empty list if nothing is about this company. Skip generic stock-price pages and listicles.`,
  ].join("\n");
}

export function factUserPrompt(symbol: string, company: string, results: Array<{ url: string; title: string; description: string }>): string {
  return JSON.stringify({ symbol, company, results: results.map((r, i) => ({ id: i + 1, url: r.url, title: r.title, description: r.description })) });
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Validate the model's output against the search it was given. PURE. */
export function validateFacts(raw: unknown, allowedUrls: Set<string>, today: string, earliest: string): { kept: StructuredFact[]; rejected: number } {
  const arr = (raw as { facts?: unknown })?.facts;
  if (!Array.isArray(arr)) throw new Error("news facts schema violation: facts is not an array");
  const kept: StructuredFact[] = [];
  let rejected = 0;
  const seen = new Set<string>();
  for (const f of arr as Array<Record<string, unknown>>) {
    const fact = typeof f?.fact === "string" ? f.fact.trim() : "";
    const ok =
      FACT_KINDS.includes(f?.kind as FactKind) &&
      SENTIMENTS.includes(f?.sentiment as Sentiment) &&
      MATERIALITY.includes(f?.materiality as Materiality) &&
      typeof f?.sourceUrl === "string" &&
      allowedUrls.has(f.sourceUrl as string) &&
      fact.length >= 25 &&
      fact.length <= 600 &&
      !seen.has(fact.toLowerCase());
    if (!ok || kept.length >= MAX_FACTS) {
      rejected++;
      continue;
    }
    seen.add(fact.toLowerCase());
    let eventDate = typeof f.eventDate === "string" && ISO.test(f.eventDate) ? (f.eventDate as string) : null;
    if (eventDate && (eventDate > today || eventDate < earliest || Number.isNaN(Date.parse(eventDate)))) eventDate = null;
    kept.push({ kind: f.kind as FactKind, fact, sentiment: f.sentiment as Sentiment, materiality: f.materiality as Materiality, eventDate, sourceUrl: f.sourceUrl as string });
  }
  return { kept, rejected };
}

/** Net sentiment score for one stock-day: materiality-weighted, in [-1, 1]. PURE. */
export function netSentiment(facts: Array<{ sentiment: string; materiality: string }>): number | null {
  const w: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };
  const s: Record<string, number> = { POSITIVE: 1, NEGATIVE: -1, NEUTRAL: 0, MIXED: 0 };
  let num = 0;
  let den = 0;
  for (const f of facts) {
    const wt = w[f.materiality] ?? 0;
    num += wt * (s[f.sentiment] ?? 0);
    den += wt;
  }
  return den > 0 ? num / den : null;
}
