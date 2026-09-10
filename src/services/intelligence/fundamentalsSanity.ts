/**
 * Sanity circuit-breaker (data-correctness middleware) — PURE.
 *
 * A scraped value that is physically impossible (unit-extraction error, a
 * mis-parsed cell) is DROPPED per-field rather than poisoning the panel. We
 * drop the offending field and keep the good ones — throwing away a whole
 * record because one cell was garbage would lose correct data.
 */

import { ScrapedRatios, RATIO_FIELDS } from "./providers/fundamentalsTypes";

/** Plausible [min, max] per field; a value outside is discarded. */
const BOUNDS: Record<keyof ScrapedRatios, [number, number]> = {
  peRatio: [0, 1000], // negative/absent P/E is meaningless; >1000 is a parse error
  roe: [-100, 200],
  roce: [-100, 300],
  currentRatio: [0, 50], // >50 ⇒ Cr-vs-Lakh unit error
  bookValue: [0, 5_000_000],
  dividendYield: [0, 50],
  marketCap: [0.01, 100_000_000], // ₹ crore
  faceValue: [0, 10_000],
  currentPrice: [0.01, 5_000_000],
  debtToEquity: [0, 100],
  priceToBook: [0, 500],
  promoterHolding: [0, 100],
  operatingMargin: [-200, 100],
  quarterlyProfitGrowthYoY: [-2000, 5000],
  promoterHoldingChangeQoQ: [-100, 100],
};

export interface SanityResult {
  clean: Partial<ScrapedRatios>;
  rejected: Array<{ field: keyof ScrapedRatios; value: number; reason: string }>;
}

export function sanitizeRatios(input: Partial<ScrapedRatios>): SanityResult {
  const clean: Partial<ScrapedRatios> = {};
  const rejected: SanityResult["rejected"] = [];
  for (const field of RATIO_FIELDS) {
    const v = input[field];
    if (v == null) continue;
    if (!Number.isFinite(v)) {
      rejected.push({ field, value: v as number, reason: "not a finite number" });
      continue;
    }
    const [min, max] = BOUNDS[field];
    if (v < min || v > max) {
      rejected.push({ field, value: v, reason: `outside plausible [${min}, ${max}] — likely a unit/parse error` });
      continue;
    }
    clean[field] = v;
  }
  return { clean, rejected };
}

/**
 * Cross-field contradiction checks (the reviewer's circuit breaker): flags a
 * record whose fields are mutually inconsistent, e.g. a positive P/E with a
 * clearly-negative ROE. Returns the fields to additionally drop.
 */
export function crossFieldContradictions(r: Partial<ScrapedRatios>): Array<keyof ScrapedRatios> {
  const drop: Array<keyof ScrapedRatios> = [];
  // A positive trailing P/E requires positive trailing earnings ⇒ ROE should
  // not be materially negative. If both present and contradictory, the P/E is
  // the less trustworthy scrape (ROE is computed from statements) — drop it.
  if (r.peRatio != null && r.peRatio > 0 && r.roe != null && r.roe < -1) drop.push("peRatio");
  // Promoter holding change can't exceed the holding itself.
  if (r.promoterHoldingChangeQoQ != null && r.promoterHolding != null && Math.abs(r.promoterHoldingChangeQoQ) > r.promoterHolding + 1) drop.push("promoterHoldingChangeQoQ");
  return drop;
}
