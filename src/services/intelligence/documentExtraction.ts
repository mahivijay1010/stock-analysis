import { ExtractedEvidence } from "./types";

const VALUE_PATTERN = "(?:₹|Rs\\.?|INR|US\\$|USD)?\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*(crore|cr|lakh|million|mn|billion|bn)?";

function numeric(raw: string, scale?: string): number {
  const n = Number(raw.replace(/,/g, ""));
  const s = (scale ?? "").toLowerCase();
  if (s === "crore" || s === "cr") return n * 10_000_000;
  if (s === "lakh") return n * 100_000;
  if (s === "million" || s === "mn") return n * 1_000_000;
  if (s === "billion" || s === "bn") return n * 1_000_000_000;
  return n;
}

function currency(excerpt: string): string | null {
  if (/US\$|USD/i.test(excerpt)) return "USD";
  if (/₹|\bRs\.?\b|\bINR\b/i.test(excerpt)) return "INR";
  return null;
}

function asOfDate(excerpt: string): string | null {
  const iso = excerpt.match(/\b(20\d{2})[-/]([01]?\d)[-/]([0-3]?\d)\b/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const month = excerpt.match(/\b(?:as (?:of|on|at)\s+)?([0-3]?\d)\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(20\d{2})\b/i);
  if (!month) return null;
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  return `${month[3]}-${String(months.indexOf(month[2].slice(0, 3).toLowerCase()) + 1).padStart(2, "0")}-${month[1].padStart(2, "0")}`;
}

function excerpts(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z₹])/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 20 && x.length <= 1000);
}

function matchValue(sentence: string, keyword: RegExp): { value: number; rawScale?: string } | null {
  const forward = sentence.match(new RegExp(`${keyword.source}.{0,100}?${VALUE_PATTERN}`, "i"));
  const backward = sentence.match(new RegExp(`${VALUE_PATTERN}.{0,100}?${keyword.source}`, "i"));
  const match = forward ?? backward;
  if (!match) return null;
  // Capture positions differ because the keyword may itself have captures; all
  // extraction keywords below are non-capturing. First two captures are value/scale.
  const raw = match[1];
  const scale = match[2];
  if (!raw) return null;
  return { value: numeric(raw, scale), rawScale: scale };
}

function pushEvidence(
  out: ExtractedEvidence[],
  sentence: string,
  category: ExtractedEvidence["category"],
  label: string,
  sourceUrl: string,
  keyword: RegExp,
  status: "EXTRACTED" | "ESTIMATED" = "EXTRACTED"
): void {
  const matched = matchValue(sentence, keyword);
  if (!matched) return;
  out.push({
    category,
    label,
    value: matched.value,
    currency: currency(sentence),
    asOfDate: asOfDate(sentence),
    excerpt: sentence,
    sourceUrl,
    status,
    confidence: currency(sentence) && matched.rawScale ? "HIGH" : "MEDIUM",
    metadata: { reportedScale: matched.rawScale ?? null },
  });
}

/** Conservative evidence extraction. Order book and order inflow stay distinct. */
export function extractDocumentEvidence(text: string, sourceUrl: string): ExtractedEvidence[] {
  const out: ExtractedEvidence[] = [];
  for (const sentence of excerpts(text)) {
    if (/\b(?:order book|order backlog|unexecuted orders|backlog)\b/i.test(sentence) &&
        !/\b(?:order inflow|order intake|new orders received)\b/i.test(sentence)) {
      pushEvidence(out, sentence, "ORDER_BOOK", "Order book", sourceUrl, /(?:order book|order backlog|unexecuted orders|backlog)/i);
    }
    if (/\b(?:order inflow|order intake|new orders received)\b/i.test(sentence)) {
      pushEvidence(out, sentence, "ORDER_INFLOW", "Order inflow", sourceUrl, /(?:order inflow|order intake|new orders received)/i);
    }
    if (/\b(?:planned|plan(?:s|ned)?|approved|announced|expects?|will invest)\b.{0,80}\b(?:capex|capital expenditure)\b|\b(?:capex|capital expenditure)\b.{0,80}\b(?:planned|approved|guidance|programme|program)\b/i.test(sentence)) {
      pushEvidence(out, sentence, "PLANNED_CAPEX", "Planned capital expenditure", sourceUrl, /(?:capex|capital expenditure)/i);
    } else if (/\b(?:capex|capital expenditure|purchase of property plant and equipment)\b/i.test(sentence)) {
      pushEvidence(out, sentence, "HISTORICAL_CAPEX", "Historical capital expenditure", sourceUrl, /(?:capex|capital expenditure|purchase of property plant and equipment)/i);
    }
    if (/\b(?:capacity addition|installed capacity|capacity expansion)\b/i.test(sentence)) {
      pushEvidence(out, sentence, "CAPACITY", "Capacity", sourceUrl, /(?:capacity addition|installed capacity|capacity expansion)/i);
    }
    if (/\b(?:total addressable market|addressable market|market size|TAM)\b/i.test(sentence)) {
      pushEvidence(out, sentence, "TAM", "Industry TAM", sourceUrl, /(?:total addressable market|addressable market|market size|TAM)/i, "ESTIMATED");
    }
  }
  return out.filter((e, i, a) => a.findIndex((x) =>
    x.category === e.category && x.value === e.value && x.excerpt === e.excerpt
  ) === i);
}
