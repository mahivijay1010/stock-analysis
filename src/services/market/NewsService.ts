/**
 * Module N1 — NewsService: free two-source news radar for a stock.
 *
 *  1. Yahoo search news[]  — GET query1.finance.yahoo.com/v1/finance/search
 *  2. Google News RSS (IN) — GET news.google.com/rss/search (regex-parsed, no new deps)
 *
 * Both are fetched concurrently; one failing is fine, BOTH failing throws
 * (the caller passes null and the analysis proceeds without news).
 *
 * VERIFIED AT BUILD TIME (2026-09-01): Google RSS returns ~100 relevant items
 * per company. Yahoo's news[] currently returns a GENERIC global feed for any
 * query (identical items for RELIANCE.NS and TCS.NS) — so Yahoo items are kept
 * only when the headline actually mentions the company/ticker. Irrelevant
 * headlines must never colour a stock's sentiment.
 *
 * Sentiment is a DETERMINISTIC finance phrase/keyword lexicon — crude by
 * design and said so in the caveat. Research context uses a 14-day half-life;
 * freshness remains a separate field and is required by tactical entry rules.
 */

import axios from "axios";
import { NewsItem, NewsSummary } from "../../types";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes per ticker
const MAX_ITEMS = 12;
const HALF_LIFE_HOURS = 14 * 24;

// ── Deterministic finance lexicon (~20 positive / ~20 negative stems) ────────
// Stems are matched at word start (\bstem) so "surges"/"surged" hit "surge".
const POSITIVE_STEMS = [
  "surge", "rall", "gain", "jump", "soar", "rise", "rose", "increase", "improv",
  "beat", "upgrade", "outperform", "bullish", "growth", "strong", "record high", "buyback", "dividend",
  "bonus issue", "expansion", "wins", "approval", "breakout", "rebound", "upbeat",
];
const NEGATIVE_STEMS = [
  "fall", "fell", "drop", "plunge", "slump", "crash", "decline", "loss",
  "weak", "downgrade", "bearish", "selloff", "sell-off", "probe", "fraud",
  "penalt", "lawsuit", "default", "miss", "warn", "tumble", "slide", "layoff",
  "scam",
];

const POSITIVE_RES = POSITIVE_STEMS.map((s) => new RegExp(`\\b${s}`, "i"));
const NEGATIVE_RES = NEGATIVE_STEMS.map((s) => new RegExp(`\\b${s}`, "i"));

const POSITIVE_FINANCE_PHRASES = [
  /\b(?:net\s+)?profit\b[^.!;]{0,38}\b(?:up|rise[sd]?|rose|jump(?:s|ed)?|surge[sd]?|grow(?:s|th)?|increase[sd]?|beat[sd]?)\b/i,
  /\b(?:revenue|sales|income|margin|ebitda|eps)\b[^.!;]{0,38}\b(?:up|rise[sd]?|rose|jump(?:s|ed)?|surge[sd]?|grow(?:s|th)?|increase[sd]?|beat[sd]?)\b/i,
  /\b(?:shares?|stock)\b[^.!;]{0,24}\b(?:surge[sd]?|rall(?:y|ies|ied)|jump(?:s|ed)?|gain(?:s|ed)?|soar(?:s|ed)?)\b/i,
  /\b(?:wins?|bags?|secures?|receives?)\b[^.!;]{0,32}\b(?:order|contract|approval)\b/i,
];

const NEGATIVE_FINANCE_PHRASES = [
  /\b(?:net\s+)?profit\b[^.!;]{0,38}\b(?:down|fall[\w]*|fell|drop[\w]*|declin[\w]*|miss[\w]*|slump[\w]*)\b/i,
  /\b(?:revenue|sales|income|margin|ebitda|eps)\b[^.!;]{0,38}\b(?:down|fall[\w]*|fell|drop[\w]*|declin[\w]*|miss[\w]*|slump[\w]*)\b/i,
  /\b(?:shares?|stock)\b[^.!;]{0,24}\b(?:fall[\w]*|fell|drop[\w]*|plunge[\w]*|slump[\w]*|crash[\w]*)\b/i,
];

/** Deterministic lexicon sentiment: (pos−neg)/max(1, pos+neg) ∈ [-1, 1]. */
export function lexiconSentiment(title: string): number {
  let pos = 0;
  let neg = 0;
  for (const re of POSITIVE_FINANCE_PHRASES) if (re.test(title)) pos += 2;
  for (const re of NEGATIVE_FINANCE_PHRASES) if (re.test(title)) neg += 2;
  for (const re of POSITIVE_RES) if (re.test(title)) pos++;
  for (const re of NEGATIVE_RES) if (re.test(title)) neg++;
  return (pos - neg) / Math.max(1, pos + neg);
}

/** Material results/orders deserve more research weight than routine mentions. */
export function headlineImpactWeight(title: string): number {
  let weight = 1;
  if (/\b(?:profit|revenue|sales|income|margin|ebitda|eps|results?|earnings?)\b/i.test(title)) {
    weight += 0.75;
  }
  if (/\b(?:order|contract|approval|acquisition|merger|default|fraud|probe|lawsuit)\b/i.test(title)) {
    weight += 0.5;
  }
  const percentages = Array.from(title.matchAll(/(?:^|\s)(\d+(?:\.\d+)?)\s*%/g), (m) => Number(m[1]));
  const magnitude = percentages.length ? Math.max(...percentages.filter(Number.isFinite)) : 0;
  if (magnitude >= 15) weight += 0.25;
  if (magnitude >= 50) weight += 0.25;
  return Math.min(2.5, weight);
}

/**
 * Aggregate only headlines that carry directional evidence. Neutral boilerplate
 * must not dilute several unambiguously positive/negative results stories to
 * zero. A two-item neutral prior shrinks small samples; freshness drives hype
 * separately so old context cannot masquerade as a live catalyst.
 */
export function aggregateHeadlineSentiment(items: NewsItem[]): {
  sentimentScore: number;
  weightedMean: number;
  hypeTemperature: number;
} {
  const directional = items
    .filter((item) => item.sentiment !== 0)
    .map((item) => ({
      item,
      weight: item.decayWeight * headlineImpactWeight(item.title),
    }));
  const weightSum = directional.reduce((sum, row) => sum + row.weight, 0);
  const rawMean = weightSum > 0
    ? directional.reduce((sum, row) => sum + row.item.sentiment * row.weight, 0) / weightSum
    : 0;
  const evidenceShrink = directional.length / (directional.length + 2);
  const weightedMean = rawMean * evidenceShrink;
  const sentimentScore = Math.round(weightedMean * 100 * 10) / 10;

  const fresh = directional.filter((row) => row.item.ageHours <= 24);
  const freshWeight = fresh.reduce((sum, row) => sum + row.weight, 0);
  const freshMean = freshWeight > 0
    ? fresh.reduce((sum, row) => sum + row.item.sentiment * row.weight, 0) / freshWeight
    : 0;
  const fresh24hCount = items.filter((item) => item.ageHours <= 24).length;
  const hypeTemperature =
    Math.round(Math.min(100, 8 * fresh24hCount + 50 * Math.abs(freshMean)) * 10) / 10;

  return { sentimentScore, weightedMean, hypeTemperature };
}

/** Decode the handful of entities Google RSS actually emits. */
function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .trim();
}

/** lowercase, strip punctuation/whitespace — dedupe key across sources. */
function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Generic corporate suffixes that don't identify a company on their own. */
const GENERIC_NAME_TOKENS = new Set([
  "limited", "ltd", "india", "industries", "company", "corporation", "corp",
  "enterprises", "group", "services", "solutions", "products", "the", "of",
  "and", "bank", "finance", "financial", "motors", "steel", "power", "energy",
]);

/** Keywords that mark a headline as actually being about this company. */
function companyKeywords(ticker: string, companyName: string): string[] {
  const kws = new Set<string>();
  const base = ticker.replace(/\.(NS|BO)$/i, "").toLowerCase();
  if (base.length >= 3) kws.add(base);
  const name = companyName.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  kws.add(name.replace(/\s+/g, " ").trim());
  for (const tok of name.split(/\s+/)) {
    if (tok.length >= 4 && !GENERIC_NAME_TOKENS.has(tok)) kws.add(tok);
  }
  return Array.from(kws).filter(Boolean);
}

interface RawHeadline {
  title: string;
  source: string;
  publishedAtMs: number;
  url: string;
}

async function getText(url: string): Promise<string> {
  const res = await axios.get<string>(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
    timeout: REQUEST_TIMEOUT_MS,
    responseType: "text",
    transformResponse: [(d) => d], // keep raw text even if XML/JSON
  });
  return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
}

/** Source 1 — Yahoo search news[], relevance-filtered (see header comment). */
async function fetchYahooNews(
  ticker: string,
  keywords: string[]
): Promise<RawHeadline[]> {
  const url =
    `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}` +
    `&newsCount=12&quotesCount=0`;
  const raw = await getText(url);
  const data = JSON.parse(raw) as { news?: unknown[] };
  const news = Array.isArray(data?.news) ? data.news : [];
  const out: RawHeadline[] = [];
  for (const n of news) {
    const item = n as {
      title?: unknown;
      publisher?: unknown;
      providerPublishTime?: unknown;
      link?: unknown;
    };
    if (typeof item.title !== "string" || typeof item.providerPublishTime !== "number") {
      continue;
    }
    const titleLower = item.title.toLowerCase();
    // Yahoo's feed is currently generic — keep only headlines that actually
    // mention this company (never pollute the tape with unrelated news).
    if (!keywords.some((k) => titleLower.includes(k))) continue;
    out.push({
      title: item.title.trim(),
      source: typeof item.publisher === "string" ? item.publisher : "Yahoo Finance",
      publishedAtMs: item.providerPublishTime * 1000,
      url: typeof item.link === "string" ? item.link : "",
    });
  }
  return out;
}

/** Source 2 — Google News RSS (India), regex-parsed defensively. */
async function fetchGoogleRss(companyName: string): Promise<RawHeadline[]> {
  const q = encodeURIComponent(`"${companyName}" stock`);
  const url = `https://news.google.com/rss/search?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`;
  const xml = await getText(url);
  const out: RawHeadline[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null && out.length < 40) {
    const block = m[1];
    const titleM = /<title>([\s\S]*?)<\/title>/.exec(block);
    const linkM = /<link>([\s\S]*?)<\/link>/.exec(block);
    const pubM = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(block);
    const srcM = /<source[^>]*>([\s\S]*?)<\/source>/.exec(block);
    if (!titleM || !pubM) continue;
    const publishedAtMs = Date.parse(decodeEntities(pubM[1]));
    if (!Number.isFinite(publishedAtMs)) continue;
    let title = decodeEntities(titleM[1]);
    const source = srcM ? decodeEntities(srcM[1]) : "Google News";
    // Google appends " - Publisher" to every title — strip the known suffix.
    if (srcM && title.toLowerCase().endsWith(` - ${source.toLowerCase()}`)) {
      title = title.slice(0, title.length - source.length - 3).trim();
    }
    if (!title) continue;
    out.push({
      title,
      source,
      publishedAtMs,
      url: linkM ? decodeEntities(linkM[1]) : "",
    });
  }
  return out;
}

export class NewsService {
  private cache = new Map<string, { summary: NewsSummary; fetchedAt: number }>();

  /**
   * V8 R1 — peek at the 30-min cache WITHOUT fetching. The RankEngine must
   * never trigger 151 news fetches; stocks without a cached summary get a
   * neutral sentiment z with componentStatus 'no-data'.
   */
  getCachedNews(ticker: string): NewsSummary | null {
    const cached = this.cache.get(ticker.toUpperCase());
    if (!cached || Date.now() - cached.fetchedAt >= CACHE_TTL_MS) return null;
    return cached.summary;
  }

  /**
   * Two-source news summary for a ticker. 30-min in-memory cache. One source
   * failing degrades silently; BOTH failing throws (caller passes null).
   */
  async getNews(ticker: string, companyName: string): Promise<NewsSummary> {
    const key = ticker.toUpperCase();
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.summary;
    }

    const keywords = companyKeywords(ticker, companyName);
    const [yahooR, googleR] = await Promise.allSettled([
      fetchYahooNews(ticker, keywords),
      fetchGoogleRss(companyName),
    ]);
    if (yahooR.status === "rejected" && googleR.status === "rejected") {
      throw new Error(
        `Both news sources failed — Yahoo: ${yahooR.reason?.message ?? yahooR.reason}; ` +
          `Google RSS: ${googleR.reason?.message ?? googleR.reason}`
      );
    }

    const raw: RawHeadline[] = [
      ...(yahooR.status === "fulfilled" ? yahooR.value : []),
      ...(googleR.status === "fulfilled" ? googleR.value : []),
    ];

    // Dedupe across sources: exact normalized title, or same first-50-chars.
    const now = Date.now();
    const seen = new Set<string>();
    const deduped: RawHeadline[] = [];
    for (const h of raw.sort((a, b) => b.publishedAtMs - a.publishedAtMs)) {
      if (h.publishedAtMs > now + 3_600_000) continue; // clock-skewed futures
      const norm = normalizeTitle(h.title);
      if (!norm) continue;
      const prefix = norm.slice(0, 50);
      if (seen.has(norm) || seen.has(prefix)) continue;
      seen.add(norm);
      seen.add(prefix);
      deduped.push(h);
      if (deduped.length >= MAX_ITEMS) break;
    }

    const items: NewsItem[] = deduped.map((h) => {
      const ageHours = Math.max(0, (now - h.publishedAtMs) / 3_600_000);
      return {
        title: h.title,
        source: h.source,
        publishedAt: new Date(h.publishedAtMs).toISOString(),
        url: h.url,
        sentiment: Math.round(lexiconSentiment(h.title) * 100) / 100,
        ageHours: Math.round(ageHours * 10) / 10,
        decayWeight: Math.round(Math.pow(0.5, ageHours / HALF_LIFE_HOURS) * 10_000) / 10_000,
      };
    });

    const { sentimentScore, hypeTemperature } = aggregateHeadlineSentiment(items);
    const fresh24hCount = items.filter((i) => i.ageHours <= 24).length;

    const summary: NewsSummary = {
      items,
      sentimentScore,
      hypeTemperature,
      fresh24hCount,
      assessment: buildAssessment(items.length, fresh24hCount, sentimentScore, hypeTemperature),
      caveat:
        "Sentiment here is a deterministic finance phrase score, weighted by materiality and a 14-day " +
        "research half-life — it can still be " +
        "manipulated by planted stories, misread sarcasm, and misses paywalled context. " +
        "Verify anything important against exchange filings (NSE/BSE announcements) and " +
        "multiple sources before acting on it.",
      asOf: new Date(now).toISOString(),
    };
    this.cache.set(key, { summary, fetchedAt: now });
    return summary;
  }
}

function buildAssessment(
  itemCount: number,
  fresh24hCount: number,
  sentimentScore: number,
  hypeTemperature: number
): string {
  if (itemCount === 0) {
    return "No relevant headlines found from either source — price action, not narrative, is driving this stock.";
  }
  if (fresh24hCount === 0) {
    const archivedTone = sentimentScore >= 15 ? "positive" : sentimentScore <= -15 ? "negative" : "mixed/neutral";
    return `No fresh headlines in 24h across ${itemCount} recent items. The materiality- and decay-weighted research tone is ${archivedTone} (${sentimentScore >= 0 ? "+" : ""}${sentimentScore}), but it is not treated as a fresh trading catalyst.`;
  }
  const tone =
    sentimentScore >= 15 ? "positive" : sentimentScore <= -15 ? "negative" : "mixed/neutral";
  const heat =
    hypeTemperature >= 70
      ? `HOT (hype ${hypeTemperature}/100): the move may already be priced in; the 48h half-life decay model suggests letting it cool ~24–48h`
      : hypeTemperature >= 40
        ? `warming up (hype ${hypeTemperature}/100)`
        : `low-key (hype ${hypeTemperature}/100)`;
  return `${fresh24hCount} headline${fresh24hCount === 1 ? "" : "s"} in 24h, decay-weighted sentiment ${sentimentScore >= 0 ? "+" : ""}${sentimentScore} — ${tone} and ${heat}.`;
}

export const newsService = new NewsService();
export default newsService;
